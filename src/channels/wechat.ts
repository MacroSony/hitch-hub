import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  ApiClient,
  MessageType,
  UploadMediaType,
  WeChatClient,
  aesEcbPaddedSize,
  encryptAesEcb,
  normalizeAccountId,
  type MessageItem,
  type SendMessageReq,
  type WeixinMessage,
} from "wechat-ilink-client";
import type { ChatTarget, HubAttachment } from "../core/types.js";
import type { MediaCache, StoreAttachmentInput } from "../core/media-cache.js";
import type { ChannelAdapter, ChannelHealth, InboundChatEvent, OutboundArtifact, SendOptions } from "./types.js";

type WeChatAdapterOptions = {
  dataDir: string;
  mediaCache: MediaCache;
  allowedChatIds: string[];
  unsafeAllowAll: boolean;
  botType: string;
  maxInboundBytes: number;
  sendTimeoutMs: number;
};

type SavedCredentials = {
  accountId: string;
  token: string;
  baseUrl?: string;
};

const WECHAT_SEND_MIN_INTERVAL_MS = 2_000;
const WECHAT_RET_MINUS_TWO_RETRY_DELAYS_MS = [5_000, 12_000, 25_000] as const;

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

export class WeChatAdapter implements ChannelAdapter {
  private readonly stateDir: string;
  private readonly credentialsPath: string;
  private readonly syncBufPath: string;
  private readonly contextTokensPath: string;
  private readonly queue = new AsyncEventQueue<InboundChatEvent>();
  private readonly contextTokens = new Map<string, string>();
  private sendQueue: Promise<void> = Promise.resolve();
  private lastSendAttemptAt = 0;
  private client: WeChatClient | undefined;
  private channelHealth: ChannelHealth = { state: "starting" };

  constructor(private readonly options: WeChatAdapterOptions) {
    this.stateDir = path.join(options.dataDir, "wechat");
    this.credentialsPath = path.join(this.stateDir, "credentials.json");
    this.syncBufPath = path.join(this.stateDir, "sync-buf.json");
    this.contextTokensPath = path.join(this.stateDir, "context-tokens.json");
    mkdirSync(this.stateDir, { recursive: true });
    this.loadContextTokens();
  }

  async *receive(): AsyncIterable<InboundChatEvent> {
    const client = await this.ensureClient();
    client.on("message", (message) => {
      void this.enqueueMessage(message).catch((error: unknown) => {
        process.stderr.write(`[hitch] WeChat message handling failed: ${formatError(error)}\n`);
      });
    });
    client.on("error", (error) => {
      this.channelHealth = {
        state: "degraded",
        lastErrorAt: new Date().toISOString(),
        lastError: formatError(error),
      };
      process.stderr.write(`[hitch] WeChat polling failed: ${formatError(error)}\n`);
    });
    client.on("sessionExpired", () => {
      this.channelHealth = {
        state: "stopped",
        lastErrorAt: new Date().toISOString(),
        lastError: "WeChat session expired",
      };
      process.stderr.write("[hitch] WeChat session expired; remove saved credentials and restart to scan a fresh QR code.\n");
    });

    void client
      .start({
        loadSyncBuf: () => this.loadSyncBuf(),
        saveSyncBuf: (buf) => this.saveSyncBuf(buf),
      })
      .catch((error: unknown) => {
        this.channelHealth = {
          state: "stopped",
          lastErrorAt: new Date().toISOString(),
          lastError: formatError(error),
        };
        process.stderr.write(`[hitch] WeChat receive loop stopped: ${formatError(error)}\n`);
      })
      .finally(() => {
        this.queue.close();
      });

    yield* this.queue.iterate();
  }

  async sendText(target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    if (text.length === 0) {
      return;
    }
    const client = await this.ensureClient();
    this.instrumentSendMessage(client.api);
    const to = target.userId ?? target.chatId;
    const contextToken = this.contextTokens.get(to) ?? this.contextTokens.get(target.chatId);
    await client.sendText(to, text, contextToken);
  }

  async sendArtifact(target: ChatTarget, artifact: OutboundArtifact, opts?: SendOptions): Promise<void> {
    const client = await this.ensureClient();
    const api = client.api;
    this.instrumentSendMessage(api);
    const to = target.userId ?? target.chatId;
    const contextToken = this.contextTokens.get(to) ?? this.contextTokens.get(target.chatId);
    const isImage = artifact.kind === "image";
    // wechat-ilink-client v0.1.0's sendMedia()/uploadMedia() only handles the
    // legacy getUploadUrl response field `upload_param`, but current iLink
    // servers return `upload_full_url` instead, so the library throws before
    // uploading. Upload ourselves (supporting both response shapes), then
    // hand the uploaded media to the library's send methods, which reuse its
    // tested AES + message-envelope code.
    const uploaded = await uploadMediaFullUrl({
      filePath: artifact.path,
      toUserId: to,
      api,
      cdnBaseUrl: api.cdnBaseUrl,
      mediaType: isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    opts?.signal?.throwIfAborted();
    if (isImage) {
      await client.sendUploadedImage(to, uploaded, artifact.caption, contextToken);
    } else {
      await client.sendUploadedFile(to, path.basename(artifact.path), uploaded, artifact.caption, contextToken);
    }
  }

  // wechat-ilink-client v0.1.0's sendMessage() discards the response body
  // and only throws on HTTP non-200, so a server-side rejection (ret != 0) is
  // silently swallowed and recorded as "sent". Wrap the instance method once
  // to parse and enforce the actual ret/errmsg response.
  private instrumentSendMessage(api: ApiClient): void {
    const anyApi = api as ApiClient & { __hitchInstrumented?: boolean };
    if (anyApi.__hitchInstrumented) {
      return;
    }
    anyApi.__hitchInstrumented = true;
    // apiFetch and buildBaseInfo are private on ApiClient; reach them through a
    // typed cast so we can read the raw sendmessage response the library
    // otherwise throws away.
    const privy = api as unknown as {
      apiFetch: (p: { endpoint: string; body: string; timeoutMs: number }) => Promise<string>;
      buildBaseInfo: () => unknown;
    };
    const orig = api.sendMessage.bind(api);
    api.sendMessage = async (req: Parameters<typeof orig>[0]): Promise<void> => {
      const deadlineAt = Date.now() + this.options.sendTimeoutMs;
      await this.enqueueSend(async () => {
        let currentReq = req;
        let triedTokenlessFallback = false;
        let retryIndex = 0;
        for (;;) {
          try {
            await this.sendMessageOnce(privy, currentReq, deadlineAt);
            return;
          } catch (error) {
            if (isRetMinusTwo(error) && !triedTokenlessFallback && hasContextToken(currentReq)) {
              triedTokenlessFallback = true;
              currentReq = withEmptyContextToken(currentReq);
              process.stderr.write("[hitch] WeChat sendMessage returned ret=-2; retrying once with empty context_token.\n");
              continue;
            }

            const delayMs = WECHAT_RET_MINUS_TWO_RETRY_DELAYS_MS[retryIndex];
            if (!isRetMinusTwo(error) || delayMs === undefined) {
              throw error;
            }
            retryIndex += 1;
            process.stderr.write(
              `[hitch] WeChat sendMessage returned ret=-2; retrying in ${delayMs}ms (${retryIndex + 1}/${WECHAT_RET_MINUS_TWO_RETRY_DELAYS_MS.length + 1}).\n`,
            );
            await sleepBeforeDeadline(delayMs, deadlineAt, this.options.sendTimeoutMs);
          }
        }
      });
    };
  }

  private async sendMessageOnce(
    privy: {
      apiFetch: (p: { endpoint: string; body: string; timeoutMs: number }) => Promise<string>;
      buildBaseInfo: () => unknown;
    },
    req: SendMessageReq,
    deadlineAt: number,
  ): Promise<void> {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`WeChat sendMessage timed out after ${this.options.sendTimeoutMs}ms`);
    }
    await this.waitForSendSlot();
    if (deadlineAt <= Date.now()) {
      throw new Error(`WeChat sendMessage timed out after ${this.options.sendTimeoutMs}ms`);
    }
    const raw = await privy.apiFetch({
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({ ...req, base_info: privy.buildBaseInfo() }),
      timeoutMs: Math.min(30_000, Math.max(1, deadlineAt - Date.now())),
    });
    assertWeChatApiOk(parseWeChatApiResponse(raw), "WeChat sendMessage");
  }

  private async enqueueSend(send: () => Promise<void>): Promise<void> {
    const run = this.sendQueue.then(send, send);
    this.sendQueue = run.catch(() => undefined);
    await run;
  }

  health(): ChannelHealth {
    return { ...this.channelHealth };
  }

  private async waitForSendSlot(): Promise<void> {
    const now = Date.now();
    const waitMs = this.lastSendAttemptAt + WECHAT_SEND_MIN_INTERVAL_MS - now;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastSendAttemptAt = Date.now();
  }

  private async ensureClient(): Promise<WeChatClient> {
    if (this.client) {
      return this.client;
    }

    const saved = this.loadCredentials();
    if (saved) {
      this.client = new WeChatClient({
        accountId: saved.accountId,
        token: saved.token,
        ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
      });
      return this.client;
    }

    const client = new WeChatClient();
    const result = await client.login({
      botType: this.options.botType,
      onQRCode: (url) => {
        process.stderr.write(`[hitch] Scan this WeChat QR code URL to connect Hitch:\n${url}\n`);
      },
      onStatus: (status) => {
        process.stderr.write(`[hitch] WeChat QR login status: ${status}\n`);
      },
    });
    if (!result.connected || !result.botToken || !result.accountId) {
      throw new Error(`WeChat login failed: ${result.message}`);
    }

    this.saveCredentials({
      accountId: normalizeAccountId(result.accountId),
      token: result.botToken,
      ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
    });
    this.client = client;
    return client;
  }

  private async enqueueMessage(message: WeixinMessage): Promise<void> {
    if (message.message_type !== MessageType.USER) {
      return;
    }

    const chatId = chatIdForMessage(message);
    if (!chatId) {
      return;
    }
    if (!this.options.unsafeAllowAll && (this.options.allowedChatIds.length === 0 || !this.options.allowedChatIds.includes(chatId))) {
      return;
    }

    if (message.context_token) {
      if (message.from_user_id) {
        this.contextTokens.set(message.from_user_id, message.context_token);
      }
      this.contextTokens.set(chatId, message.context_token);
      this.saveContextTokens();
    }

    const attachments = await this.downloadAttachments(message.item_list ?? []);
    const text = WeChatClient.extractText(message);
    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    this.queue.push({
      id: String(message.message_id ?? message.seq ?? Date.now()),
      target: {
        platform: "wechat",
        chatId,
        ...(message.group_id ? { threadId: message.group_id } : {}),
        ...(message.from_user_id ? { userId: message.from_user_id } : {}),
      },
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAt: new Date().toISOString(),
    });
  }

  private async downloadAttachments(items: MessageItem[]): Promise<HubAttachment[]> {
    const client = await this.ensureClient();
    const attachments: HubAttachment[] = [];

    for (const item of items) {
      if (!WeChatClient.isMediaItem(item)) {
        continue;
      }
      const downloaded = await client.downloadMedia(item);
      if (!downloaded) {
        continue;
      }
      assertWithinSizeLimit(downloaded.data.byteLength, this.options.maxInboundBytes, downloaded.kind);
      const input: StoreAttachmentInput = {
        source: "wechat",
        kind: hubKindForWeChatKind(downloaded.kind),
        data: downloaded.data,
      };
      if (downloaded.fileName) {
        input.filename = downloaded.fileName;
      }
      attachments.push(this.options.mediaCache.storeInbound(input));
    }

    return attachments;
  }

  private loadCredentials(): SavedCredentials | undefined {
    if (!existsSync(this.credentialsPath)) {
      return undefined;
    }
    return JSON.parse(readFileSync(this.credentialsPath, "utf8")) as SavedCredentials;
  }

  private saveCredentials(credentials: SavedCredentials): void {
    writeSecureJson(this.credentialsPath, credentials);
  }

  private loadSyncBuf(): string | undefined {
    if (!existsSync(this.syncBufPath)) {
      return undefined;
    }
    return (JSON.parse(readFileSync(this.syncBufPath, "utf8")) as { buf?: string }).buf;
  }

  private saveSyncBuf(buf: string): void {
    writeSecureJson(this.syncBufPath, { buf });
    this.channelHealth = { state: "healthy", lastSuccessAt: new Date().toISOString() };
  }

  private loadContextTokens(): void {
    if (!existsSync(this.contextTokensPath)) {
      return;
    }
    const parsed = JSON.parse(readFileSync(this.contextTokensPath, "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      this.contextTokens.set(key, value);
    }
  }

  private saveContextTokens(): void {
    writeSecureJson(this.contextTokensPath, Object.fromEntries(this.contextTokens));
  }
}

function writeSecureJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms/filesystems that support chmod.
  }
}

function chatIdForMessage(message: WeixinMessage): string | undefined {
  // For 1:1 ClawBot chats the server returns group_id as an empty string (not
  // undefined), so a nullish-coalescing fallback would return "" and drop the
  // message. Fall back to from_user_id on any falsy value.
  return message.group_id || message.from_user_id;
}

function hubKindForWeChatKind(kind: "image" | "voice" | "file" | "video"): HubAttachment["kind"] {
  if (kind === "voice") {
    return "audio";
  }
  return kind;
}

type UploadedMedia = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

type WeChatApiResponse = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
};

class WeChatApiError extends Error {
  readonly ret: number;
  readonly errcode: number;
  readonly errmsg: string;

  constructor(
    readonly operation: string,
    response: WeChatApiResponse,
  ) {
    const ret = response.ret ?? 0;
    const errcode = response.errcode ?? 0;
    const errmsg = response.errmsg ?? "";
    super(`${operation} failed: ret=${ret} errcode=${errcode} errmsg=${errmsg}`.trim());
    this.name = "WeChatApiError";
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}

// wechat-ilink-client v0.1.0's uploadMedia() only handles the legacy
// getUploadUrl response field `upload_param`; current iLink servers return
// `upload_full_url` instead, so the library throws before uploading. This
// helper reimplements just the upload step, supporting both response shapes,
// and returns an UploadedFileInfo-compatible object for the library's send
// methods (sendUploadedImage / sendUploadedFile).
async function uploadMediaFullUrl(opts: {
  filePath: string;
  toUserId: string;
  api: ApiClient;
  cdnBaseUrl: string;
  mediaType: number;
  signal?: AbortSignal;
}): Promise<UploadedMedia> {
  const { filePath, toUserId, api, cdnBaseUrl, mediaType, signal } = opts;
  signal?.throwIfAborted();
  const plaintext = await readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
  const fileSizeCiphertext = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  const resp = await api.getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize: fileSizeCiphertext,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });
  signal?.throwIfAborted();
  assertWeChatApiOk(resp as WeChatApiResponse, "WeChat getUploadUrl");

  // `upload_full_url` is returned by current servers but is not on the
  // library's GetUploadUrlResp type yet, so read it off the parsed object.
  const fullUrl = (resp as { upload_full_url?: string }).upload_full_url;
  let uploadUrl: string;
  if (fullUrl) {
    // Newer iLink protocol: the server returns the complete CDN upload URL.
    uploadUrl = fullUrl;
  } else if (resp.upload_param) {
    // Legacy protocol: assemble the URL (matches the library's buildCdnUploadUrl).
    uploadUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(resp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error(`getUploadUrl returned no upload_param/upload_full_url: ${JSON.stringify(resp)}`);
  }

  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const downloadEncryptedQueryParam = await postCiphertextToCdn(uploadUrl, ciphertext, signal);
  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext,
  };
}

async function postCiphertextToCdn(uploadUrl: string, ciphertext: Buffer, signal?: AbortSignal): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        ...(signal ? { signal } : {}),
      });
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${msg}`);
      }
      if (res.status !== 200) {
        const msg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${msg}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      return downloadParam;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // 4xx is a permanent client error; don't retry.
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < 3) {
        signal?.throwIfAborted();
        await sleep(750 * attempt);
      }
    }
  }
  throw lastError ?? new Error("CDN upload failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepBeforeDeadline(delayMs: number, deadlineAt: number, timeoutMs: number): Promise<void> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= delayMs) {
    throw new Error(`WeChat sendMessage timed out after ${timeoutMs}ms`);
  }
  await sleep(delayMs);
}

function parseWeChatApiResponse(raw: string): WeChatApiResponse {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return {
      ...(typeof parsed.ret === "number" ? { ret: parsed.ret } : {}),
      ...(typeof parsed.errcode === "number" ? { errcode: parsed.errcode } : {}),
      ...(typeof parsed.errmsg === "string" ? { errmsg: parsed.errmsg } : {}),
    };
  } catch {
    throw new Error(`WeChat API returned non-JSON response: ${raw.slice(0, 200)}`);
  }
}

function assertWeChatApiOk(resp: WeChatApiResponse, operation: string): void {
  const ret = resp.ret ?? 0;
  const errcode = resp.errcode ?? 0;
  if (ret === 0 && errcode === 0) {
    return;
  }

  throw new WeChatApiError(operation, resp);
}

function isRetMinusTwo(error: unknown): error is WeChatApiError {
  return error instanceof WeChatApiError && error.ret === -2;
}

function hasContextToken(req: SendMessageReq): boolean {
  return typeof req.msg?.context_token === "string" && req.msg.context_token.length > 0;
}

function withEmptyContextToken(req: SendMessageReq): SendMessageReq {
  return {
    ...req,
    ...(req.msg ? { msg: { ...req.msg, context_token: "" } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function assertWithinSizeLimit(size: number | undefined, maxBytes: number, label: string): void {
  if (size !== undefined && size > maxBytes) {
    throw new Error(`${label} is too large (${size} bytes > ${maxBytes} byte limit)`);
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

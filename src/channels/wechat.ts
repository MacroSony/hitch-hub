import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MessageType,
  WeChatClient,
  normalizeAccountId,
  type MessageItem,
  type WeixinMessage,
} from "wechat-ilink-client";
import type { ChatTarget, HubAttachment } from "../core/types.js";
import type { MediaCache, StoreAttachmentInput } from "../core/media-cache.js";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "./types.js";

type WeChatAdapterOptions = {
  dataDir: string;
  mediaCache: MediaCache;
  allowedChatIds: string[];
  unsafeAllowAll: boolean;
  botType: string;
  maxInboundBytes: number;
};

type SavedCredentials = {
  accountId: string;
  token: string;
  baseUrl?: string;
};

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
  private client: WeChatClient | undefined;

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
      process.stderr.write(`[hitch] WeChat polling failed: ${formatError(error)}\n`);
    });
    client.on("sessionExpired", () => {
      process.stderr.write("[hitch] WeChat session expired; remove saved credentials and restart to scan a fresh QR code.\n");
    });

    void client
      .start({
        loadSyncBuf: () => this.loadSyncBuf(),
        saveSyncBuf: (buf) => this.saveSyncBuf(buf),
      })
      .catch((error: unknown) => {
        process.stderr.write(`[hitch] WeChat receive loop stopped: ${formatError(error)}\n`);
      })
      .finally(() => {
        this.queue.close();
      });

    yield* this.queue.iterate();
  }

  async sendText(target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    const client = await this.ensureClient();
    const to = target.userId ?? target.chatId;
    const contextToken = this.contextTokens.get(to) ?? this.contextTokens.get(target.chatId);
    await client.sendText(to, text, contextToken);
  }

  async sendArtifact(target: ChatTarget, artifact: OutboundArtifact): Promise<void> {
    const client = await this.ensureClient();
    const to = target.userId ?? target.chatId;
    const contextToken = this.contextTokens.get(to) ?? this.contextTokens.get(target.chatId);
    await client.sendMedia(to, artifact.path, artifact.caption, contextToken);
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
  return message.group_id ?? message.from_user_id;
}

function hubKindForWeChatKind(kind: "image" | "voice" | "file" | "video"): HubAttachment["kind"] {
  if (kind === "voice") {
    return "audio";
  }
  return kind;
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

import type { ChatTarget, HubAttachment } from "../core/types.js";
import type { MediaCache, StoreAttachmentInput } from "../core/media-cache.js";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "./types.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    chat: { id: number | string };
    from?: { id: number | string };
    message_thread_id?: number;
    photo?: Array<{
      file_id: string;
      file_unique_id?: string;
      file_size?: number;
      width: number;
      height: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id?: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
  };
};

type TelegramGetFileResponse = {
  ok: boolean;
  result?: {
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    file_path?: string;
  };
  description?: string;
};

export class TelegramAdapter implements ChannelAdapter {
  private updateOffset = 0;

  constructor(
    private readonly botToken: string,
    private readonly allowedChatIds: string[] = [],
    private readonly mediaCache?: MediaCache,
  ) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    let retryDelayMs = 1_000;

    while (true) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.getUpdates();
        retryDelayMs = 1_000;
      } catch (error) {
        if (error instanceof TelegramFatalError) {
          throw error;
        }
        process.stderr.write(
          `[hitch] Telegram receive failed: ${formatError(error)}. Retrying in ${retryDelayMs}ms.\n`,
        );
        await sleep(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        continue;
      }

      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        const message = update.message;
        if (!message) {
          continue;
        }

        const chatId = String(message.chat.id);
        if (this.allowedChatIds.length > 0 && !this.allowedChatIds.includes(chatId)) {
          continue;
        }

        const target: ChatTarget = {
          platform: "telegram",
          chatId,
          ...(message.message_thread_id !== undefined ? { threadId: String(message.message_thread_id) } : {}),
          ...(message.from?.id !== undefined ? { userId: String(message.from.id) } : {}),
        };

        let attachments: HubAttachment[] = [];
        try {
          attachments = await this.downloadAttachments(message);
        } catch (error) {
          process.stderr.write(
            `[hitch] Telegram attachment download failed for message ${message.message_id}: ${formatError(error)}\n`,
          );
          await this.sendText(
            target,
            `Attachment download failed: ${error instanceof Error ? error.message : String(error)}`,
          ).catch((sendError: unknown) => {
            process.stderr.write(`[hitch] Telegram send failed after attachment error: ${formatError(sendError)}\n`);
          });
        }
        const text = message.text ?? message.caption ?? "";
        if (text.length === 0 && attachments.length === 0) {
          continue;
        }

        yield {
          id: String(message.message_id),
          target,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          receivedAt: new Date().toISOString(),
        };
      }
    }
  }

  async sendText(target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target.chatId,
          text,
        }),
      },
      { attempts: 3, baseDelayMs: 750 },
    );

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = new URL(`https://api.telegram.org/bot${this.botToken}/getUpdates`);
    url.searchParams.set("timeout", "30");
    url.searchParams.set("offset", String(this.updateOffset));
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const response = await fetchWithRetry(url, undefined, { attempts: 2, baseDelayMs: 1_000 });
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new TelegramFatalError(`Telegram getUpdates failed: ${response.status} ${text}`);
      }
      throw new Error(`Telegram getUpdates failed: ${response.status} ${text}`);
    }

    const body = (await response.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!body.ok) {
      throw new Error(`Telegram getUpdates failed: ${body.description ?? "unknown error"}`);
    }

    return body.result ?? [];
  }

  private async downloadAttachments(message: NonNullable<TelegramUpdate["message"]>): Promise<HubAttachment[]> {
    if (!this.mediaCache) {
      return [];
    }

    const attachments: HubAttachment[] = [];

    if (message.photo && message.photo.length > 0) {
      const largestPhoto = [...message.photo].sort((left, right) => {
        const leftPixels = left.width * left.height;
        const rightPixels = right.width * right.height;
        return rightPixels - leftPixels;
      })[0];
      if (!largestPhoto) {
        return attachments;
      }
      const downloaded = await this.downloadFile(largestPhoto.file_id);
      const input: StoreAttachmentInput = {
        source: "telegram",
        kind: "image",
        data: downloaded.data,
        originalId: largestPhoto.file_unique_id ?? largestPhoto.file_id,
      };
      const filename = filenameFromTelegramPath(downloaded.filePath);
      const mimeType = guessMimeType(downloaded.filePath);
      if (filename) {
        input.filename = filename;
      }
      if (mimeType) {
        input.mimeType = mimeType;
      }
      attachments.push(this.mediaCache.storeInbound(input));
    }

    if (message.document) {
      const downloaded = await this.downloadFile(message.document.file_id);
      const input: StoreAttachmentInput = {
        source: "telegram",
        kind: documentKind(message.document.mime_type),
        data: downloaded.data,
        originalId: message.document.file_unique_id ?? message.document.file_id,
      };
      const filename = message.document.file_name ?? filenameFromTelegramPath(downloaded.filePath);
      const mimeType = message.document.mime_type ?? guessMimeType(downloaded.filePath);
      if (filename) {
        input.filename = filename;
      }
      if (mimeType) {
        input.mimeType = mimeType;
      }
      attachments.push(this.mediaCache.storeInbound(input));
    }

    return attachments;
  }

  private async downloadFile(fileId: string): Promise<{ filePath: string; data: Buffer }> {
    const getFileUrl = new URL(`https://api.telegram.org/bot${this.botToken}/getFile`);
    getFileUrl.searchParams.set("file_id", fileId);

    const fileResponse = await fetchWithRetry(getFileUrl, undefined, { attempts: 3, baseDelayMs: 750 });
    if (!fileResponse.ok) {
      throw new Error(`Telegram getFile failed: ${fileResponse.status} ${await fileResponse.text()}`);
    }

    const body = (await fileResponse.json()) as TelegramGetFileResponse;
    if (!body.ok || !body.result?.file_path) {
      throw new Error(`Telegram getFile failed: ${body.description ?? "missing file_path"}`);
    }

    const downloadResponse = await fetchWithRetry(`https://api.telegram.org/file/bot${this.botToken}/${body.result.file_path}`, undefined, {
      attempts: 3,
      baseDelayMs: 750,
    });
    if (!downloadResponse.ok) {
      throw new Error(`Telegram file download failed: ${downloadResponse.status} ${await downloadResponse.text()}`);
    }

    return {
      filePath: body.result.file_path,
      data: Buffer.from(await downloadResponse.arrayBuffer()),
    };
  }
}

class TelegramFatalError extends Error {}

async function fetchWithRetry(
  input: string | URL,
  init: RequestInit | undefined,
  options: { attempts: number; baseDelayMs: number },
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!isRetryableStatus(response.status) || attempt === options.attempts) {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts) {
        throw error;
      }
    }

    await sleep(options.baseDelayMs * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

function filenameFromTelegramPath(filePath: string): string | undefined {
  const filename = pathBasename(filePath);
  return filename.length > 0 ? filename : undefined;
}

function pathBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function documentKind(mimeType: string | undefined): "image" | "file" {
  return mimeType?.startsWith("image/") ? "image" : "file";
}

function guessMimeType(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain";
  }
  return undefined;
}

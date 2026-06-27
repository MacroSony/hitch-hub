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
    while (true) {
      const updates = await this.getUpdates();

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

        const attachments = await this.downloadAttachments(message);
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
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = new URL(`https://api.telegram.org/bot${this.botToken}/getUpdates`);
    url.searchParams.set("timeout", "30");
    url.searchParams.set("offset", String(this.updateOffset));
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${response.status} ${await response.text()}`);
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

    const fileResponse = await fetch(getFileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Telegram getFile failed: ${fileResponse.status} ${await fileResponse.text()}`);
    }

    const body = (await fileResponse.json()) as TelegramGetFileResponse;
    if (!body.ok || !body.result?.file_path) {
      throw new Error(`Telegram getFile failed: ${body.description ?? "missing file_path"}`);
    }

    const downloadResponse = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${body.result.file_path}`);
    if (!downloadResponse.ok) {
      throw new Error(`Telegram file download failed: ${downloadResponse.status} ${await downloadResponse.text()}`);
    }

    return {
      filePath: body.result.file_path,
      data: Buffer.from(await downloadResponse.arrayBuffer()),
    };
  }
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

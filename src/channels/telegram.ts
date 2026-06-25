import type { ChatTarget } from "../core/types.js";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "./types.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string };
    from?: { id: number | string };
    message_thread_id?: number;
  };
};

export class TelegramAdapter implements ChannelAdapter {
  private updateOffset = 0;

  constructor(
    private readonly botToken: string,
    private readonly allowedChatIds: string[] = [],
  ) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    while (true) {
      const updates = await this.getUpdates();

      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        const message = update.message;
        if (!message?.text) {
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

        yield {
          id: String(message.message_id),
          target,
          text: message.text,
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
}

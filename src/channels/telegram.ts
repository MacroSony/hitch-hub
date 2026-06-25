import type { ChatTarget } from "../core/types.js";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "./types.js";

export class TelegramAdapter implements ChannelAdapter {
  constructor(private readonly botToken: string) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    throw new Error("Telegram adapter receive loop is not implemented yet.");
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
}

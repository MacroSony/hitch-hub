import type { ChatTarget } from "../core/types.js";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "./types.js";

export class FakeChannelAdapter implements ChannelAdapter {
  private readonly events: InboundChatEvent[];

  constructor(messages: string[]) {
    const target: ChatTarget = {
      platform: "fake",
      chatId: "local",
      userId: "local-user",
    };

    this.events = messages.map((message) => ({
        id: crypto.randomUUID(),
        target,
        text: message,
        receivedAt: new Date().toISOString(),
      }));
  }

  async *receive(): AsyncIterable<InboundChatEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async sendText(target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    const label = `${target.platform}:${target.chatId}`;
    process.stdout.write(`[${label}] ${text}\n`);
  }
}

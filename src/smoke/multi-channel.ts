import type { ChatTarget, Platform } from "../core/types.js";
import { MultiChannelAdapter } from "../channels/multi.js";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";

class MemoryChannel implements ChannelAdapter {
  readonly texts: Array<{ target: ChatTarget; text: string }> = [];
  readonly artifacts: Array<{ target: ChatTarget; artifact: OutboundArtifact }> = [];

  constructor(private readonly events: InboundChatEvent[]) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async sendText(target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    this.texts.push({ target, text });
  }

  async sendArtifact(target: ChatTarget, artifact: OutboundArtifact, _opts?: SendOptions): Promise<void> {
    this.artifacts.push({ target, artifact });
  }
}

async function main(): Promise<void> {
  const telegramTarget = target("telegram", "tg-chat", "tg-user");
  const wechatTarget = target("wechat", "wx-chat", "wx-user");
  const telegram = new MemoryChannel([event("tg-1", telegramTarget, "!status")]);
  const wechat = new MemoryChannel([event("wx-1", wechatTarget, "!status")]);
  const multi = new MultiChannelAdapter([
    { platform: "telegram", adapter: telegram },
    { platform: "wechat", adapter: wechat },
  ]);

  const received: InboundChatEvent[] = [];
  for await (const inbound of multi.receive()) {
    received.push(inbound);
  }

  const receivedPlatforms = received.map((inbound) => inbound.target.platform).sort().join(",");
  if (receivedPlatforms !== "telegram,wechat") {
    throw new Error(`Expected events from both channels, got ${receivedPlatforms}`);
  }

  await multi.sendText(telegramTarget, "telegram reply");
  await multi.sendText(wechatTarget, "wechat reply");
  await multi.sendArtifact(wechatTarget, { path: "/tmp/example.txt", kind: "file" });

  if (telegram.texts.length !== 1 || telegram.texts[0]?.text !== "telegram reply" || wechat.texts.length !== 1) {
    throw new Error("Text delivery was not routed to the correct channels.");
  }
  if (wechat.artifacts.length !== 1 || telegram.artifacts.length !== 0) {
    throw new Error("Artifact delivery was not routed to the correct channel.");
  }

  process.stdout.write("Multi-channel smoke ok\n");
}

function target(platform: Platform, chatId: string, userId: string): ChatTarget {
  return { platform, chatId, userId };
}

function event(id: string, chatTarget: ChatTarget, text: string): InboundChatEvent {
  return {
    id,
    target: chatTarget,
    text,
    receivedAt: new Date().toISOString(),
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

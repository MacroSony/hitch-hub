import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { AgentBackend, AgentEvent, AgentInput } from "../agents/types.js";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { ChatTarget, HubAttachment, HubSession } from "../core/types.js";
import { MediaCache } from "../core/media-cache.js";
import { RemoteAgentHub } from "../core/hub.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

class MediaFlowChannel implements ChannelAdapter {
  readonly artifacts: OutboundArtifact[] = [];
  readonly texts: string[] = [];

  constructor(private readonly events: InboundChatEvent[]) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    this.texts.push(text);
  }

  async sendArtifact(_target: ChatTarget, artifact: OutboundArtifact, _opts?: SendOptions): Promise<void> {
    this.artifacts.push(artifact);
  }
}

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

class MediaFlowBackend implements AgentBackend {
  readonly queue = new AsyncEventQueue<AgentEvent>();
  receivedInput: AgentInput | undefined;

  constructor(private readonly artifactPath: string) {}

  async start(_session: HubSession): Promise<number | undefined> {
    return process.pid;
  }

  async send(input: AgentInput): Promise<void> {
    this.receivedInput = input;
    this.queue.push({ type: "tool_call", name: "read_file", preview: `{"path":"${this.artifactPath}"}` });
    this.queue.push({
      type: "tool_result",
      name: "read_file",
      succeeded: true,
      text: `hidden tool output marker: ${this.artifactPath}`,
    });
    this.queue.push({ type: "final", text: `Generated artifact: "${this.artifactPath}"` });
    this.queue.close();
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield* this.queue.iterate();
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {
    this.queue.close();
  }
}

async function main(): Promise<void> {
  const summary = await runScenario(false);
  await runScenario(true);
  process.stdout.write(`Media flow smoke ok: inbound=${summary.inbound} outbound=${summary.outbound}\n`);
}

async function runScenario(fullToolOutput: boolean): Promise<{ inbound: number; outbound: number }> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", fullToolOutput ? "full" : "summary");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const mediaCache = new MediaCache(dataDir);
  const image = mediaCache.storeInbound({
    source: "fake",
    kind: "image",
    data: PNG_1X1,
    filename: "pixel.png",
  });
  const file = mediaCache.storeInbound({
    source: "fake",
    kind: "file",
    data: Buffer.from("hello media", "utf8"),
    filename: "note.txt",
  });

  const artifactPath = path.join(dataDir, "outbound.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow",
    userId: "media-user",
  };
  const events: InboundChatEvent[] = [
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Inspect these attachments.",
      attachments: [image, file],
      receivedAt: new Date().toISOString(),
    },
  ];

  const config = mediaFlowConfig(dataDir, fullToolOutput);
  const channel = new MediaFlowChannel(events);
  const backend = new MediaFlowBackend(artifactPath);
  const hub = new RemoteAgentHub(config, channel, () => backend);
  await hub.run();

  assertAttachmentFlow(backend.receivedInput?.attachments);
  if (channel.artifacts.length !== 1 || channel.artifacts[0]?.path !== artifactPath) {
    throw new Error(`Expected outbound artifact delivery for ${artifactPath}`);
  }
  const toolStarted = channel.texts.find((text) => text.startsWith("Tool started: read_file"));
  if (!toolStarted) {
    throw new Error("Expected summarized tool start message");
  }
  if (!fullToolOutput && toolStarted !== "Tool started: read_file") {
    throw new Error("Default delivery should hide tool preview args");
  }
  if (!channel.texts.some((text) => text.startsWith("Tool finished: read_file (succeeded)"))) {
    throw new Error("Expected summarized tool result message");
  }
  const hasFullToolOutput = channel.texts.some((text) => text.includes("hidden tool output marker"));
  const hasToolPreview = channel.texts.some((text) => text.includes('{"path"'));
  if (!fullToolOutput && (hasFullToolOutput || hasToolPreview)) {
    throw new Error("Default delivery should hide tool preview args and full tool output");
  }
  if (fullToolOutput && (!hasFullToolOutput || !hasToolPreview)) {
    throw new Error("Full tool-output delivery should include preview args and result text");
  }

  return { inbound: backend.receivedInput.attachments.length, outbound: channel.artifacts.length };
}

function mediaFlowConfig(dataDir: string, fullToolOutput: boolean): HubConfig {
  const cwd = path.resolve(".");
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
    agent_turn_timeout_ms: 20_000,
    approval_timeout_ms: 20_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
    },
    delivery: {
      full_tool_output: fullToolOutput,
    },
    allowedRoots: [cwd, dataDir],
    users: {
      media: {
        telegram_ids: [],
        wechat_ids: [],
        allowed_roots: [cwd, dataDir],
      },
    },
    channels: {
      fake: { enabled: true },
      telegram: {
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
        unsafe_allow_all: false,
      },
      wechat: {
        enabled: false,
        allowed_chat_ids: [],
        bot_type: "3",
        unsafe_allow_all: false,
      },
    },
    agents: {
      pi: {
        command: "pi",
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
        config_scope: "hitch",
      },
    },
  };
}

function assertAttachmentFlow(attachments: HubAttachment[] | undefined): asserts attachments is HubAttachment[] {
  if (!attachments || attachments.length !== 2) {
    throw new Error(`Expected two inbound attachments, got ${attachments?.length ?? 0}`);
  }
  if (attachments[0]?.kind !== "image" || attachments[0].mimeType !== "image/png") {
    throw new Error("Expected first attachment to be a sniffed PNG image");
  }
  if (attachments[1]?.kind !== "file" || attachments[1].mimeType !== "text/plain") {
    throw new Error("Expected second attachment to be a sniffed text file");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { AgentBackend, AgentEvent, AgentInput } from "../agents/types.js";
import type { AgentToolContext } from "../core/tool-bridge.js";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { ChatTarget, HubAttachment, HubSession } from "../core/types.js";
import { MediaCache } from "../core/media-cache.js";
import { DeliveryStore } from "../core/delivery-store.js";
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

class BridgeMediaBackend implements AgentBackend {
  readonly queue = new AsyncEventQueue<AgentEvent>();
  private toolContext: AgentToolContext | undefined;

  constructor(private readonly artifactPath: string) {}

  async start(_session: HubSession, toolContext?: AgentToolContext): Promise<number | undefined> {
    this.toolContext = toolContext;
    return process.pid;
  }

  async send(_input: AgentInput): Promise<void> {
    if (!this.toolContext) {
      throw new Error("Expected Hitch tool context.");
    }
    const requestId = "bridge-send-media";
    appendFileSync(
      this.toolContext.outboxPath,
      `${JSON.stringify({
        id: requestId,
        type: "send_media",
        token: this.toolContext.token,
        path: this.artifactPath,
        caption: "bridge caption",
        kind: "image",
      })}\n`,
      "utf8",
    );
    this.queue.push({ type: "final", text: "Bridge requested media send." });
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
  await runToolStatusBatchScenario();
  await runFailureOnlyToolStatusScenario();
  await runExplicitSendScenario();
  await runAutoDiscoveryDisabledScenario();
  await runToolBridgeScenario();
  process.stdout.write(`Media flow smoke ok: inbound=${summary.inbound} outbound=${summary.outbound}\n`);
}

async function runFailureOnlyToolStatusScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "failure-only-tools");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const artifactPath = path.join(dataDir, "quiet.png");
  writeFileSync(artifactPath, PNG_1X1);
  const target: ChatTarget = { platform: "fake", chatId: "failure-only-tools", userId: "media-user" };
  const channel = new MediaFlowChannel([
    { id: "new", target, text: "!new pi", receivedAt: new Date().toISOString() },
    { id: "prompt", target, text: "Keep successful tools quiet.", receivedAt: new Date().toISOString() },
  ]);
  const config = mediaFlowConfig(dataDir, false);
  config.delivery.tool_status_mode = "failures";
  const hub = new RemoteAgentHub(config, channel, () => new MediaFlowBackend(artifactPath));
  await hub.run();

  if (channel.texts.some((text) => text.startsWith("Tool started:") || text.startsWith("Tool finished:"))) {
    throw new Error(`Failure-only tool status mode leaked successful tool chatter: ${JSON.stringify(channel.texts)}`);
  }
  if (!channel.texts.some((text) => text.startsWith(`Generated artifact: "${artifactPath}"`))) {
    throw new Error("Failure-only tool status mode suppressed the final agent response.");
  }
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

async function runToolStatusBatchScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "batched-tools");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "batched.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-batched-tools",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Inspect this with batched tool statuses.",
      receivedAt: new Date().toISOString(),
    },
  ]);
  const config = mediaFlowConfig(dataDir, false, false, 60_000);
  const backend = new MediaFlowBackend(artifactPath);
  const hub = new RemoteAgentHub(config, channel, () => backend);
  await hub.run();

  const batchIndex = channel.texts.findIndex(
    (text) => text.includes("Tool started: read_file") && text.includes("Tool finished: read_file (succeeded)"),
  );
  const finalIndex = channel.texts.findIndex((text) => text.startsWith(`Generated artifact: "${artifactPath}"`));
  if (batchIndex === -1) {
    throw new Error(`Expected tool start/result to be batched into one message: ${JSON.stringify(channel.texts)}`);
  }
  if (finalIndex === -1 || batchIndex > finalIndex) {
    throw new Error("Expected batched tool status message to be sent before final agent text.");
  }
}

async function runExplicitSendScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "send");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "explicit.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-send",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "send",
      target,
      text: `!send ${artifactPath} explicit caption`,
      receivedAt: new Date().toISOString(),
    },
    {
      id: "blocked-send",
      target,
      text: `!send ${path.resolve("package.json")}`,
      receivedAt: new Date().toISOString(),
    },
  ]);
  const hub = new RemoteAgentHub(mediaFlowConfig(dataDir, false, false), channel, () => new MediaFlowBackend(artifactPath));
  await hub.run();

  if (channel.artifacts.length !== 1 || channel.artifacts[0]?.path !== artifactPath || channel.artifacts[0].caption !== "explicit caption") {
    throw new Error("Expected explicit !send to deliver exactly one outbound media artifact.");
  }
  if (!channel.texts.some((text) => text === "Media sent: explicit.png")) {
    throw new Error("Expected explicit !send success confirmation.");
  }
  if (!channel.texts.some((text) => text.startsWith("Media delivery failed: Media path is outside outbound roots"))) {
    throw new Error("Expected explicit !send to reject media outside outbound roots.");
  }
}

async function runAutoDiscoveryDisabledScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "auto-disabled");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "mentioned.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-auto-disabled",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Generate an image.",
      receivedAt: new Date().toISOString(),
    },
  ]);
  const backend = new MediaFlowBackend(artifactPath);
  const hub = new RemoteAgentHub(mediaFlowConfig(dataDir, false, false), channel, () => backend);
  await hub.run();

  if (channel.artifacts.length !== 0) {
    throw new Error("Expected auto-discovery disabled config to avoid sending mentioned artifact paths.");
  }
}

async function runToolBridgeScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "bridge");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "bridge.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-bridge",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Send this through the Hitch tool bridge.",
      receivedAt: new Date().toISOString(),
    },
  ]);
  const hub = new RemoteAgentHub(mediaFlowConfig(dataDir, false, false), channel, () => new BridgeMediaBackend(artifactPath));
  await hub.run();

  if (channel.artifacts.length !== 1 || channel.artifacts[0]?.path !== artifactPath || channel.artifacts[0].caption !== "bridge caption") {
    throw new Error("Expected tool bridge send_media request to deliver one outbound media artifact.");
  }
  const resultPath = findBridgeResultPath(dataDir);
  if (!resultPath || !existsSync(resultPath)) {
    throw new Error("Expected tool bridge to write a send_media result file.");
  }
  const toolResult = JSON.parse(readFileSync(resultPath, "utf8")) as { deliveryId?: string; status?: string };
  if (!toolResult.deliveryId || toolResult.status !== "sent") {
    throw new Error(`Expected a successful tool result with a delivery ID: ${JSON.stringify(toolResult)}`);
  }
  const store = new DeliveryStore(dataDir);
  const delivery = store.get(toolResult.deliveryId);
  store.close();
  if (
    delivery?.status !== "sent" ||
    delivery.kind !== "artifact" ||
    delivery.source !== "agent_tool" ||
    !delivery.sessionId ||
    !delivery.turnId
  ) {
    throw new Error(`Tool result did not correlate to one durable artifact delivery: ${JSON.stringify(delivery)}`);
  }
  const artifactAudit = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { type?: string; details?: { deliveryId?: string } })
    .find((row) => row.type === "artifact.delivery" && row.details?.deliveryId === toolResult.deliveryId);
  if (!artifactAudit) {
    throw new Error("Artifact audit and durable ledger did not share the tool result delivery ID.");
  }
  if (readFileSync(path.join(dataDir, "hub.sqlite")).includes(Buffer.from(artifactPath))) {
    throw new Error("Delivery ledger persisted an artifact path.");
  }
}

function findBridgeResultPath(dataDir: string): string | undefined {
  const toolsDir = path.join(dataDir, "tools");
  if (!existsSync(toolsDir)) {
    return undefined;
  }
  for (const sessionDir of readdirSync(toolsDir)) {
    const resultPath = path.join(toolsDir, sessionDir, "results", "bridge-send-media.json");
    if (existsSync(resultPath)) {
      return resultPath;
    }
  }
  return undefined;
}

function mediaFlowConfig(dataDir: string, fullToolOutput: boolean, autoDiscovery = true, toolStatusBatchMs = 0): HubConfig {
  const cwd = path.resolve(".");
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
    agent_turn_timeout_ms: 20_000,
    worker_idle_timeout_ms: 30 * 60 * 1000,
    approval_timeout_ms: 20_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
      auto_discovery: autoDiscovery,
      outbound_roots: [dataDir],
    },
    delivery: {
      full_tool_output: fullToolOutput,
      tool_status_mode: "all",
      tool_status_batch_ms: toolStatusBatchMs,
      send_timeout_ms: 5_000,
      queue_ttl_ms: 5 * 60 * 1000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
    allowedRoots: [cwd, dataDir],
    principalRoots: { media: [cwd, dataDir] },
    outboundRoots: [dataDir],
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
        send_min_interval_ms: 4_000,
        failure_cooldown_ms: 60_000,
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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentBackend, AgentEvent, AgentInput } from "../agents/types.js";
import type { ChannelAdapter, ChannelHealth, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { HubConfig } from "../config/schema.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget, HubSession } from "../core/types.js";
import { AuditLog } from "../core/audit-log.js";
import { DeliveryCoordinator } from "../core/delivery-coordinator.js";

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

class ReliabilityChannel implements ChannelAdapter {
  readonly texts: string[] = [];
  private readonly target: ChatTarget = { platform: "fake", chatId: "reliability", userId: "smoke" };

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    yield this.event("hang forever");
    yield this.event("overlap must be rejected");
    await sleep(120);
    yield this.event("!status");
    yield this.event("recover after timeout");
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    if (text === "Tool started: stalled_delivery") {
      // Intentionally ignore AbortSignal. The hub must still enforce its own
      // delivery and turn deadlines.
      await new Promise<void>(() => {});
    }
    this.texts.push(text);
  }

  health(): ChannelHealth {
    return { state: "healthy", lastSuccessAt: new Date().toISOString() };
  }

  private event(text: string): InboundChatEvent {
    return {
      id: crypto.randomUUID(),
      target: this.target,
      text,
      receivedAt: new Date().toISOString(),
    };
  }
}

class StalledBackend implements AgentBackend {
  readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  sendCount = 0;
  abortCount = 0;
  private alive = true;

  async start(_session: HubSession): Promise<number | undefined> {
    return 111;
  }

  async send(_input: AgentInput): Promise<void> {
    this.sendCount += 1;
    this.eventsQueue.push({ type: "tool_call", name: "stalled_delivery" });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.alive = false;
    setTimeout(() => {
      this.eventsQueue.push({ type: "final", text: "late stale response" });
    }, 20);
  }

  async stop(): Promise<void> {
    this.alive = false;
  }
}

class CompletingBackend implements AgentBackend {
  sendCount = 0;
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();

  async start(_session: HubSession): Promise<number | undefined> {
    return 222;
  }

  async send(_input: AgentInput): Promise<void> {
    this.sendCount += 1;
    this.eventsQueue.push({ type: "final", text: "recovered response" });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {}
}

class StalledMediaChannel implements ChannelAdapter {
  readonly texts: string[] = [];

  constructor(private readonly artifactPath: string) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield {
      id: crypto.randomUUID(),
      target: { platform: "fake", chatId: "stalled-media", userId: "smoke" },
      text: `!send ${this.artifactPath}`,
      receivedAt: new Date().toISOString(),
    };
  }

  async sendText(_target: ChatTarget, text: string): Promise<void> {
    this.texts.push(text);
  }

  async sendArtifact(
    _target: ChatTarget,
    _artifact: OutboundArtifact,
    _opts?: SendOptions,
  ): Promise<void> {
    await new Promise<void>(() => {});
  }
}

class OrderedMixedChannel implements ChannelAdapter {
  readonly order: string[] = [];

  async *receive(): AsyncIterable<InboundChatEvent> {
    return;
  }

  async sendText(_target: ChatTarget, _text: string): Promise<void> {
    this.order.push("text:start");
    await sleep(20);
    this.order.push("text:end");
  }

  async sendArtifact(_target: ChatTarget, _artifact: OutboundArtifact): Promise<void> {
    this.order.push("media:start");
    await sleep(20);
    this.order.push("media:end");
  }
}

class CooldownChannel implements ChannelAdapter {
  attempts = 0;

  async *receive(): AsyncIterable<InboundChatEvent> {
    return;
  }

  async sendText(): Promise<void> {}

  async sendArtifact(): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("WeChat sendMessage timed out after 30ms");
    }
  }
}

async function main(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-flow");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const channel = new ReliabilityChannel();
  const stalled = new StalledBackend();
  const completing = new CompletingBackend();
  const backends: AgentBackend[] = [stalled, completing];
  const startedAt = Date.now();
  const hub = new RemoteAgentHub(reliabilityConfig(dataDir), channel, () => {
    const backend = backends.shift();
    if (!backend) {
      throw new Error("Unexpected extra backend allocation.");
    }
    return backend;
  });
  await hub.run();
  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs > 1_000) {
    throw new Error(`Hard deadline regression: flow took ${elapsedMs}ms.`);
  }
  if (stalled.sendCount !== 1 || stalled.abortCount !== 1 || completing.sendCount !== 1) {
    throw new Error(
      `Expected one stalled turn, one abort, and one recovery turn; got ${stalled.sendCount}/${stalled.abortCount}/${completing.sendCount}.`,
    );
  }
  if (!channel.texts.includes("Agent turn timed out after 60ms.")) {
    throw new Error(`Expected hard timeout notification: ${JSON.stringify(channel.texts)}`);
  }
  const status = channel.texts.find((text) => text.startsWith("Session ") && text.includes("delivery:"));
  if (
    !status?.includes("status: error") ||
    !status.includes("turn: none") ||
    !status.includes("last error: Text delivery")
  ) {
    throw new Error(`Expected health-aware status with recent delivery failure: ${status ?? "missing"}`);
  }
  if (!channel.texts.includes("recovered response")) {
    throw new Error("Expected a new serialized turn to recover after the timed-out handler released ownership.");
  }
  if (channel.texts.includes("late stale response")) {
    throw new Error("A late event from the timed-out turn escaped turn ownership.");
  }

  const auditRows = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line) as { type?: string; details?: { status?: string } });
  if (auditRows.filter((row) => row.type === "worker.timeout").length !== 1) {
    throw new Error("Expected exactly one durable worker.timeout audit event.");
  }
  if (auditRows.filter((row) => row.type === "prompt.received").length !== 2) {
    throw new Error("Expected the overlapping prompt to be rejected before it reached the backend.");
  }
  if (!auditRows.some((row) => row.type === "text.delivery" && row.details?.status === "failed")) {
    throw new Error("Expected stalled text delivery to be audited as failed.");
  }

  await runMediaTimeoutScenario();
  await runUnifiedDeliveryScenario();
  await runWechatCooldownScenario();

  process.stdout.write(`Reliability flow smoke ok: elapsed=${elapsedMs}ms\n`);
}

async function runUnifiedDeliveryScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-unified-delivery");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new OrderedMixedChannel();
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), 30);
  const target: ChatTarget = { platform: "wechat", chatId: "ordered", userId: "smoke" };

  delivery.enqueueText(target, "before media");
  await delivery.sendArtifact(target, { path: "/tmp/ordered.png", kind: "image" });
  await delivery.drain();

  const order = channel.order.join(",");
  if (order !== "text:start,text:end,media:start,media:end") {
    throw new Error(`Text and media did not share one ordered queue: ${order}`);
  }
}

async function runWechatCooldownScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-wechat-cooldown");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new CooldownChannel();
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), 30, 60_000);
  const target: ChatTarget = { platform: "wechat", chatId: "cooldown", userId: "smoke" };
  const artifact: OutboundArtifact = { path: "/tmp/cooldown.png", kind: "image" };

  await delivery.sendArtifact(target, artifact).then(
    () => {
      throw new Error("Expected the first WeChat delivery to fail.");
    },
    () => undefined,
  );
  const secondError = await delivery.sendArtifact(target, artifact).then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (!secondError.includes("cooling down") || channel.attempts !== 1) {
    throw new Error(`Expected a fast cooldown failure after one channel attempt: ${secondError}/${channel.attempts}`);
  }

  delivery.noteInbound(target);
  await delivery.sendArtifact(target, artifact);
  if (Number(channel.attempts) !== 2) {
    throw new Error(`Fresh inbound did not reopen WeChat delivery: ${channel.attempts}`);
  }
}

async function runMediaTimeoutScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-media");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const artifactPath = path.join(dataDir, "stalled.png");
  writeFileSync(
    artifactPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const config = reliabilityConfig(dataDir);
  config.media.outbound_roots = [dataDir];
  config.outboundRoots = [dataDir];
  const channel = new StalledMediaChannel(artifactPath);
  const startedAt = Date.now();
  const hub = new RemoteAgentHub(config, channel, () => new CompletingBackend());
  await hub.run();
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > 500) {
    throw new Error(`Bounded media delivery regression: flow took ${elapsedMs}ms.`);
  }
  if (!channel.texts.some((text) => text.includes("Media delivery timed out after 30ms"))) {
    throw new Error(`Expected explicit media timeout result: ${JSON.stringify(channel.texts)}`);
  }
}

function reliabilityConfig(dataDir: string): HubConfig {
  const cwd = path.resolve(".");
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
    agent_turn_timeout_ms: 60,
    approval_timeout_ms: 5_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
      auto_discovery: false,
      outbound_roots: [],
    },
    delivery: {
      full_tool_output: false,
      tool_status_mode: "all",
      tool_status_batch_ms: 0,
      send_timeout_ms: 30,
    },
    allowedRoots: [cwd],
    outboundRoots: [],
    users: {
      smoke: { telegram_ids: [], wechat_ids: [], allowed_roots: [cwd] },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

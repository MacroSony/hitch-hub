import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentBackend, AgentEvent, AgentInput } from "../agents/types.js";
import { mapPiEvent } from "../agents/pi-rpc.js";
import type { ChannelAdapter, ChannelHealth, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { HubConfig } from "../config/schema.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget, HubSession } from "../core/types.js";
import { AuditLog } from "../core/audit-log.js";
import { DeliveryCoordinator } from "../core/delivery-coordinator.js";
import { DeliveryStore } from "../core/delivery-store.js";

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
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
    // Leave deterministic room for the 60ms deadline, abort-event drain, and
    // worker stop even when the full smoke suite is running concurrently.
    await sleep(300);
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

class PartialOnAbortBackend implements AgentBackend {
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  private alive = false;
  abortCount = 0;
  stopCount = 0;

  async start(): Promise<number | undefined> {
    this.alive = true;
    return 333;
  }

  async send(): Promise<void> {}

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    setTimeout(() => {
      this.eventsQueue.push({
        type: "final",
        text: "Useful partial answer produced while cancellation completed.",
        interrupted: true,
      });
    }, 5);
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.alive = false;
    this.eventsQueue.close();
  }
}

class ScriptedChannel implements ChannelAdapter {
  readonly texts: string[] = [];
  private readonly target: ChatTarget = { platform: "fake", chatId: crypto.randomUUID(), userId: "smoke" };

  constructor(
    private readonly messages: string[],
    private readonly pauseBeforeLastMs = 0,
  ) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    for (let index = 0; index < this.messages.length; index += 1) {
      if (index === this.messages.length - 1 && this.pauseBeforeLastMs > 0) {
        await sleep(this.pauseBeforeLastMs);
      }
      yield this.event(this.messages[index] ?? "");
    }
  }

  async sendText(_target: ChatTarget, text: string): Promise<void> {
    this.texts.push(text);
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

class EvictableBackend implements AgentBackend {
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  private alive = false;
  stopCount = 0;

  async start(): Promise<number | undefined> {
    this.alive = true;
    return 444;
  }

  async send(): Promise<void> {
    this.eventsQueue.push({ type: "final", text: "idle worker response" });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.alive = false;
    this.eventsQueue.close();
  }
}

class BlockingChannel implements ChannelAdapter {
  readonly eventsQueue = new AsyncEventQueue<InboundChatEvent>();
  readonly target: ChatTarget = { platform: "fake", chatId: "shutdown", userId: "smoke" };
  stopCount = 0;

  receive(): AsyncIterable<InboundChatEvent> {
    return this.eventsQueue.iterate();
  }

  async sendText(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.eventsQueue.close();
  }

  push(text: string): void {
    this.eventsQueue.push({
      id: crypto.randomUUID(),
      target: this.target,
      text,
      receivedAt: new Date().toISOString(),
    });
  }
}

class ShutdownBackend implements AgentBackend {
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  private alive = false;
  abortCount = 0;
  stopCount = 0;

  async start(): Promise<number | undefined> {
    this.alive = true;
    return 555;
  }

  async send(): Promise<void> {}

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.alive = false;
    this.eventsQueue.close();
  }
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

class SlowQueueChannel implements ChannelAdapter {
  readonly texts: string[] = [];

  async *receive(): AsyncIterable<InboundChatEvent> {
    return;
  }

  async sendText(_target: ChatTarget, text: string): Promise<void> {
    if (text === "queue blocker") {
      await sleep(150);
    }
    this.texts.push(text);
  }
}

async function main(): Promise<void> {
  const interrupted = mapPiEvent({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "Request was aborted",
        content: [{ type: "text", text: "mapped partial" }],
      },
    ],
  }).find((event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final");
  if (!interrupted?.interrupted || interrupted.text !== "mapped partial") {
    throw new Error(`Pi interrupted-final mapping regression: ${JSON.stringify(interrupted)}`);
  }

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

  if (elapsedMs > 1_500) {
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
    .map((line) => JSON.parse(line) as { type?: string; sessionId?: string; details?: { status?: string; deliveryId?: string; turnId?: string } });
  if (auditRows.filter((row) => row.type === "turn.timeout").length !== 1) {
    throw new Error("Expected exactly one durable turn.timeout audit event.");
  }
  if (auditRows.filter((row) => row.type === "prompt.received").length !== 2) {
    throw new Error("Expected the overlapping prompt to be rejected before it reached the backend.");
  }
  if (
    !auditRows.some(
      (row) =>
        row.type === "text.delivery" &&
        row.details?.status === "failed" &&
        row.details.deliveryId &&
        row.details.turnId &&
        row.sessionId,
    )
  ) {
    throw new Error("Expected stalled text delivery to be audited with delivery/session/turn correlation.");
  }
  const failedAudit = auditRows.find(
    (row) => row.type === "text.delivery" && row.details?.status === "failed" && row.details.deliveryId,
  );
  const persisted = new DeliveryStore(dataDir);
  const failedDelivery = failedAudit?.details?.deliveryId ? persisted.get(failedAudit.details.deliveryId) : undefined;
  persisted.close();
  if (failedDelivery?.status !== "failed" || failedDelivery.errorCode !== "send_timeout") {
    throw new Error(`Failed text audit did not match its durable terminal state: ${JSON.stringify(failedDelivery)}`);
  }

  await runTimeoutPartialScenario();
  await runIdleEvictionScenario();
  await runGracefulShutdownScenario();
  await runMediaTimeoutScenario();
  await runUnifiedDeliveryScenario();
  await runWechatCooldownScenario();
  await runDurableDeliveryScenario();
  await runHealthDiagnosticsScenario();
  await runAuditRotationScenario();

  process.stdout.write(`Reliability flow smoke ok: elapsed=${elapsedMs}ms\n`);
}

async function runTimeoutPartialScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-partial");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new ScriptedChannel(["!new pi", "run past deadline"]);
  const backend = new PartialOnAbortBackend();
  const hub = new RemoteAgentHub(reliabilityConfig(dataDir), channel, () => backend);
  await hub.run();

  const response = channel.texts.find((text) => text.includes("Partial result from the cancelled turn"));
  if (!response?.includes("Useful partial answer") || backend.abortCount !== 1 || backend.stopCount !== 1) {
    throw new Error(`Interrupted final was not surfaced and stopped deterministically: ${JSON.stringify(channel.texts)}`);
  }
  const timeout = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8")
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line) as { type?: string; details?: { partialResultLength?: number } })
    .find((row) => row.type === "turn.timeout");
  if (!timeout?.details?.partialResultLength) {
    throw new Error("Timeout audit did not record the surfaced partial result length.");
  }
}

async function runIdleEvictionScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-idle-eviction");
  rmSync(dataDir, { force: true, recursive: true });
  const config = reliabilityConfig(dataDir);
  config.worker_idle_timeout_ms = 40;
  const channel = new ScriptedChannel(["!new pi", "complete quickly", "!status"], 150);
  const backend = new EvictableBackend();
  const hub = new RemoteAgentHub(config, channel, () => backend);
  await hub.run();

  const status = channel.texts.find((text) => text.startsWith("Session ") && text.includes("worker:"));
  if (backend.stopCount !== 1 || !status?.includes("worker: not loaded")) {
    throw new Error(`Idle worker was not evicted: stopCount=${backend.stopCount} status=${status ?? "missing"}`);
  }
  const audit = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8");
  if (!audit.includes('"type":"worker.stopped"') || !audit.includes('"reason":"idle_timeout"')) {
    throw new Error("Idle worker eviction was not audited.");
  }
}

async function runGracefulShutdownScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-shutdown");
  rmSync(dataDir, { force: true, recursive: true });
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 5_000;
  const channel = new BlockingChannel();
  const backend = new ShutdownBackend();
  const hub = new RemoteAgentHub(config, channel, () => backend);
  const run = hub.run();
  channel.push("!new pi");
  channel.push("keep running");
  await sleep(30);
  const startedAt = Date.now();
  await hub.shutdown("SIGTERM");
  await run;

  if (Date.now() - startedAt > 500 || channel.stopCount !== 1 || backend.abortCount !== 1 || backend.stopCount !== 1) {
    throw new Error(
      `Graceful shutdown was not bounded: elapsed=${Date.now() - startedAt} channel=${channel.stopCount} abort=${backend.abortCount} stop=${backend.stopCount}`,
    );
  }
}

async function runUnifiedDeliveryScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-unified-delivery");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new OrderedMixedChannel();
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 30,
    queueTtlMs: 5_000,
    store,
  });
  const target: ChatTarget = { platform: "wechat", chatId: "ordered", userId: "smoke" };

  delivery.enqueueText(target, "before media");
  await delivery.sendArtifact(target, { path: "/tmp/ordered.png", kind: "image" });
  await delivery.drain();

  const order = channel.order.join(",");
  if (order !== "text:start,text:end,media:start,media:end") {
    throw new Error(`Text and media did not share one ordered queue: ${order}`);
  }
  store.close();
}

async function runWechatCooldownScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-wechat-cooldown");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new CooldownChannel();
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 30,
    queueTtlMs: 5_000,
    store,
    wechatFailureCooldownMs: 60_000,
  });
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
  store.close();
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

async function runDurableDeliveryScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-durable-delivery");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new SlowQueueChannel();
  const target: ChatTarget = { platform: "fake", chatId: "durable", userId: "smoke" };
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 500,
    queueTtlMs: 100,
    store,
  });

  const sentId = delivery.enqueueText(target, "queue blocker", undefined, {
    sessionId: "session-durable",
    turnId: "turn-durable",
  });
  const expiredSecret = "queue-expiry-secret-that-must-not-enter-sqlite";
  const expiredId = delivery.enqueueText(target, expiredSecret);
  if (!sentId || !expiredId) {
    throw new Error("Expected non-empty text deliveries to receive IDs.");
  }
  await delivery.drain();

  const sent = store.get(sentId);
  const expired = store.get(expiredId);
  if (
    sent?.status !== "sent" ||
    sent.attemptCount !== 1 ||
    sent.sessionId !== "session-durable" ||
    sent.turnId !== "turn-durable"
  ) {
    throw new Error(`Sent delivery lifecycle was not durable: ${JSON.stringify(sent)}`);
  }
  if (expired?.status !== "expired" || expired.attemptCount !== 0 || channel.texts.includes(expiredSecret)) {
    throw new Error(`Queued delivery did not expire before send: ${JSON.stringify(expired)}`);
  }
  if (readFileSync(path.join(dataDir, "hub.sqlite")).includes(Buffer.from(expiredSecret))) {
    throw new Error("Delivery ledger persisted a text body.");
  }
  store.close();

  const recoveryStore = new DeliveryStore(dataDir);
  const queuedId = crypto.randomUUID();
  const sendingId = crypto.randomUUID();
  const queuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  recoveryStore.create({ id: queuedId, kind: "text", target, queuedAt, expiresAt, contentLength: 10 });
  recoveryStore.create({ id: sendingId, kind: "artifact", target, queuedAt, expiresAt, contentLength: 20 });
  recoveryStore.markSending(sendingId, new Date().toISOString());
  recoveryStore.close();

  const restartedStore = new DeliveryStore(dataDir);
  if (restartedStore.recoverInterrupted() !== 2 || restartedStore.recoverInterrupted() !== 0) {
    throw new Error("Interrupted delivery recovery was not deterministic and idempotent.");
  }
  if (
    restartedStore.get(queuedId)?.errorCode !== "interrupted_restart" ||
    restartedStore.get(sendingId)?.status !== "expired"
  ) {
    throw new Error("Restart recovery did not expire every nonterminal delivery.");
  }
  if (restartedStore.markTerminal(sentId, "failed", new Date().toISOString(), { code: "test", message: "test" })) {
    throw new Error("A terminal delivery accepted a second terminal transition.");
  }
  restartedStore.close();
}

async function runHealthDiagnosticsScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-health");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new ScriptedChannel(["!health"]);
  const hub = new RemoteAgentHub(reliabilityConfig(dataDir), channel, () => new CompletingBackend());
  await hub.run();
  const health = channel.texts.find((text) => text.startsWith("Hitch health"));
  if (
    !health?.includes("delivery ledger: queued 0; sending 0") ||
    !health.includes("last inbound:") ||
    !health.includes("active session: none") ||
    !health.includes("startup recovery:")
  ) {
    throw new Error(`Expected operator health diagnostics: ${health ?? "missing"}`);
  }
}

async function runAuditRotationScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-audit-rotation");
  rmSync(dataDir, { force: true, recursive: true });
  const audit = new AuditLog(dataDir, { maxBytes: 180, maxFiles: 2 });
  for (let index = 0; index < 8; index += 1) {
    await audit.write({ type: "rotation.test", details: { index, padding: "x".repeat(80) } });
  }
  await audit.drain();
  const activePath = path.join(dataDir, "logs", "audit.jsonl");
  if (!readFileSync(activePath, "utf8").includes('"index":7') || !existsSync(`${activePath}.1`) || existsSync(`${activePath}.2`)) {
    throw new Error("Audit rotation did not retain the configured bounded file set.");
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
    worker_idle_timeout_ms: 0,
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
      queue_ttl_ms: 5 * 60 * 1000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
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

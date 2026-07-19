import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentBackend, AgentEvent, AgentInput } from "../agents/types.js";
import { mapPiEvent } from "../agents/pi-rpc.js";
import type { ChannelAdapter, ChannelHealth, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { HubConfig } from "../config/schema.js";
import { configSchema } from "../config/schema.js";
import { CheckpointDigestBatcher, RemoteAgentHub } from "../core/hub.js";
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
  private readonly stalledDeliveryStarted: Promise<void>;
  private markStalledDeliveryStarted: () => void = () => undefined;

  constructor() {
    this.stalledDeliveryStarted = new Promise((resolve) => {
      this.markStalledDeliveryStarted = resolve;
    });
  }

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    yield this.event("hang forever");
    yield this.event("overlap must be rejected");
    await Promise.race([
      this.stalledDeliveryStarted,
      sleep(2_000).then(() => {
        throw new Error("Stalled delivery did not start before the reliability deadline scenario.");
      }),
    ]);
    // The primary scenario uses a deliberately wider turn clock than the
    // focused timeout cases below so host load cannot reorder the send attempt
    // behind the authoritative timeout response.
    await sleep(700);
    yield this.event("!status");
    yield this.event("recover after timeout");
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    if (text === "Tool started: stalled_delivery") {
      // Intentionally ignore AbortSignal. The hub must still enforce its own
      // delivery and turn deadlines.
      this.markStalledDeliveryStarted();
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

class BufferedNormalFinalOnAbortBackend implements AgentBackend {
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  abortCount = 0;

  async start(): Promise<number | undefined> {
    return 335;
  }

  async send(): Promise<void> {
    this.eventsQueue.push({ type: "text_delta", text: "Buffered visible partial" });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.eventsQueue.push({ type: "final", text: "late normal final" });
  }

  async stop(): Promise<void> {
    this.eventsQueue.close();
  }
}

class FailedBoundaryOnAbortBackend implements AgentBackend {
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();

  async start(): Promise<number | undefined> {
    return 336;
  }

  async send(): Promise<void> {
    this.eventsQueue.push({ type: "text_delta", text: "failed grace draft" });
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {
    this.eventsQueue.push({
      type: "assistant_message_end",
      messageId: "failed-grace-message",
      text: "failed grace draft",
      stopReason: "error",
      hasToolCalls: false,
    });
    this.eventsQueue.push({
      type: "retry",
      state: "scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      error: "fetch failed",
    });
    this.eventsQueue.push({ type: "final", text: "Pi completed.", interrupted: true });
  }

  async stop(): Promise<void> {
    this.eventsQueue.close();
  }
}

class ScheduledBackend implements AgentBackend {
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private alive = false;
  abortCount = 0;
  stopCount = 0;

  constructor(private readonly schedule: Array<{ afterMs: number; event: AgentEvent }>) {}

  async start(): Promise<number | undefined> {
    this.alive = true;
    return 334;
  }

  async send(): Promise<void> {
    let elapsedMs = 0;
    for (const item of this.schedule) {
      elapsedMs += item.afterMs;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.eventsQueue.push(item.event);
      }, elapsedMs);
      this.timers.add(timer);
    }
  }

  events(): AsyncIterable<AgentEvent> {
    return this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.eventsQueue.close();
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.alive = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.eventsQueue.close();
  }
}

class SlowTerminalChannel implements ChannelAdapter {
  readonly texts: string[] = [];
  artifactCount = 0;
  private readonly target: ChatTarget = { platform: "fake", chatId: "slow-terminal", userId: "smoke" };

  constructor(private readonly artifactDelayMs: number) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    yield this.event("finish near the deadline");
  }

  async sendText(_target: ChatTarget, text: string): Promise<void> {
    this.texts.push(text);
  }

  async sendArtifact(): Promise<void> {
    await sleep(this.artifactDelayMs);
    this.artifactCount += 1;
  }

  private event(text: string): InboundChatEvent {
    return { id: crypto.randomUUID(), target: this.target, text, receivedAt: new Date().toISOString() };
  }
}

class CheckpointFailureChannel implements ChannelAdapter {
  readonly successfulTexts: string[] = [];
  digestAttempts = 0;
  private readonly target: ChatTarget = { platform: "fake", chatId: "checkpoint-failure", userId: "smoke" };

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    yield this.event("retry a failed checkpoint delivery");
  }

  async sendText(_target: ChatTarget, text: string): Promise<void> {
    if (text.startsWith("Progress update ·")) {
      this.digestAttempts += 1;
      throw new Error("synthetic checkpoint digest send failure");
    }
    this.successfulTexts.push(text);
  }

  private event(text: string): InboundChatEvent {
    return { id: crypto.randomUUID(), target: this.target, text, receivedAt: new Date().toISOString() };
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
  textAttempts = 0;

  async *receive(): AsyncIterable<InboundChatEvent> {
    return;
  }

  async sendText(): Promise<void> {
    this.textAttempts += 1;
  }

  async sendArtifact(): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("WeChat sendMessage timed out after 30ms");
    }
  }
}

class PriorityDeliveryChannel implements ChannelAdapter {
  readonly attemptedTexts: string[] = [];
  finalAttemptedAtMs: number | undefined;
  private releaseProgress: (() => void) | undefined;
  private markProgressStarted: (() => void) | undefined;
  readonly progressStarted = new Promise<void>((resolve) => {
    this.markProgressStarted = resolve;
  });
  private readonly progressRelease = new Promise<void>((resolve) => {
    this.releaseProgress = resolve;
  });

  async *receive(): AsyncIterable<InboundChatEvent> {
    return;
  }

  async sendText(_target: ChatTarget, text: string): Promise<void> {
    this.attemptedTexts.push(text);
    if (text === "progress in flight") {
      this.markProgressStarted?.();
      await this.progressRelease;
      throw new Error("WeChat sendMessage failed: ret=-2 errcode=0 errmsg=prepare failed");
    }
    if (text === "authoritative final") {
      this.finalAttemptedAtMs = Date.now();
    }
  }

  releaseFailedProgress(): void {
    this.releaseProgress?.();
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
  const invalidCap = configSchema.safeParse({ agent_turn_timeout_ms: 100, agent_turn_max_timeout_ms: 99 });
  if (invalidCap.success) {
    throw new Error("Config accepted an agent_turn_max_timeout_ms below the base active budget.");
  }
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
  const thinking = mapPiEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "hidden" },
  });
  if (thinking.length !== 1 || thinking[0]?.type !== "activity" || thinking[0].kind !== "thinking") {
    throw new Error(`Pi thinking activity mapping regression: ${JSON.stringify(thinking)}`);
  }
  const toolArgumentStream = mapPiEvent({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", delta: "hidden arguments" },
  });
  if (
    toolArgumentStream.length !== 1 ||
    toolArgumentStream[0]?.type !== "activity" ||
    toolArgumentStream[0].kind !== "stream"
  ) {
    throw new Error(`Pi tool-call stream activity mapping regression: ${JSON.stringify(toolArgumentStream)}`);
  }
  const toolProgress = mapPiEvent({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash" });
  if (toolProgress.length !== 1 || toolProgress[0]?.type !== "tool_progress" || toolProgress[0].id !== "call-1") {
    throw new Error(`Pi tool progress mapping regression: ${JSON.stringify(toolProgress)}`);
  }
  const checkpointMessage = {
    role: "assistant",
    stopReason: "toolUse",
    timestamp: 123,
    content: [
      { type: "text", text: "checkpoint" },
      { type: "toolCall", id: "checkpoint-tool", name: "read", arguments: {} },
    ],
  };
  const checkpointEvent = mapPiEvent({ type: "message_end", message: checkpointMessage })[0];
  const matchingFinal = mapPiEvent({ type: "agent_end", messages: [checkpointMessage] }).find(
    (event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final",
  );
  if (
    checkpointEvent?.type !== "assistant_message_end" ||
    !checkpointEvent.hasToolCalls ||
    checkpointEvent.stopReason !== "toolUse" ||
    checkpointEvent.messageId !== matchingFinal?.messageId
  ) {
    throw new Error(`Pi finalized-message identity mapping regression: ${JSON.stringify({ checkpointEvent, matchingFinal })}`);
  }
  const thinkingOnlyCheckpoint = mapPiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      timestamp: 124,
      content: [
        { type: "thinking", thinking: "hidden chain of thought" },
        { type: "toolCall", id: "thinking-tool", name: "read", arguments: {} },
      ],
    },
  })[0];
  if (thinkingOnlyCheckpoint?.type !== "assistant_message_end" || thinkingOnlyCheckpoint.text !== "") {
    throw new Error(`Finalized thinking leaked into checkpoint text: ${JSON.stringify(thinkingOnlyCheckpoint)}`);
  }
  const exhaustedRetry = mapPiEvent({
    type: "agent_end",
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "fetch failed Authorization: Bearer sk-terminal-secret",
        timestamp: 125,
        content: [{ type: "text", text: "failed terminal draft" }],
      },
    ],
  }).find((event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final");
  if (
    !exhaustedRetry?.failed ||
    !exhaustedRetry.text.startsWith("Pi failed: fetch failed") ||
    exhaustedRetry.text.includes("failed terminal draft") ||
    exhaustedRetry.text.includes("sk-terminal-secret")
  ) {
    throw new Error(`Exhausted retry failure mapping regression: ${JSON.stringify(exhaustedRetry)}`);
  }
  for (const rawFailure of [
    { type: "response", success: false, error: "Authorization: Bearer rpc-response-secret" },
    { type: "extension_error", error: `token=extension-secret ${"x".repeat(800)}` },
  ]) {
    const failure = mapPiEvent(rawFailure)[0];
    if (
      failure?.type !== "final" ||
      !failure.failed ||
      failure.text.includes("rpc-response-secret") ||
      failure.text.includes("extension-secret") ||
      failure.text.length > 530
    ) {
      throw new Error(`Raw Pi failure was not bounded and redacted: ${JSON.stringify(failure)}`);
    }
  }

  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-flow");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const channel = new ReliabilityChannel();
  const stalled = new StalledBackend();
  const completing = new CompletingBackend();
  const backends: AgentBackend[] = [stalled, completing];
  const startedAt = Date.now();
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  const hub = new RemoteAgentHub(config, channel, () => {
    const backend = backends.shift();
    if (!backend) {
      throw new Error("Unexpected extra backend allocation.");
    }
    return backend;
  });
  await hub.run();
  const elapsedMs = Date.now() - startedAt;

  if (elapsedMs > 2_500) {
    throw new Error(`Hard deadline regression: flow took ${elapsedMs}ms.`);
  }
  if (stalled.sendCount !== 1 || stalled.abortCount !== 1 || completing.sendCount !== 1) {
    throw new Error(
      `Expected one stalled turn, one abort, and one recovery turn; got ${stalled.sendCount}/${stalled.abortCount}/${completing.sendCount}.`,
    );
  }
  if (!channel.texts.includes("Agent turn timed out after 500ms of active work.")) {
    throw new Error(`Expected hard timeout notification: ${JSON.stringify(channel.texts)}`);
  }
  const status = channel.texts.find((text) => text.startsWith("Session ") && text.includes("delivery:"));
  if (
    !status?.includes("status: error") ||
    !status.includes("turn: none") ||
    !status.includes("worker: not loaded")
  ) {
    throw new Error(`Expected released timed-out turn health: ${status ?? "missing"}`);
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
  const stalledAudit = auditRows.find(
    (row) =>
      row.type === "text.delivery" &&
      (row.details?.status === "failed" || row.details?.status === "expired") &&
      row.details.deliveryId &&
      row.details.turnId &&
      row.sessionId,
  );
  if (!stalledAudit) {
    throw new Error("Expected stalled text delivery to reach an audited terminal state with delivery/session/turn correlation.");
  }
  const persisted = new DeliveryStore(dataDir);
  const stalledDelivery = stalledAudit.details?.deliveryId ? persisted.get(stalledAudit.details.deliveryId) : undefined;
  persisted.close();
  if (
    !stalledDelivery ||
    !(
      (stalledDelivery.status === "failed" && stalledDelivery.errorCode === "send_timeout") ||
      (stalledDelivery.status === "expired" && stalledDelivery.errorCode === "superseded")
    )
  ) {
    throw new Error(`Stalled text audit did not match its durable terminal state: ${JSON.stringify(stalledDelivery)}`);
  }

  await runTimeoutPartialScenario();
  await runBufferedPartialScenario();
  await runFailedBoundaryPartialScenario();
  await runDynamicTimeoutScenarios();
  await runCheckpointDigestScenario();
  await runCheckpointMaxWaitScenario();
  await runCheckpointDigestLimitScenario();
  await runCheckpointQueuedCancellationScenario();
  await runCheckpointDedupScenario();
  await runCheckpointRetryDiscardScenario();
  await runCheckpointTimeoutDiscardScenario();
  await runCheckpointFailureScenario();
  await runFailedFinalScenario();
  await runInputTimeoutCleanupScenario();
  await runTerminalReceiptScenario();
  await runIdleEvictionScenario();
  await runGracefulShutdownScenario();
  await runMediaTimeoutScenario();
  await runUnifiedDeliveryScenario();
  await runWechatCooldownScenario();
  await runAuthoritativeDeliveryScenario();
  await runAuthoritativeInboundWakeScenario();
  await runAuthoritativeArtifactStopScenario();
  await runAuthoritativeCooldownTtlScenario();
  await runDurableDeliveryScenario();
  await runHealthDiagnosticsScenario();
  await runAuditRotationScenario();

  process.stdout.write(`Reliability flow smoke ok: elapsed=${elapsedMs}ms\n`);
}

async function runCheckpointDigestScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-digest");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new SlowTerminalChannel(0);
  const backend = new ScheduledBackend([
    checkpointAfter(2, "digest-a", "Inspecting the session logs."),
    checkpointAfter(2, "digest-b", "Comparing delivery failures."),
    checkpointAfter(2, "digest-a-duplicate", "Inspecting the session logs."),
    checkpointAfter(2, "digest-c", "Checking the final-message path."),
    { afterMs: 30, event: { type: "final", text: "Inspecting the session logs." } },
  ]);
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  await new RemoteAgentHub(config, channel, () => backend).run();
  const digests = channel.texts.filter((text) => text.startsWith("Progress update ·"));
  if (
    digests.length !== 1 ||
    !/^Progress update · \d{2}:\d{2}:\d{2}/.test(digests[0] ?? "") ||
    !digests[0]?.match(/- \d{2}:\d{2}:\d{2} — Inspecting the session logs\./) ||
    !digests[0]?.includes("Comparing delivery failures.") ||
    !digests[0]?.includes("Checking the final-message path.") ||
    (digests[0]?.match(/Inspecting the session logs\./g)?.length ?? 0) !== 1 ||
    channel.texts.filter((text) => text === "Inspecting the session logs.").length !== 1
  ) {
    throw new Error(`Checkpoint digest formatting/dedup regressed: ${JSON.stringify(channel.texts)}`);
  }
}

async function runCheckpointMaxWaitScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-max-wait");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new SlowTerminalChannel(0);
  const backend = new ScheduledBackend([
    checkpointAfter(2, "continuous-a", "Continuous checkpoint one."),
    checkpointAfter(15, "continuous-b", "Continuous checkpoint two."),
    checkpointAfter(15, "continuous-c", "Continuous checkpoint three."),
    checkpointAfter(15, "continuous-d", "Continuous checkpoint four."),
    { afterMs: 20, event: { type: "final", text: "Maximum-wait scenario complete." } },
  ]);
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  config.delivery.checkpoint_batch_ms = 20;
  config.delivery.checkpoint_max_wait_ms = 50;
  await new RemoteAgentHub(config, channel, () => backend).run();
  const auditRows = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8");
  const digests = channel.texts.filter((text) => text.startsWith("Progress update ·"));
  if (
    digests.length !== 1 ||
    !digests[0]?.includes("Continuous checkpoint four.") ||
    !auditRows.includes('"trigger":"max_wait"') ||
    channel.texts.filter((text) => text === "Maximum-wait scenario complete.").length !== 1
  ) {
    throw new Error(`Checkpoint maximum-wait flush regressed: ${JSON.stringify(channel.texts)}`);
  }
}

async function runCheckpointDigestLimitScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-limit");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new SlowTerminalChannel(0);
  const backend = new ScheduledBackend([
    checkpointAfter(2, "limit-a", "Progress one."),
    checkpointAfter(50, "limit-b", "Progress two."),
    checkpointAfter(50, "limit-c", "Progress three."),
    checkpointAfter(50, "limit-d", "Progress four should be capped."),
    { afterMs: 50, event: { type: "final", text: "Digest-limit scenario complete." } },
  ]);
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 1_000;
  config.agent_turn_max_timeout_ms = 1_000;
  config.delivery.checkpoint_batch_ms = 10;
  config.delivery.checkpoint_max_wait_ms = 30;
  await new RemoteAgentHub(config, channel, () => backend).run();
  const auditRows = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8");
  if (
    channel.texts.filter((text) => text.startsWith("Progress update ·")).length !== 3 ||
    !auditRows.includes('"result":"limit_reached"') ||
    channel.texts.filter((text) => text === "Digest-limit scenario complete.").length !== 1
  ) {
    throw new Error(`Checkpoint digest cap regressed: ${JSON.stringify(channel.texts)}`);
  }
}

function checkpointAfter(afterMs: number, messageId: string, text: string): { afterMs: number; event: AgentEvent } {
  return {
    afterMs,
    event: { type: "assistant_message_end", messageId, text, stopReason: "toolUse", hasToolCalls: true },
  };
}

async function runCheckpointQueuedCancellationScenario(): Promise<void> {
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const sent: string[] = [];
  const sentMessageIds: string[][] = [];
  const batcher = new CheckpointDigestBatcher(
    { quietMs: 0, maxWaitMs: 0, maxDigests: 2, maxChars: 1_000 },
    async (digest) => {
      if (digest.number === 1) {
        markFirstStarted?.();
        await firstRelease;
      }
      sent.push(digest.text);
      sentMessageIds.push(digest.checkpoints.map((checkpoint) => checkpoint.messageId));
    },
  );

  const firstAdd = batcher.add({ messageId: "queued-first", text: "First digest.", createdAtMs: Date.now() });
  await firstStarted;
  const cancelledAdd = batcher.add({
    messageId: "queued-cancelled",
    text: "Repeated after retry.",
    createdAtMs: Date.now(),
  });
  batcher.discardPending();
  const recoveredAdd = batcher.add({
    messageId: "queued-recovered",
    text: "Repeated after retry.",
    createdAtMs: Date.now(),
  });
  releaseFirst?.();
  const [, , recoveredResult] = await Promise.all([firstAdd, cancelledAdd, recoveredAdd]);
  await batcher.close();

  if (
    recoveredResult !== "queued" ||
    sent.length !== 2 ||
    sentMessageIds.flat().includes("queued-cancelled") ||
    !sentMessageIds.flat().includes("queued-recovered") ||
    !sent[1]?.includes("Repeated after retry.")
  ) {
    throw new Error(
      `Queued checkpoint cancellation did not release dedupe/cap state: ${JSON.stringify({ sent, sentMessageIds, recoveredResult })}`,
    );
  }
}

async function runCheckpointDedupScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-dedup");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const artifactPath = path.join(dataDir, "checkpoint-artifact.txt");
  writeFileSync(artifactPath, "checkpoint artifact", "utf8");
  const checkpointText = `one visible checkpoint ${artifactPath}`;
  const channel = new SlowTerminalChannel(0);
  const backend = new ScheduledBackend([
    {
      afterMs: 5,
      event: {
        type: "assistant_message_end",
        messageId: "same-message",
        text: checkpointText,
        stopReason: "toolUse",
        hasToolCalls: true,
      },
    },
    { afterMs: 5, event: { type: "final", messageId: "same-message", text: checkpointText } },
  ]);
  const config = reliabilityConfig(dataDir);
  config.media.auto_discovery = true;
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  await new RemoteAgentHub(config, channel, () => backend).run();
  if (channel.texts.filter((text) => text === checkpointText).length !== 1 || channel.artifactCount !== 1) {
    throw new Error(`Checkpoint/final duplicate suppression regressed: ${JSON.stringify(channel.texts)}`);
  }
}

async function runCheckpointFailureScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-failure");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new CheckpointFailureChannel();
  const backend = new ScheduledBackend([
    {
      afterMs: 5,
      event: {
        type: "assistant_message_end",
        messageId: "failed-checkpoint",
        text: "resend after failed checkpoint",
        stopReason: "toolUse",
        hasToolCalls: true,
      },
    },
    {
      afterMs: 20,
      event: { type: "final", messageId: "failed-checkpoint", text: "resend after failed checkpoint" },
    },
  ]);
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  config.delivery.checkpoint_batch_ms = 10;
  config.delivery.checkpoint_max_wait_ms = 30;
  await new RemoteAgentHub(config, channel, () => backend).run();
  if (
    channel.digestAttempts !== 1 ||
    channel.successfulTexts.filter((text) => text === "resend after failed checkpoint").length !== 1
  ) {
    throw new Error(`Failed checkpoint delivery suppressed its terminal retry: ${JSON.stringify(channel.successfulTexts)}`);
  }
}

async function runCheckpointRetryDiscardScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-retry-discard");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new SlowTerminalChannel(0);
  const backend = new ScheduledBackend([
    checkpointAfter(2, "retry-old-only", "Failed attempt progress must be discarded."),
    checkpointAfter(2, "retry-old-repeat", "Repeated progress from both attempts."),
    {
      afterMs: 2,
      event: { type: "retry", state: "scheduled", attempt: 1, maxAttempts: 3, delayMs: 5, error: "fetch failed" },
    },
    checkpointAfter(2, "retry-new-repeat", "Repeated progress from both attempts."),
    checkpointAfter(2, "retry-new-only", "Recovered attempt progress."),
    { afterMs: 80, event: { type: "final", text: "Retry-discard scenario complete." } },
  ]);
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  await new RemoteAgentHub(config, channel, () => backend).run();
  const digest = channel.texts.find((text) => text.startsWith("Progress update ·"));
  if (
    !digest?.includes("Repeated progress from both attempts.") ||
    !digest.includes("Recovered attempt progress.") ||
    digest.includes("Failed attempt progress must be discarded.") ||
    channel.texts.filter((text) => text === "Retry-discard scenario complete.").length !== 1
  ) {
    throw new Error(`Retry did not discard pending checkpoint progress: ${JSON.stringify(channel.texts)}`);
  }
}

async function runCheckpointTimeoutDiscardScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-checkpoint-timeout-discard");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new SlowTerminalChannel(0);
  const backend = new ScheduledBackend([
    checkpointAfter(2, "timeout-pending", "Pending progress must not follow the timeout notice."),
  ]);
  const config = reliabilityConfig(dataDir);
  config.delivery.checkpoint_batch_ms = 100;
  config.delivery.checkpoint_max_wait_ms = 200;
  await new RemoteAgentHub(config, channel, () => backend).run();
  if (
    channel.texts.some((text) => text.startsWith("Progress update ·")) ||
    !channel.texts.some((text) => text.startsWith("Agent turn timed out"))
  ) {
    throw new Error(`Timeout did not discard pending checkpoint progress: ${JSON.stringify(channel.texts)}`);
  }
}

async function runFailedFinalScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-failed-final");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new ScriptedChannel(["!new pi", "exhaust retries"]);
  const backend = new ScheduledBackend([
    {
      afterMs: 5,
      event: {
        type: "final",
        text: "Pi failed: fetch failed Authorization: Bearer audit-secret-value",
        failed: true,
      },
    },
  ]);
  await new RemoteAgentHub(reliabilityConfig(dataDir), channel, () => backend).run();
  const audit = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8");
  if (
    !channel.texts.includes("Pi failed: fetch failed Authorization: Bearer audit-secret-value") ||
    !audit.includes('"type":"turn.failed"') ||
    audit.includes('"type":"turn.completed"') ||
    audit.includes("audit-secret-value") ||
    !audit.includes('"failure":"agent_final"')
  ) {
    throw new Error(`Terminal provider failure was recorded as success: ${JSON.stringify(channel.texts)}`);
  }
}

async function runBufferedPartialScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-buffered-partial");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new ScriptedChannel(["!new pi", "stream then cross the deadline"]);
  const backend = new BufferedNormalFinalOnAbortBackend();
  await new RemoteAgentHub(reliabilityConfig(dataDir), channel, () => backend).run();
  const response = channel.texts.find((text) => text.includes("Partial result from the cancelled turn"));
  if (
    !response?.includes("Buffered visible partial") ||
    response.includes("late normal final") ||
    backend.abortCount !== 1
  ) {
    throw new Error(`Buffered partial was discarded by a late normal final: ${JSON.stringify(channel.texts)}`);
  }
}

async function runFailedBoundaryPartialScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-failed-boundary");
  rmSync(dataDir, { force: true, recursive: true });
  const channel = new ScriptedChannel(["!new pi", "fail while cancellation drains"]);
  await new RemoteAgentHub(reliabilityConfig(dataDir), channel, () => new FailedBoundaryOnAbortBackend()).run();
  const timeoutNotice = channel.texts.find((text) => text.includes("Agent turn timed out"));
  if (!timeoutNotice || timeoutNotice.includes("Partial result") || timeoutNotice.includes("failed grace draft")) {
    throw new Error(`Failed retry text leaked through timeout grace: ${JSON.stringify(channel.texts)}`);
  }
}

async function runInputTimeoutCleanupScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-input-timeout");
  rmSync(dataDir, { force: true, recursive: true });
  const config = reliabilityConfig(dataDir);
  config.agent_turn_timeout_ms = 500;
  config.agent_turn_max_timeout_ms = 500;
  config.agent_input_timeout_ms = 35;
  const channel = new ScriptedChannel(["!new pi", "request input and wait"]);
  const backend = new ScheduledBackend([
    {
      afterMs: 5,
      event: {
        type: "interaction_request",
        interaction: {
          kind: "smoke.choice",
          title: "Pick one",
          options: [{ label: "one", value: 1 }],
        },
      },
    },
  ]);
  await new RemoteAgentHub(config, channel, () => backend).run();
  if (!channel.texts.includes("Agent input request timed out after 35ms.")) {
    throw new Error(`Configured input timeout was not enforced: ${JSON.stringify(channel.texts)}`);
  }
  const db = new DatabaseSync(path.join(dataDir, "hub.sqlite"));
  const pending = db.prepare("SELECT COUNT(*) AS count FROM pending_interactions WHERE owner = 'agent'").get() as
    | { count?: number }
    | undefined;
  db.close();
  if ((pending?.count ?? 0) !== 0) {
    throw new Error(`Input timeout left ${pending?.count ?? 0} stale agent interaction(s).`);
  }
}

async function runTerminalReceiptScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-terminal-receipt");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const artifactPath = path.join(dataDir, "terminal.txt");
  writeFileSync(artifactPath, "terminal artifact", "utf8");
  const config = reliabilityConfig(dataDir);
  config.media.auto_discovery = true;
  config.agent_turn_timeout_ms = 150;
  config.agent_turn_max_timeout_ms = 150;
  config.delivery.send_timeout_ms = 300;
  const channel = new SlowTerminalChannel(120);
  const backend = new ScheduledBackend([
    { afterMs: 100, event: { type: "final", text: `Finished with ${artifactPath}` } },
  ]);
  await new RemoteAgentHub(config, channel, () => backend).run();
  if (
    !channel.texts.includes(`Finished with ${artifactPath}`) ||
    channel.artifactCount !== 1 ||
    channel.texts.some((text) => text.includes("timed out")) ||
    backend.abortCount !== 0
  ) {
    throw new Error(`A received final lost a race to the agent deadline: ${JSON.stringify(channel.texts)}`);
  }
}

async function runDynamicTimeoutScenarios(): Promise<void> {
  const extensionDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-extension");
  rmSync(extensionDir, { force: true, recursive: true });
  const extensionConfig = reliabilityConfig(extensionDir);
  extensionConfig.agent_turn_timeout_ms = 100;
  extensionConfig.agent_turn_tool_extension_ms = 200;
  extensionConfig.agent_turn_max_timeout_ms = 400;
  extensionConfig.agent_turn_stall_timeout_ms = 250;
  extensionConfig.agent_tool_timeout_ms = 250;
  const extensionChannel = new ScriptedChannel(["!new pi", "extend for one tool"]);
  const extensionBackend = new ScheduledBackend([
    { afterMs: 20, event: { type: "tool_call", id: "extend-1", name: "read" } },
    { afterMs: 20, event: { type: "tool_result", id: "extend-1", name: "read", succeeded: true } },
    { afterMs: 120, event: { type: "final", text: "completed inside extended budget" } },
  ]);
  await new RemoteAgentHub(extensionConfig, extensionChannel, () => extensionBackend).run();
  if (!extensionChannel.texts.includes("completed inside extended budget") || extensionBackend.abortCount !== 0) {
    throw new Error(`Tool extension did not preserve a productive turn: ${JSON.stringify(extensionChannel.texts)}`);
  }

  const progressDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-progress");
  rmSync(progressDir, { force: true, recursive: true });
  const progressConfig = reliabilityConfig(progressDir);
  progressConfig.agent_turn_timeout_ms = 400;
  progressConfig.agent_turn_max_timeout_ms = 400;
  progressConfig.agent_turn_stall_timeout_ms = 100;
  progressConfig.agent_tool_timeout_ms = 100;
  const progressChannel = new ScriptedChannel(["!new pi", "keep reporting progress"]);
  const progressBackend = new ScheduledBackend([
    { afterMs: 5, event: { type: "tool_call", id: "progress-1", name: "bash" } },
    { afterMs: 60, event: { type: "tool_progress", id: "progress-1", name: "bash" } },
    { afterMs: 60, event: { type: "tool_result", id: "progress-1", name: "bash", succeeded: true } },
    { afterMs: 60, event: { type: "activity", kind: "thinking" } },
    { afterMs: 60, event: { type: "final", text: "progress kept the turn alive" } },
  ]);
  await new RemoteAgentHub(progressConfig, progressChannel, () => progressBackend).run();
  if (!progressChannel.texts.includes("progress kept the turn alive") || progressBackend.abortCount !== 0) {
    throw new Error(`Tool/thinking progress did not renew the activity timers: ${JSON.stringify(progressChannel.texts)}`);
  }

  const refreshDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-input-refresh");
  rmSync(refreshDir, { force: true, recursive: true });
  const refreshConfig = reliabilityConfig(refreshDir);
  refreshConfig.agent_turn_timeout_ms = 400;
  refreshConfig.agent_turn_max_timeout_ms = 400;
  refreshConfig.agent_input_timeout_ms = 100;
  const refreshChannel = new ScriptedChannel(["!new pi", "replace an input request"]);
  const refreshBackend = new ScheduledBackend([
    {
      afterMs: 10,
      event: {
        type: "interaction_request",
        interaction: { kind: "first", title: "First", options: [{ label: "one", value: 1 }] },
      },
    },
    {
      afterMs: 70,
      event: {
        type: "interaction_request",
        interaction: { kind: "second", title: "Second", options: [{ label: "two", value: 2 }] },
      },
    },
    { afterMs: 60, event: { type: "final", text: "replacement request refreshed the wait" } },
  ]);
  await new RemoteAgentHub(refreshConfig, refreshChannel, () => refreshBackend).run();
  if (!refreshChannel.texts.includes("replacement request refreshed the wait") || refreshBackend.abortCount !== 0) {
    throw new Error(`Replacement input did not refresh its wait deadline: ${JSON.stringify(refreshChannel.texts)}`);
  }

  const capDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-cap");
  rmSync(capDir, { force: true, recursive: true });
  const capConfig = reliabilityConfig(capDir);
  capConfig.agent_turn_timeout_ms = 100;
  capConfig.agent_turn_tool_extension_ms = 150;
  capConfig.agent_turn_max_timeout_ms = 180;
  capConfig.agent_turn_stall_timeout_ms = 500;
  capConfig.agent_tool_timeout_ms = 500;
  const capChannel = new ScriptedChannel(["!new pi", "hit the extension cap"]);
  const capBackend = new ScheduledBackend([
    { afterMs: 20, event: { type: "tool_call", id: "cap-1", name: "read" } },
    { afterMs: 10, event: { type: "tool_result", id: "cap-1", name: "read", succeeded: true } },
    { afterMs: 20, event: { type: "tool_call", id: "cap-2", name: "read" } },
    { afterMs: 10, event: { type: "tool_result", id: "cap-2", name: "read", succeeded: true } },
  ]);
  await new RemoteAgentHub(capConfig, capChannel, () => capBackend).run();
  if (!capChannel.texts.includes("Agent turn timed out after 180ms of active work.") || capBackend.abortCount !== 1) {
    throw new Error(`Dynamic timeout cap was not enforced: ${JSON.stringify(capChannel.texts)}`);
  }

  const stallDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-stall");
  rmSync(stallDir, { force: true, recursive: true });
  const stallConfig = reliabilityConfig(stallDir);
  stallConfig.agent_turn_timeout_ms = 500;
  stallConfig.agent_turn_max_timeout_ms = 500;
  stallConfig.agent_turn_stall_timeout_ms = 35;
  stallConfig.agent_tool_timeout_ms = 100;
  const stallChannel = new ScriptedChannel(["!new pi", "go silent"]);
  const stallBackend = new ScheduledBackend([]);
  await new RemoteAgentHub(stallConfig, stallChannel, () => stallBackend).run();
  if (!stallChannel.texts.includes("Agent turn stalled after 35ms without activity.") || stallBackend.abortCount !== 1) {
    throw new Error(`Silent-agent timeout was not enforced: ${JSON.stringify(stallChannel.texts)}`);
  }

  const toolDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-tool");
  rmSync(toolDir, { force: true, recursive: true });
  const toolConfig = reliabilityConfig(toolDir);
  toolConfig.agent_turn_timeout_ms = 500;
  toolConfig.agent_turn_max_timeout_ms = 500;
  toolConfig.agent_turn_stall_timeout_ms = 100;
  toolConfig.agent_tool_timeout_ms = 80;
  const toolChannel = new ScriptedChannel(["!new pi", "let the tool stall"]);
  const toolBackend = new ScheduledBackend([
    { afterMs: 10, event: { type: "tool_call", id: "stalled-tool", name: "bash" } },
  ]);
  await new RemoteAgentHub(toolConfig, toolChannel, () => toolBackend).run();
  if (!toolChannel.texts.includes("Agent tool made no progress for 80ms.") || toolBackend.abortCount !== 1) {
    throw new Error(`In-flight tool timeout was not enforced: ${JSON.stringify(toolChannel.texts)}`);
  }

  const correlationDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-timeout-tool-correlation");
  rmSync(correlationDir, { force: true, recursive: true });
  const correlationConfig = reliabilityConfig(correlationDir);
  correlationConfig.agent_turn_timeout_ms = 500;
  correlationConfig.agent_turn_max_timeout_ms = 500;
  correlationConfig.agent_turn_stall_timeout_ms = 100;
  correlationConfig.agent_tool_timeout_ms = 80;
  const correlationChannel = new ScriptedChannel(["!new pi", "keep exact tool identity"]);
  const correlationBackend = new ScheduledBackend([
    { afterMs: 10, event: { type: "tool_call", id: "real-tool", name: "bash" } },
    { afterMs: 30, event: { type: "tool_result", id: "unknown-tool", name: "bash", succeeded: true } },
  ]);
  await new RemoteAgentHub(correlationConfig, correlationChannel, () => correlationBackend).run();
  if (!correlationChannel.texts.includes("Agent tool made no progress for 80ms.")) {
    throw new Error(`An unknown tool ID incorrectly completed another tool: ${JSON.stringify(correlationChannel.texts)}`);
  }
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

async function runAuthoritativeDeliveryScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-authoritative-delivery");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new PriorityDeliveryChannel();
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 200,
    queueTtlMs: 5_000,
    store,
    wechatFailureCooldownMs: 40,
  });
  const target: ChatTarget = { platform: "wechat", chatId: "authoritative", userId: "smoke" };

  const inFlightId = delivery.enqueueText(target, "progress in flight", undefined, {}, "progress");
  await channel.progressStarted;
  const supersededId = delivery.enqueueText(target, "queued progress", undefined, {}, "progress");
  const finalQueuedAtMs = Date.now();
  const finalId = delivery.enqueueText(target, "authoritative final", undefined, {}, "authoritative");
  channel.releaseFailedProgress();
  if (!inFlightId || !supersededId || !finalId) {
    throw new Error("Authoritative delivery scenario did not create all delivery records.");
  }
  await Promise.all([
    delivery.waitForTextDelivery(inFlightId),
    delivery.waitForTextDelivery(supersededId),
    delivery.waitForTextDelivery(finalId),
  ]);

  const inFlight = store.get(inFlightId);
  const superseded = store.get(supersededId);
  const final = store.get(finalId);
  if (
    channel.attemptedTexts.join(",") !== "progress in flight,authoritative final" ||
    inFlight?.status !== "failed" ||
    superseded?.status !== "expired" ||
    superseded.errorCode !== "superseded" ||
    final?.status !== "sent" ||
    !channel.finalAttemptedAtMs ||
    channel.finalAttemptedAtMs - finalQueuedAtMs < 25
  ) {
    throw new Error(
      `Authoritative delivery did not supersede progress and wait through cooldown: ${JSON.stringify({
        attempts: channel.attemptedTexts,
        inFlight,
        superseded,
        final,
        delayMs: channel.finalAttemptedAtMs ? channel.finalAttemptedAtMs - finalQueuedAtMs : undefined,
      })}`,
    );
  }
  await delivery.drain();
  store.close();
}

async function runAuthoritativeInboundWakeScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-authoritative-inbound-wake");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new PriorityDeliveryChannel();
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 200,
    queueTtlMs: 5_000,
    store,
    wechatFailureCooldownMs: 1_000,
  });
  const target: ChatTarget = { platform: "wechat", chatId: "authoritative-inbound", userId: "smoke" };
  const progressId = delivery.enqueueText(target, "progress in flight", undefined, {}, "progress");
  await channel.progressStarted;
  const finalId = delivery.enqueueText(target, "authoritative final", undefined, {}, "authoritative");
  const startedAtMs = Date.now();
  channel.releaseFailedProgress();
  if (!progressId || !finalId) {
    throw new Error("Inbound wake scenario did not create both deliveries.");
  }
  await delivery.waitForTextDelivery(progressId);
  await sleep(10);
  delivery.noteInbound(target);
  await delivery.waitForTextDelivery(finalId);
  if (store.get(finalId)?.status !== "sent" || Date.now() - startedAtMs >= 500) {
    throw new Error("Fresh inbound did not wake an authoritative cooldown wait.");
  }
  await delivery.drain();
  store.close();
}

async function runAuthoritativeArtifactStopScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-authoritative-artifact-stop");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new CooldownChannel();
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 200,
    queueTtlMs: 5_000,
    store,
    wechatFailureCooldownMs: 60_000,
  });
  const target: ChatTarget = { platform: "wechat", chatId: "authoritative-artifact-stop", userId: "smoke" };
  const artifact: OutboundArtifact = { path: "/tmp/authoritative-stop.png", kind: "image" };
  await delivery.sendArtifact(target, artifact).catch(() => undefined);
  const deliveryId = crypto.randomUUID();
  const startedAtMs = Date.now();
  const authoritativeSend = delivery.sendArtifact(target, artifact, undefined, {}, { deliveryId }, "authoritative");
  await sleep(10);
  delivery.stop();
  const error = await authoritativeSend.then(
    () => "",
    (reason: unknown) => (reason instanceof Error ? reason.name : String(reason)),
  );
  const record = store.get(deliveryId);
  if (
    error !== "DeliveryStoppedError" ||
    record?.status !== "expired" ||
    record.errorCode !== "delivery_stopped" ||
    Date.now() - startedAtMs >= 500 ||
    channel.attempts !== 1
  ) {
    throw new Error(`Stopping did not wake authoritative artifact cooldown: ${JSON.stringify({ error, record })}`);
  }
  await delivery.drain();
  store.close();
}

async function runAuthoritativeCooldownTtlScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/reliability-authoritative-cooldown-ttl");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const channel = new CooldownChannel();
  const store = new DeliveryStore(dataDir);
  const delivery = new DeliveryCoordinator(channel, new AuditLog(dataDir), {
    sendTimeoutMs: 200,
    queueTtlMs: 50,
    store,
    wechatFailureCooldownMs: 60_000,
  });
  const target: ChatTarget = { platform: "wechat", chatId: "authoritative-cooldown-ttl", userId: "smoke" };
  await delivery
    .sendArtifact(target, { path: "/tmp/authoritative-ttl.png", kind: "image" })
    .catch(() => undefined);
  const startedAtMs = Date.now();
  const finalId = delivery.enqueueText(target, "authoritative ttl final", undefined, {}, "authoritative");
  if (!finalId) {
    throw new Error("Cooldown TTL scenario did not create a final delivery.");
  }
  await delivery.waitForTextDelivery(finalId);
  const record = store.get(finalId);
  if (
    record?.status !== "expired" ||
    record.errorCode !== "queue_expired" ||
    channel.textAttempts !== 0 ||
    Date.now() - startedAtMs >= 500
  ) {
    throw new Error(`Authoritative cooldown ignored queue TTL: ${JSON.stringify({ record, textAttempts: channel.textAttempts })}`);
  }
  await delivery.drain();
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
    agent_turn_tool_extension_ms: 0,
    agent_turn_max_timeout_ms: 60,
    agent_turn_stall_timeout_ms: 1_000,
    agent_tool_timeout_ms: 1_000,
    agent_input_timeout_ms: 5_000,
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
      checkpoint_batch_ms: 20,
      checkpoint_max_wait_ms: 60,
      checkpoint_max_digests_per_turn: 3,
      checkpoint_max_chars: 1_000,
      send_timeout_ms: 30,
      queue_ttl_ms: 5 * 60 * 1000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
    allowedRoots: [cwd],
    principalRoots: { smoke: [cwd] },
    outboundRoots: [],
    users: {
      smoke: { telegram_ids: [], wechat_ids: [], allowed_roots: [cwd], capabilities: ["operator"] },
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
        credential_isolation: "disabled",
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

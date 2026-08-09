import { TextDecoder, TextEncoder } from "node:util";

import type {
  AgentDriverDefinition,
  AgentDriverTurnEvent,
  AgentDriverTurnEventPayload,
  AgentLaunchMode,
  AgentLaunchProjection,
  AgentProfileValidationResult,
  AgentPromptAcceptanceOutcome,
  AgentRuntime,
  AgentRuntimeReadyState,
  AgentTransportWriteResult,
  AgentTurnPreparation,
  AgentTurnReconciliation,
  AgentTurnRun,
  ArmedProtocolPromptSubmission,
  ProtocolPromptSubmissionOutcome,
  ReviewedSupervisorAgentArtifact,
  SendStartedAgentInteractionResponse,
  SupervisorOwnedAgentProcess,
} from "../../model/agent-runtime.js";
import type {
  AgentDispatchAttemptId,
  AgentDriverId,
  AgentDriverLaunchProfileId,
  AgentProtocolMessageId,
  AgentProtocolToolCallId,
  IsoTimestamp,
} from "../../model/primitives.js";
import type {
  SanitizedAgentProfileConfiguration,
  SanitizedAgentRuntimeConfiguration,
} from "../../model/runtime-security.js";
import type { AgentProfileRevision } from "../../model/session.js";

const encoder = new TextEncoder();
const WORKSPACE_TOOLS = new Set(["read", "write", "edit", "ls"]);
const WORKSPACE_PATH = "/workspace";
const WORKSPACE_TOOLS_EXTENSION_PATH =
  "/hitch-runtime/workspace-tools.mjs";
const WORKSPACE_TOOLS_ADDON_PATH = "/hitch-runtime/workspace-tools.node";

export interface PiRpcToolAttestation {
  /** Exact reserved key emitted once by the reviewed workspace-tool extension. */
  readonly statusKey: string;
}

export interface PiRpcDriverProtocolLimits {
  readonly maximumFrameBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumPromptBytes: number;
  readonly maximumEventTextBytes: number;
}

export interface PiRpcDriverOptions {
  readonly driverId: AgentDriverId;
  readonly launchProfileId: AgentDriverLaunchProfileId;
  readonly toolAttestation: PiRpcToolAttestation;
  /** Mandatory artifacts selected by trusted composition, never by a profile. */
  readonly reviewedSupervisorArtifacts: readonly [
    ReviewedSupervisorAgentArtifact & {
      readonly kind: "workspace-tools-extension";
    },
    ReviewedSupervisorAgentArtifact & {
      readonly kind: "workspace-tools-addon";
    },
  ];
  readonly limits: PiRpcDriverProtocolLimits;
  readonly now?: () => IsoTimestamp;
}

function attestationText(
  artifacts: PiRpcDriverOptions["reviewedSupervisorArtifacts"],
): string {
  return `hitch-workspace-tools extension=${artifacts[0].integrityDigest} addon=${artifacts[1].integrityDigest}`;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T) => void;
  private rejectPromise!: (error: unknown) => void;
  private settled = false;
  private settledValue: T | undefined;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.settledValue = value;
    this.resolvePromise(value);
  }

  reject(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(error);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  get value(): T | undefined {
    return this.settledValue;
  }
}

class EventQueue implements AsyncIterable<AgentDriverTurnEvent> {
  private readonly buffered: AgentDriverTurnEvent[] = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<AgentDriverTurnEvent>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure?: unknown;
  private claimed = false;

  push(event: AgentDriverTurnEvent): void {
    if (this.closed || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: event });
      return;
    }
    this.buffered.push(event);
  }

  close(): void {
    if (this.closed || this.failure !== undefined) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentDriverTurnEvent> {
    if (this.claimed) throw new Error("Pi Turn events may be consumed only once");
    this.claimed = true;
    return {
      next: async (): Promise<IteratorResult<AgentDriverTurnEvent>> => {
        const buffered = this.buffered.shift();
        if (buffered !== undefined) return { done: false, value: buffered };
        if (this.failure !== undefined) throw this.failure;
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<AgentDriverTurnEvent>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

class StrictJsonLineDecoder {
  private pending = new Uint8Array(0);

  constructor(private readonly maximumFrameBytes: number) {}

  accept(chunk: Uint8Array): readonly unknown[] {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);

    const frames: unknown[] = [];
    let start = 0;
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] !== 0x0a) continue;
      let end = index;
      if (end > start && joined[end - 1] === 0x0d) end -= 1;
      const length = end - start;
      if (length === 0) throw new Error("Pi RPC emitted an empty frame");
      if (length > this.maximumFrameBytes) {
        throw new Error("Pi RPC frame exceeded the configured byte limit");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        joined.subarray(start, end),
      );
      frames.push(parseStrictJson(text));
      start = index + 1;
    }

    this.pending = joined.slice(start);
    if (this.pending.length > this.maximumFrameBytes + 1) {
      throw new Error("Pi RPC frame exceeded the configured byte limit");
    }
    return frames;
  }

  finish(): void {
    if (this.pending.length !== 0) {
      throw new Error("Pi RPC stdout ended with an unterminated frame");
    }
  }
}

type RuntimeState =
  | "attached"
  | "initializing"
  | "idle"
  | "prepared"
  | "submitted"
  | "running"
  | "settled"
  | "closed"
  | "failed";

interface RecordValue {
  readonly [key: string]: unknown;
}

function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as RecordValue;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function finitePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function defaultNow(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function writeOutcome(
  result: AgentTransportWriteResult,
): ProtocolPromptSubmissionOutcome {
  switch (result.kind) {
    case "complete":
      return frozen({ kind: "submitted" as const, submittedAt: result.completedAt });
    case "definitely-not-written":
      return frozen({
        kind: "definitely-not-submitted" as const,
        failedAt: result.failedAt,
        reason: "agent transport proved that no prompt byte was written",
      });
    case "write-uncertain":
      return frozen({
        kind: "submission-unknown" as const,
        failedAt: result.failedAt,
        reason: "agent transport could not prove prompt submission",
      });
  }
}

/** Duplicate-aware bounded parser for one already byte-bounded Pi RPC line. */
function parseStrictJson(input: string): unknown {
  let index = 0;
  let nodes = 0;
  const maximumDepth = 64;
  const maximumNodes = 20_000;
  const maximumContainerItems = 1_024;

  const whitespace = (): void => {
    while (
      input[index] === " " ||
      input[index] === "\t" ||
      input[index] === "\r" ||
      input[index] === "\n"
    ) {
      index += 1;
    }
  };
  const fail = (): never => {
    throw new Error("Pi RPC emitted invalid JSON");
  };
  const string = (): string => {
    if (input[index] !== '"') return fail();
    const start = index;
    index += 1;
    let escaped = false;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code < 0x20) return fail();
      if (!escaped && input[index] === '"') {
        index += 1;
        try {
          return JSON.parse(input.slice(start, index)) as string;
        } catch {
          return fail();
        }
      }
      if (!escaped && input[index] === "\\") escaped = true;
      else escaped = false;
      index += 1;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) return fail();
    whitespace();
    const token = input[index];
    if (token === '"') return string();
    if (token === "{") {
      index += 1;
      whitespace();
      const output: Record<string, unknown> = {};
      const seen = new Set<string>();
      if (input[index] === "}") {
        index += 1;
        return output;
      }
      while (true) {
        if (seen.size >= maximumContainerItems) return fail();
        whitespace();
        const key = string();
        if (seen.has(key)) return fail();
        seen.add(key);
        whitespace();
        if (input[index] !== ":") return fail();
        index += 1;
        Object.defineProperty(output, key, {
          value: value(depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        whitespace();
        if (input[index] === "}") {
          index += 1;
          return output;
        }
        if (input[index] !== ",") return fail();
        index += 1;
      }
    }
    if (token === "[") {
      index += 1;
      whitespace();
      const output: unknown[] = [];
      if (input[index] === "]") {
        index += 1;
        return output;
      }
      while (true) {
        if (output.length >= maximumContainerItems) return fail();
        output.push(value(depth + 1));
        whitespace();
        if (input[index] === "]") {
          index += 1;
          return output;
        }
        if (input[index] !== ",") return fail();
        index += 1;
      }
    }
    if (input.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (input.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (input.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const number = input
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number === undefined) return fail();
    index += number.length;
    const parsed = Number(number);
    return Number.isFinite(parsed) ? parsed : fail();
  };

  const parsed = value(0);
  whitespace();
  if (index !== input.length) return fail();
  return parsed;
}

class PiRpcRuntime implements AgentRuntime {
  private readonly decoder: StrictJsonLineDecoder;
  private readonly ready = new Deferred<AgentRuntimeReadyState>();
  private readonly acceptance = new Deferred<AgentPromptAcceptanceOutcome>();
  private readonly eventsQueue = new EventQueue();
  private state: RuntimeState = "attached";
  private outputBytes = 0;
  private attested = false;
  private initializationWriteComplete = false;
  private freshIdleStateObserved = false;
  private initialized = false;
  private preparation?: AgentTurnPreparation;
  private promptCommandId?: string;
  private abortCommandId?: string;
  private abortAcknowledged = false;
  private promptWritten = false;
  private cancelRequested = false;
  private terminalEmitted = false;
  private partialOutputAvailable = false;
  private agentFailure = false;
  private currentMessageId: AgentProtocolMessageId | undefined;
  private messageSequence = 0;
  private protocolFailure?: Error;
  private pumpsStarted = false;

  constructor(
    private readonly process: SupervisorOwnedAgentProcess,
    private readonly options: PiRpcDriverOptions,
  ) {
    this.decoder = new StrictJsonLineDecoder(options.limits.maximumFrameBytes);
  }

  async initialize(): Promise<AgentRuntimeReadyState> {
    if (this.state !== "attached") {
      throw new Error("Pi runtime initialization is one-shot");
    }
    const readiness = this.ready.promise;
    // A protocol failure may reject readiness while the transport write is
    // still pending. Attach a handler now so that inner rejection is never
    // transiently unhandled; callers still receive the original rejection.
    void readiness.catch(() => undefined);
    this.state = "initializing";
    this.startPumps();
    const write = await this.writeCommand({ id: "hitch:init", type: "get_state" });
    if (write.kind !== "complete") {
      const error = new Error("Pi readiness probe was not written completely");
      this.failProtocol(error);
      return readiness;
    }
    this.initializationWriteComplete = true;
    this.completeReadiness();
    return readiness;
  }

  async inspect(): Promise<"idle" | "running" | "waiting" | "closed" | "unknown"> {
    switch (this.state) {
      case "idle":
      case "settled":
        return "idle";
      case "prepared":
        return "waiting";
      case "submitted":
      case "running":
        return "running";
      case "closed":
        return "closed";
      default:
        return "unknown";
    }
  }

  async prepareTurn(preparation: AgentTurnPreparation): Promise<AgentTurnRun> {
    if (this.state !== "idle" || !this.initialized || this.preparation !== undefined) {
      throw new Error("Pi runtime accepts exactly one Turn after readiness");
    }
    if (preparation.inference.turnId !== preparation.turnId) {
      throw new Error("Pi preparation inference is correlated to another Turn");
    }
    if (!Number.isSafeInteger(preparation.attempt) || preparation.attempt <= 0) {
      throw new Error("Pi preparation attempt must be a positive integer");
    }
    if (preparation.prompt.image !== undefined) {
      throw new Error("Pi multi-user MVP accepts text prompts only");
    }
    const promptBytes = encoder.encode(preparation.prompt.text).length;
    if (promptBytes === 0 || promptBytes > this.options.limits.maximumPromptBytes) {
      throw new Error("Pi prompt is empty or exceeds the configured byte limit");
    }
    this.preparation = preparation;
    this.promptCommandId = `hitch:prompt:${preparation.attemptId}`;
    this.state = "prepared";
    return new PiRpcTurnRun(this, preparation);
  }

  async closeProtocol(): Promise<void> {
    if (this.state === "closed") return;
    if (this.preparation !== undefined && !this.terminalEmitted) {
      this.failProtocol(new Error("Pi protocol closed before the terminal barrier"));
    }
    if (!this.ready.isSettled) {
      this.ready.reject(new Error("Pi protocol closed before readiness"));
    }
    if (this.promptWritten && !this.acceptance.isSettled) {
      this.acceptance.resolve(
        frozen({
          kind: "unknown" as const,
          observedAt: this.options.now?.() ?? defaultNow(),
          reason: "Pi protocol closed before prompt acknowledgement",
        }),
      );
    }
    this.state = "closed";
    this.eventsQueue.close();
  }

  async submit(
    preparation: AgentTurnPreparation,
    authorization: ArmedProtocolPromptSubmission,
  ): Promise<ProtocolPromptSubmissionOutcome> {
    if (this.state !== "prepared" || this.preparation !== preparation) {
      throw new Error("Pi prompt submission is not armed for this prepared run");
    }
    if (this.cancelRequested) {
      throw new Error("Pi prompt submission is disarmed after cancellation");
    }
    if (
      authorization.attemptId !== preparation.attemptId ||
      authorization.turnId !== preparation.turnId
    ) {
      throw new Error("Pi prompt authorization correlation mismatch");
    }
    if (this.promptWritten) throw new Error("Pi prompt submission is one-shot");

    this.promptWritten = true;
    this.state = "submitted";
    const result = await this.writeCommand({
      id: this.promptCommandId,
      type: "prompt",
      message: preparation.prompt.text,
    });
    let outcome = writeOutcome(result);
    const correlatedResponse = this.acceptance.value;
    if (
      outcome.kind !== "submitted" &&
      correlatedResponse !== undefined &&
      (correlatedResponse.kind === "accepted" ||
        correlatedResponse.kind === "rejected")
    ) {
      outcome = frozen({
        kind: "submitted" as const,
        submittedAt:
          correlatedResponse.kind === "accepted"
            ? correlatedResponse.acceptedAt
            : correlatedResponse.rejectedAt,
      });
    }
    if (outcome.kind === "submission-unknown") {
      this.acceptance.resolve(
        frozen({
          kind: "unknown" as const,
          observedAt: outcome.failedAt,
          reason: "Pi prompt submission outcome is unknown",
        }),
      );
      this.failProtocol(new Error("Pi prompt submission outcome is unknown"));
    } else if (outcome.kind === "definitely-not-submitted") {
      this.state = "prepared";
    }
    return outcome;
  }

  awaitAcceptance(preparation: AgentTurnPreparation): Promise<AgentPromptAcceptanceOutcome> {
    if (this.preparation !== preparation || !this.promptWritten) {
      throw new Error("Pi prompt acceptance cannot be awaited before submission");
    }
    return this.acceptance.promise;
  }

  eventStream(preparation: AgentTurnPreparation): AsyncIterable<AgentDriverTurnEvent> {
    if (this.preparation !== preparation) {
      throw new Error("Pi event stream correlation mismatch");
    }
    return this.eventsQueue;
  }

  async cancel(preparation: AgentTurnPreparation): Promise<void> {
    if (this.preparation !== preparation) {
      throw new Error("Pi cancellation correlation mismatch");
    }
    if (this.cancelRequested || this.terminalEmitted) return;
    this.cancelRequested = true;
    this.abortCommandId = `hitch:abort:${preparation.attemptId}`;
    const write = await this.writeCommand({ id: this.abortCommandId, type: "abort" });
    if (write.kind !== "complete") {
      this.failProtocol(new Error("Pi abort command was not written completely"));
    }
  }

  reconcile(preparation: AgentTurnPreparation): Promise<AgentTurnReconciliation> {
    if (this.preparation !== preparation) {
      throw new Error("Pi reconciliation correlation mismatch");
    }
    return Promise.resolve(
      frozen({
        kind: "unknown" as const,
        attemptId: preparation.attemptId,
        reason: "Pi MVP reconciliation is unsupported",
      }),
    );
  }

  private async writeCommand(command: Record<string, unknown>): Promise<AgentTransportWriteResult> {
    const frame = encoder.encode(`${JSON.stringify(command)}\n`);
    if (frame.length > this.options.limits.maximumFrameBytes + 1) {
      return frozen({
        kind: "definitely-not-written" as const,
        failedAt: this.options.now?.() ?? defaultNow(),
        reason: "Pi RPC command exceeded the configured frame limit",
      });
    }
    try {
      return await this.process.writeStdin(frame);
    } catch {
      return frozen({
        kind: "write-uncertain" as const,
        failedAt: this.options.now?.() ?? defaultNow(),
        reason: "Pi RPC transport write rejected",
      });
    }
  }

  private startPumps(): void {
    if (this.pumpsStarted) return;
    this.pumpsStarted = true;
    void this.consumeStdout();
    void this.consumeStderr();
    void this.observeExit();
  }

  private completeReadiness(): void {
    if (
      this.initialized ||
      this.state !== "initializing" ||
      this.protocolFailure !== undefined ||
      this.ready.isSettled ||
      !this.initializationWriteComplete ||
      !this.freshIdleStateObserved
    ) {
      return;
    }
    this.initialized = true;
    this.state = "idle";
    this.ready.resolve(
      frozen({ observedAt: this.options.now?.() ?? defaultNow() }),
    );
  }

  private countOutput(bytes: number): void {
    this.outputBytes += bytes;
    if (this.outputBytes > this.options.limits.maximumOutputBytes) {
      this.emitTerminal({ kind: "terminal", terminal: { outcome: "output-limit" }, partialOutputAvailable: this.partialOutputAvailable });
      throw new Error("Pi process output exceeded the configured byte limit");
    }
  }

  private async consumeStdout(): Promise<void> {
    try {
      for await (const chunk of this.process.stdout) {
        this.countOutput(chunk.length);
        for (const frame of this.decoder.accept(chunk)) this.consumeFrame(frame);
      }
      this.decoder.finish();
      if (this.state !== "closed" && !this.terminalEmitted) {
        throw new Error("Pi RPC stdout ended before the terminal barrier");
      }
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error("Pi stdout failed"));
    }
  }

  private async consumeStderr(): Promise<void> {
    try {
      for await (const chunk of this.process.stderr) this.countOutput(chunk.length);
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error("Pi stderr failed"));
    }
  }

  private async observeExit(): Promise<void> {
    try {
      await this.process.observeExit();
      if (this.state === "closed" || this.terminalEmitted) return;
      const observedAt = this.options.now?.() ?? defaultNow();
      if (!this.ready.isSettled) this.ready.reject(new Error("Pi exited before readiness"));
      if (this.promptWritten && !this.acceptance.isSettled) {
        this.acceptance.resolve(
          frozen({
            kind: "unknown" as const,
            observedAt,
            reason: "Pi exited before prompt acknowledgement",
          }),
        );
      }
      if (this.preparation !== undefined) {
        this.emitTerminal({
          kind: "terminal",
          terminal: { outcome: "failed", code: "protocol-error" },
          partialOutputAvailable: this.partialOutputAvailable,
        });
      }
      this.state = "failed";
    } catch (error) {
      this.failProtocol(error instanceof Error ? error : new Error("Pi exit observation failed"));
    }
  }

  private consumeFrame(value: unknown): void {
    const frame = record(value, "Pi RPC frame");
    const type = exactString(frame.type, "Pi RPC frame type");
    if (type === "extension_ui_request") {
      this.consumeAttestation(frame);
      return;
    }
    if (type === "response") {
      this.consumeResponse(frame);
      return;
    }
    this.consumeEvent(type, frame);
  }

  private consumeAttestation(frame: RecordValue): void {
    if (
      this.state !== "initializing" ||
      this.attested ||
      frame.method !== "setStatus" ||
      typeof frame.id !== "string" ||
      frame.id.length === 0 ||
      frame.statusKey !== this.options.toolAttestation.statusKey ||
      frame.statusText !==
        attestationText(this.options.reviewedSupervisorArtifacts)
    ) {
      throw new Error("Pi emitted an unauthorized extension UI request");
    }
    this.attested = true;
  }

  private consumeResponse(frame: RecordValue): void {
    const id = exactString(frame.id, "Pi RPC response id");
    const command = exactString(frame.command, "Pi RPC response command");
    if (typeof frame.success !== "boolean") {
      throw new Error("Pi RPC response success must be boolean");
    }

    if (id === "hitch:init" && command === "get_state") {
      if (
        this.state !== "initializing" ||
        this.initialized ||
        this.freshIdleStateObserved ||
        !this.attested
      ) {
        throw new Error("Pi readiness response arrived outside the attested startup phase");
      }
      const data = record(frame.data, "Pi get_state data");
      if (
        frame.success !== true ||
        data.isStreaming !== false ||
        data.isCompacting !== false ||
        data.pendingMessageCount !== 0 ||
        data.messageCount !== 0 ||
        data.sessionFile !== undefined ||
        typeof data.sessionId !== "string" ||
        data.sessionId.length === 0
      ) {
        throw new Error("Pi get_state did not prove a fresh idle runtime");
      }
      this.freshIdleStateObserved = true;
      this.completeReadiness();
      return;
    }

    if (id === this.promptCommandId && command === "prompt") {
      if (this.state !== "submitted" || this.acceptance.isSettled) {
        throw new Error("Pi prompt response was duplicate or out of phase");
      }
      if (frame.success) {
        this.state = "running";
        this.acceptance.resolve(
          frozen({
            kind: "accepted" as const,
            acceptedAt: this.options.now?.() ?? defaultNow(),
            evidence: frozen({
              kind: "explicit-ack" as const,
              correlation: "dispatched-prompt-request" as const,
            }),
          }),
        );
      } else {
        this.state = "settled";
        this.acceptance.resolve(
          frozen({
            kind: "rejected" as const,
            rejectedAt: this.options.now?.() ?? defaultNow(),
            reason: "Pi rejected the correlated prompt before acceptance",
          }),
        );
        this.emitTerminal({
          kind: "terminal",
          terminal: { outcome: "refused" },
          partialOutputAvailable: false,
        });
      }
      return;
    }

    if (id === this.abortCommandId && command === "abort") {
      if (
        !this.cancelRequested ||
        this.abortAcknowledged ||
        frame.success !== true
      ) {
        throw new Error("Pi abort response was rejected or out of phase");
      }
      this.abortAcknowledged = true;
      return;
    }

    throw new Error("Pi emitted an uncorrelated RPC response");
  }

  private consumeEvent(type: string, frame: RecordValue): void {
    if (this.preparation === undefined || !this.promptWritten) {
      throw new Error("Pi emitted a Turn event before prompt submission");
    }
    switch (type) {
      case "agent_start":
      case "turn_start":
      case "agent_end":
      case "turn_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "compaction_start":
      case "compaction_end":
        return;
      case "message_start":
        this.consumeMessageStart(frame);
        return;
      case "message_update":
        this.consumeMessageUpdate(frame);
        return;
      case "message_end":
        this.consumeMessageEnd(frame);
        return;
      case "tool_execution_start":
        this.consumeToolStart(frame);
        return;
      case "tool_execution_update":
        this.consumeToolUpdate(frame);
        return;
      case "tool_execution_end":
        this.consumeToolEnd(frame);
        return;
      case "extension_error":
        this.agentFailure = true;
        return;
      case "agent_settled":
        if (this.acceptance.value?.kind !== "accepted") {
          if (!this.acceptance.isSettled) {
            this.acceptance.resolve(
              frozen({
                kind: "unknown" as const,
                observedAt: this.options.now?.() ?? defaultNow(),
                reason: "Pi settled without a correlated prompt acknowledgement",
              }),
            );
          }
          this.failProtocol(
            new Error("Pi settled without an accepted prompt acknowledgement"),
          );
          return;
        }
        this.state = "settled";
        this.emitTerminal({
          kind: "terminal",
          terminal: this.cancelRequested
            ? { outcome: "cancelled" }
            : this.agentFailure
              ? { outcome: "failed", code: "agent-error" }
              : { outcome: "completed" },
          partialOutputAvailable: this.partialOutputAvailable,
        });
        return;
      default:
        throw new Error("Pi emitted an unsupported event type");
    }
  }

  private consumeMessageStart(frame: RecordValue): void {
    const message = record(frame.message, "Pi message_start message");
    if (message.role === "user") {
      this.emit({ kind: "user-message-recorded" });
      return;
    }
    if (message.role === "assistant") this.currentMessageId = this.nextMessageId();
  }

  private consumeMessageUpdate(frame: RecordValue): void {
    const update = record(frame.assistantMessageEvent, "Pi assistant message event");
    if (update.type === "text_delta") {
      const text = this.boundedText(update.delta, "Pi assistant text delta");
      this.partialOutputAvailable ||= text.length > 0;
      this.emit({
        kind: "agent-message-chunk",
        protocolMessageId: this.currentMessageId ?? this.nextMessageId(),
        text,
      });
      return;
    }
    if (update.type === "error") this.agentFailure = update.reason !== "aborted";
  }

  private consumeMessageEnd(frame: RecordValue): void {
    const message = record(frame.message, "Pi message_end message");
    if (message.role !== "assistant") return;
    const text = this.extractAssistantText(message.content);
    const stopReason = message.stopReason;
    if (stopReason === "error") this.agentFailure = true;
    if (stopReason === "aborted" && !this.cancelRequested) this.agentFailure = true;
    if (text.length > 0) {
      this.partialOutputAvailable = true;
      this.emit({
        kind: "agent-message-finalized",
        protocolMessageId: this.currentMessageId ?? this.nextMessageId(),
        text,
      });
    }
    this.currentMessageId = undefined;
  }

  private consumeToolStart(frame: RecordValue): void {
    const tool = this.toolIdentity(frame);
    this.emit({
      kind: "tool-invocation-update",
      protocolToolCallId: tool.id,
      title: tool.name,
      status: "in-progress",
    });
  }

  private consumeToolUpdate(frame: RecordValue): void {
    this.toolIdentity(frame);
  }

  private consumeToolEnd(frame: RecordValue): void {
    const tool = this.toolIdentity(frame);
    if (typeof frame.isError !== "boolean") {
      throw new Error("Pi tool completion is missing isError");
    }
    this.emit({
      kind: "tool-invocation-finalized",
      protocolToolCallId: tool.id,
      title: tool.name,
      status: frame.isError ? "failed" : "completed",
    });
  }

  private toolIdentity(frame: RecordValue): {
    readonly id: AgentProtocolToolCallId;
    readonly name: string;
  } {
    const id = exactString(frame.toolCallId, "Pi tool call id");
    const name = exactString(frame.toolName, "Pi tool name");
    if (!WORKSPACE_TOOLS.has(name)) {
      throw new Error("Pi attempted a tool outside the reviewed workspace allowlist");
    }
    return frozen({
      id: id as AgentProtocolToolCallId,
      name,
    });
  }

  private extractAssistantText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const item of content) {
      const block = record(item, "Pi assistant content block");
      if (block.type === "text") {
        parts.push(this.boundedText(block.text, "Pi assistant final text"));
      }
    }
    return this.boundedText(parts.join(""), "Pi assistant finalized text");
  }

  private boundedText(value: unknown, label: string): string {
    if (typeof value !== "string") throw new Error(`${label} must be a string`);
    if (encoder.encode(value).length > this.options.limits.maximumEventTextBytes) {
      throw new Error(`${label} exceeded the configured byte limit`);
    }
    return value;
  }

  private nextMessageId(): AgentProtocolMessageId {
    this.messageSequence += 1;
    const id = `pi:${this.preparation?.attemptId ?? "unprepared"}:${this.messageSequence}`;
    this.currentMessageId = id as AgentProtocolMessageId;
    return this.currentMessageId;
  }

  private emit(payload: AgentDriverTurnEventPayload): void {
    this.eventsQueue.push(
      frozen({ observedAt: this.options.now?.() ?? defaultNow(), payload: frozen(payload) }),
    );
  }

  private emitTerminal(payload: Extract<AgentDriverTurnEventPayload, { kind: "terminal" }>): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.emit(payload);
    this.eventsQueue.close();
  }

  private failProtocol(error: Error): void {
    if (this.protocolFailure !== undefined || this.state === "closed") return;
    this.protocolFailure = error;
    this.state = "failed";
    if (!this.ready.isSettled) this.ready.reject(error);
    if (this.promptWritten && !this.acceptance.isSettled) {
      this.acceptance.resolve(
        frozen({
          kind: "unknown" as const,
          observedAt: this.options.now?.() ?? defaultNow(),
          reason: "Pi protocol failed before prompt acknowledgement",
        }),
      );
    }
    if (this.preparation !== undefined) {
      this.emitTerminal({
        kind: "terminal",
        terminal: { outcome: "failed", code: "protocol-error" },
        partialOutputAvailable: this.partialOutputAvailable,
      });
    } else {
      this.eventsQueue.fail(error);
    }
  }
}

class PiRpcTurnRun implements AgentTurnRun {
  readonly attemptId: AgentDispatchAttemptId;
  readonly turnId: AgentTurnPreparation["turnId"];

  constructor(
    private readonly runtime: PiRpcRuntime,
    private readonly preparation: AgentTurnPreparation,
  ) {
    this.attemptId = preparation.attemptId;
    this.turnId = preparation.turnId;
  }

  submitProtocolPrompt(
    authorization: ArmedProtocolPromptSubmission,
  ): Promise<ProtocolPromptSubmissionOutcome> {
    return this.runtime.submit(this.preparation, authorization);
  }

  awaitPromptAcceptance(): Promise<AgentPromptAcceptanceOutcome> {
    return this.runtime.awaitAcceptance(this.preparation);
  }

  events(): AsyncIterable<AgentDriverTurnEvent> {
    return this.runtime.eventStream(this.preparation);
  }

  respondToInteraction(
    response: SendStartedAgentInteractionResponse,
  ): Promise<{ readonly kind: "duplicate-rejected"; readonly responseDispatchId: typeof response.responseDispatchId }> {
    return Promise.resolve(
      frozen({ kind: "duplicate-rejected" as const, responseDispatchId: response.responseDispatchId }),
    );
  }

  cancel(_reason: string): Promise<void> {
    return this.runtime.cancel(this.preparation);
  }

  reconcile(): Promise<AgentTurnReconciliation> {
    return this.runtime.reconcile(this.preparation);
  }
}

export function createPiRpcDriver(options: PiRpcDriverOptions): AgentDriverDefinition {
  finitePositiveInteger(options.limits.maximumFrameBytes, "maximumFrameBytes");
  finitePositiveInteger(options.limits.maximumOutputBytes, "maximumOutputBytes");
  finitePositiveInteger(options.limits.maximumPromptBytes, "maximumPromptBytes");
  finitePositiveInteger(options.limits.maximumEventTextBytes, "maximumEventTextBytes");
  if (options.limits.maximumPromptBytes > options.limits.maximumFrameBytes) {
    throw new Error("maximumPromptBytes cannot exceed maximumFrameBytes");
  }
  exactString(options.toolAttestation.statusKey, "tool attestation statusKey");
  if (
    options.reviewedSupervisorArtifacts.length !== 2 ||
    options.reviewedSupervisorArtifacts[0]?.kind !==
      "workspace-tools-extension" ||
    options.reviewedSupervisorArtifacts[0].sandboxPath !==
      WORKSPACE_TOOLS_EXTENSION_PATH ||
    options.reviewedSupervisorArtifacts[1]?.kind !== "workspace-tools-addon" ||
    options.reviewedSupervisorArtifacts[1].sandboxPath !==
      WORKSPACE_TOOLS_ADDON_PATH
  ) {
    throw new Error("Pi workspace-tool artifacts do not match fixed sandbox destinations");
  }
  for (const artifact of options.reviewedSupervisorArtifacts) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(artifact.integrityDigest)) {
      throw new Error("Pi workspace-tool artifact digest is invalid");
    }
  }

  const reviewedSupervisorArtifacts = frozen(
    options.reviewedSupervisorArtifacts.map((artifact) =>
      frozen({
        kind: artifact.kind,
        integrityDigest: artifact.integrityDigest,
        sandboxPath: artifact.sandboxPath,
      }),
    ),
  ) as unknown as PiRpcDriverOptions["reviewedSupervisorArtifacts"];

  const trustedOptions: PiRpcDriverOptions = frozen(
    options.now === undefined
      ? {
          driverId: options.driverId,
          launchProfileId: options.launchProfileId,
          toolAttestation: frozen({
            statusKey: options.toolAttestation.statusKey,
          }),
          reviewedSupervisorArtifacts,
          limits: frozen({ ...options.limits }),
        }
      : {
          driverId: options.driverId,
          launchProfileId: options.launchProfileId,
          toolAttestation: frozen({
            statusKey: options.toolAttestation.statusKey,
          }),
          reviewedSupervisorArtifacts,
          limits: frozen({ ...options.limits }),
          now: options.now,
        },
  );

  const capabilities = frozen({
    protocol: "pi-rpc" as const,
    promptAcceptance: "explicit-protocol-ack" as const,
    eventCorrelation: "prepared-turn-run" as const,
    resume: "unsupported" as const,
    reconciliation: "unsupported" as const,
    interactions: frozen({ approval: "unsupported" as const, structuredInput: "unsupported" as const }),
    inference: frozen({
      executionModes: ["native-library-sidecar"] as const,
      credentialFreeNativeBridge: "supported" as const,
    }),
    resources: frozen({
      skills: "unsupported" as const,
      promptTemplates: "unsupported" as const,
      themes: "unsupported" as const,
      extensions: "unsupported" as const,
      projectAutoDiscovery: false as const,
      hotReload: false as const,
    }),
  });

  return frozen({
    id: trustedOptions.driverId,
    capabilities,
    validateProfile(profile: AgentProfileRevision): AgentProfileValidationResult {
      const issues: Array<{ readonly path: string; readonly code: string; readonly message: string }> = [];
      if (profile.driverId !== trustedOptions.driverId) {
        issues.push({ path: "driverId", code: "driver-mismatch", message: "profile selects another driver" });
      }
      if (Object.keys(profile.configuration).length !== 0) {
        issues.push({ path: "configuration", code: "unsupported-configuration", message: "Pi MVP profile configuration must be empty" });
      }
      const declarativePolicies = [
        ["skills", profile.resourcePolicy.skills],
        ["promptTemplates", profile.resourcePolicy.promptTemplates],
        ["themes", profile.resourcePolicy.themes],
      ] as const;
      for (const [name, policy] of declarativePolicies) {
        if (
          policy.mode !== "disabled"
        ) {
          issues.push({
            path: `resourcePolicy.${name}`,
            code: "ambient-resource-authority",
            message: "Pi MVP defers profile declarative resources",
          });
        }
      }
      if (
        profile.resourcePolicy.extensions.mode !== "disabled"
      ) {
        issues.push({ path: "resourcePolicy.extensions", code: "profile-extension-authority", message: "Pi MVP defers profile extensions" });
      }
      if (
        profile.agentResourceSnapshotIds.length !== 0 ||
        profile.extensionGrantSnapshotIds.length !== 0
      ) {
        issues.push({
          path: "agentResourceSnapshotIds",
          code: "profile-resource-authority",
          message: "Pi MVP profile resource and extension sets must be empty",
        });
      }
      if (issues.length > 0) return frozen({ accepted: false as const, issues: frozen(issues) });
      return frozen({
        accepted: true as const,
        configuration: frozen({}) as SanitizedAgentProfileConfiguration,
      });
    },
    projectLaunch(
      configuration: SanitizedAgentRuntimeConfiguration,
      mode: AgentLaunchMode,
    ): AgentLaunchProjection {
      if (configuration.driverId !== trustedOptions.driverId) throw new Error("Pi runtime configuration selects another driver");
      if (mode.kind !== "fresh") throw new Error("Pi multi-user MVP does not support resume");
      if (configuration.workingDirectory !== WORKSPACE_PATH) {
        throw new Error("Pi multi-user MVP working directory must be /workspace");
      }
      if (
        Object.keys(configuration.profileConfiguration).length !== 0 ||
        configuration.resources.length !== 0
      ) {
        throw new Error("Pi multi-user MVP rejects profile resources and extensions");
      }
      return frozen({
        launchProfileId: trustedOptions.launchProfileId,
        mode: frozen({ kind: "fresh" as const }),
        workingDirectory: configuration.workingDirectory,
        configurationFiles: frozen([]),
        reviewedSupervisorArtifacts: trustedOptions.reviewedSupervisorArtifacts,
        resources: frozen([]),
      });
    },
    attach(process: SupervisorOwnedAgentProcess): Promise<AgentRuntime> {
      return Promise.resolve(new PiRpcRuntime(process, trustedOptions));
    },
  });
}

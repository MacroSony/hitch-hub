import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentRuntime,
  AgentTransportWriteResult,
  AgentTurnPreparation,
  ArmedProtocolPromptSubmission,
  ReviewedSupervisorAgentArtifact,
  SupervisorOwnedAgentProcess,
} from "../../model/agent-runtime.js";
import type {
  AgentDispatchAttemptId,
  AgentDriverId,
  AgentDriverLaunchProfileId,
  AgentResumeHandleId,
  Base64Payload,
  IsoTimestamp,
  ModelId,
  ProviderId,
  TurnId,
} from "../../model/primitives.js";
import type { SanitizedAgentRuntimeConfiguration } from "../../model/runtime-security.js";
import type { AgentProfileRevision } from "../../model/session.js";
import { createPiRpcDriver } from "./index.js";

const NOW = "2026-08-09T00:00:00.000Z" as IsoTimestamp;
const DRIVER_ID = "AgentDriver:pi-082" as AgentDriverId;
const LAUNCH_PROFILE_ID =
  "AgentDriverLaunchProfile:pi-082" as AgentDriverLaunchProfileId;
const REVIEWED_ARTIFACTS = Object.freeze([
  Object.freeze({
    kind: "workspace-tools-extension" as const,
    integrityDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sandboxPath: "/hitch-runtime/workspace-tools.mjs",
  }),
  Object.freeze({
    kind: "workspace-tools-addon" as const,
    integrityDigest:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sandboxPath: "/hitch-runtime/workspace-tools.node",
  }),
]) as unknown as readonly [
  ReviewedSupervisorAgentArtifact & { readonly kind: "workspace-tools-extension" },
  ReviewedSupervisorAgentArtifact & { readonly kind: "workspace-tools-addon" },
];
const ATTESTATION = Object.freeze({
  statusKey: "hitch.workspace-tools",
  statusText:
    "hitch-workspace-tools extension=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa addon=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

class AsyncByteStream implements AsyncIterable<Uint8Array> {
  private readonly buffered: Uint8Array[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<Uint8Array>) => void
  > = [];
  private ended = false;

  push(bytes: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value: bytes });
    else this.buffered.push(bytes);
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const value = this.buffered.shift();
        if (value !== undefined) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class FakeProcess implements SupervisorOwnedAgentProcess {
  readonly stdout = new AsyncByteStream();
  readonly stderr = new AsyncByteStream();
  readonly writes: Uint8Array[] = [];
  nextWriteResult: AgentTransportWriteResult | undefined;
  nextWritePromise: Promise<AgentTransportWriteResult> | undefined;
  private readonly exitPromise: Promise<{
    readonly exitCode?: number;
    readonly signal?: string;
    readonly observedAt: IsoTimestamp;
  }>;
  private resolveExit!: (exit: {
    readonly exitCode?: number;
    readonly signal?: string;
    readonly observedAt: IsoTimestamp;
  }) => void;

  constructor() {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  writeStdin(frame: Uint8Array): Promise<AgentTransportWriteResult> {
    this.writes.push(frame.slice());
    if (this.nextWritePromise !== undefined) {
      const pending = this.nextWritePromise;
      this.nextWritePromise = undefined;
      return pending;
    }
    const result =
      this.nextWriteResult ??
      ({ kind: "complete", completedAt: NOW } as const);
    this.nextWriteResult = undefined;
    return Promise.resolve(result);
  }

  observeExit(): Promise<{
    readonly exitCode?: number;
    readonly signal?: string;
    readonly observedAt: IsoTimestamp;
  }> {
    return this.exitPromise;
  }

  emit(value: unknown, crlf = false): void {
    const ending = crlf ? "\r\n" : "\n";
    this.stdout.push(new TextEncoder().encode(`${JSON.stringify(value)}${ending}`));
  }

  emitRaw(bytes: Uint8Array): void {
    this.stdout.push(bytes);
  }

  exit(exitCode = 0): void {
    this.stdout.close();
    this.stderr.close();
    this.resolveExit({ exitCode, observedAt: NOW });
  }

  decodedWrites(): readonly Record<string, unknown>[] {
    return this.writes.map((wire) =>
      JSON.parse(new TextDecoder().decode(wire).trimEnd()) as Record<
        string,
        unknown
      >,
    );
  }
}

function driver(limits: Partial<{
  maximumFrameBytes: number;
  maximumOutputBytes: number;
  maximumPromptBytes: number;
  maximumEventTextBytes: number;
}> = {}) {
  return createPiRpcDriver({
    driverId: DRIVER_ID,
    launchProfileId: LAUNCH_PROFILE_ID,
    toolAttestation: { statusKey: ATTESTATION.statusKey },
    reviewedSupervisorArtifacts: REVIEWED_ARTIFACTS,
    limits: {
      maximumFrameBytes: limits.maximumFrameBytes ?? 8_192,
      maximumOutputBytes: limits.maximumOutputBytes ?? 64_000,
      maximumPromptBytes: limits.maximumPromptBytes ?? 4_096,
      maximumEventTextBytes: limits.maximumEventTextBytes ?? 4_096,
    },
    now: () => NOW,
  });
}

function validProfile(): AgentProfileRevision {
  return {
    id: "AgentProfileRevision:test",
    profileId: "AgentProfile:test",
    revision: 1,
    driverId: DRIVER_ID,
    displayName: "Pi",
    providers: [],
    defaultReasoning: { kind: "agent-default" },
    resourcePolicy: {
      skills: { mode: "disabled" },
      promptTemplates: { mode: "disabled" },
      themes: { mode: "disabled" },
      extensions: { mode: "disabled" },
    },
    agentResourceSnapshotIds: [],
    extensionGrantSnapshotIds: [],
    configuration: {},
    createdAt: NOW,
  } as unknown as AgentProfileRevision;
}

function stateResponse(): Record<string, unknown> {
  return {
    id: "hitch:init",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      isStreaming: false,
      isCompacting: false,
      sessionId: "fresh-pi-session",
      messageCount: 0,
      pendingMessageCount: 0,
    },
  };
}

function attestation(): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id: "workspace-tools-ready",
    method: "setStatus",
    ...ATTESTATION,
  };
}

async function attachedReady(): Promise<{
  readonly runtime: AgentRuntime;
  readonly process: FakeProcess;
}> {
  const process = new FakeProcess();
  const runtime = await driver().attach(process);
  const initializing = runtime.initialize();
  process.emit(attestation());
  process.emit(stateResponse());
  assert.deepEqual(await initializing, { observedAt: NOW });
  return { runtime, process };
}

function preparation(text = "Inspect the workspace"): AgentTurnPreparation {
  const turnId = "Turn:test" as TurnId;
  const attemptId = "AgentDispatchAttempt:test" as AgentDispatchAttemptId;
  return {
    attemptId,
    attempt: 1,
    turnId,
    prompt: { text },
    inference: {
      turnId,
      selection: {
        kind: "resolved" as const,
        providerId: "Provider:test" as ProviderId,
        modelId: "Model:test" as ModelId,
      },
      reasoning: { kind: "agent-default" as const },
    },
  };
}

function armed(input = preparation()): ArmedProtocolPromptSubmission {
  return {
    attemptId: input.attemptId,
    turnId: input.turnId,
    armedAt: NOW,
  } as ArmedProtocolPromptSubmission;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("Pi driver publishes the closed MVP capability and launch surface", () => {
  const definition = driver();
  assert.deepEqual(definition.capabilities, {
    protocol: "pi-rpc",
    promptAcceptance: "explicit-protocol-ack",
    eventCorrelation: "prepared-turn-run",
    resume: "unsupported",
    reconciliation: "unsupported",
    interactions: { approval: "unsupported", structuredInput: "unsupported" },
    inference: {
      executionModes: ["native-library-sidecar"],
      credentialFreeNativeBridge: "supported",
    },
    resources: {
      skills: "unsupported",
      promptTemplates: "unsupported",
      themes: "unsupported",
      extensions: "unsupported",
      projectAutoDiscovery: false,
      hotReload: false,
    },
  });
  assert.equal(definition.validateProfile(validProfile()).accepted, true);
  assert.equal(
    definition.validateProfile({
      ...validProfile(),
      configuration: { command: "/bin/sh" },
    }).accepted,
    false,
  );

  const configuration = {
    driverId: DRIVER_ID,
    workingDirectory: "/workspace",
    providers: [{}],
    resources: [],
    profileConfiguration: {},
  } as unknown as SanitizedAgentRuntimeConfiguration;
  assert.deepEqual(definition.projectLaunch(configuration, { kind: "fresh" }), {
    launchProfileId: LAUNCH_PROFILE_ID,
    mode: { kind: "fresh" },
    workingDirectory: "/workspace",
    configurationFiles: [],
    reviewedSupervisorArtifacts: REVIEWED_ARTIFACTS,
    resources: [],
  });
  assert.throws(
    () =>
      definition.projectLaunch(configuration, {
        kind: "resume",
        resumeHandleId: "AgentResumeHandle:test" as AgentResumeHandleId,
      }),
    /does not support resume/,
  );
  assert.throws(
    () =>
      definition.projectLaunch(
        {
          ...configuration,
          workingDirectory: "/tmp",
        } as SanitizedAgentRuntimeConfiguration,
        { kind: "fresh" },
      ),
    /must be \/workspace/,
  );
  assert.throws(
    () =>
      definition.projectLaunch(
        {
          ...configuration,
          resources: [{}],
        } as unknown as SanitizedAgentRuntimeConfiguration,
        { kind: "fresh" },
      ),
    /rejects profile resources/,
  );
});

test("Pi readiness requires the one-shot tool attestation before fresh idle state", async () => {
  const process = new FakeProcess();
  const runtime = await driver().attach(process);
  const initializing = runtime.initialize();
  await tick();
  assert.deepEqual(process.decodedWrites(), [{ id: "hitch:init", type: "get_state" }]);

  process.emit(attestation(), true);
  process.emit(stateResponse(), true);
  assert.deepEqual(await initializing, { observedAt: NOW });
  assert.equal(await runtime.inspect(), "idle");
  await assert.rejects(() => runtime.initialize(), /one-shot/);
});

test("Pi readiness fails closed when state precedes attestation or UI is duplicated", async () => {
  const first = new FakeProcess();
  const runtime = await driver().attach(first);
  const initializing = runtime.initialize();
  first.emit(stateResponse());
  await assert.rejects(initializing, /attested startup phase/);

  const second = await attachedReady();
  second.process.emit(attestation());
  await tick();
  assert.equal(await second.runtime.inspect(), "unknown");
});

test("Pi readiness gates complete transport write and exact fresh ephemeral state", async () => {
  const delayed = new FakeProcess();
  const write = deferred<AgentTransportWriteResult>();
  delayed.nextWritePromise = write.promise;
  const delayedRuntime = await driver().attach(delayed);
  const initializing = delayedRuntime.initialize();
  delayed.emit(attestation());
  delayed.emit(stateResponse());
  let ready = false;
  void initializing.then(
    () => {
      ready = true;
    },
    () => undefined,
  );
  await tick();
  assert.equal(ready, false);
  write.resolve({
    kind: "definitely-not-written",
    failedAt: NOW,
    reason: "closed stdin",
  });
  await assert.rejects(initializing, /not written completely/);

  for (const invalidState of [
    { ...stateResponse(), data: { ...stateResponse().data as object, messageCount: 1 } },
    {
      ...stateResponse(),
      data: {
        ...stateResponse().data as object,
        sessionFile: "/hitch-state/resumed.jsonl",
      },
    },
  ]) {
    const process = new FakeProcess();
    const runtime = await driver().attach(process);
    const start = runtime.initialize();
    process.emit(attestation());
    process.emit(invalidState);
    await assert.rejects(start, /fresh idle runtime/);
  }
});

test("Pi delayed initialization completion cannot resurrect a failed or closed runtime", async () => {
  const disruptions = [
    (process: FakeProcess, _runtime: AgentRuntime): void => {
      process.stdout.close();
    },
    (process: FakeProcess, _runtime: AgentRuntime): void => {
      process.emit(attestation());
    },
    (_process: FakeProcess, runtime: AgentRuntime): Promise<void> =>
      runtime.closeProtocol(),
  ] as const;

  for (const disrupt of disruptions) {
    const process = new FakeProcess();
    const write = deferred<AgentTransportWriteResult>();
    process.nextWritePromise = write.promise;
    const runtime = await driver().attach(process);
    const initializing = runtime.initialize();
    const rejected = assert.rejects(initializing);
    process.emit(attestation());
    process.emit(stateResponse());
    await disrupt(process, runtime);
    await tick();
    write.resolve({ kind: "complete", completedAt: NOW });
    await rejected;
    assert.notEqual(await runtime.inspect(), "idle");
    await assert.rejects(
      () => runtime.prepareTurn(preparation()),
      /exactly one Turn after readiness/,
    );
  }
});

test("Pi prompt acknowledgement is exact and terminal waits for agent_settled", async () => {
  const { runtime, process } = await attachedReady();
  const input = preparation();
  const run = await runtime.prepareTurn(input);
  assert.deepEqual(await run.submitProtocolPrompt(armed(input)), {
    kind: "submitted",
    submittedAt: NOW,
  });
  assert.deepEqual(process.decodedWrites().at(-1), {
    id: `hitch:prompt:${input.attemptId}`,
    type: "prompt",
    message: input.prompt.text,
  });

  process.emit({
    id: `hitch:prompt:${input.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  assert.deepEqual(await run.awaitPromptAcceptance(), {
    kind: "accepted",
    acceptedAt: NOW,
    evidence: {
      kind: "explicit-ack",
      correlation: "dispatched-prompt-request",
    },
  });

  const events = run.events()[Symbol.asyncIterator]();
  process.emit({ type: "message_start", message: { role: "assistant" } });
  process.emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "hello\u2028world" },
  });
  process.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello\u2028world" }],
      stopReason: "stop",
    },
  });
  process.emit({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "read",
    args: { path: "/workspace/private" },
  });
  process.emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "must not escape" }] },
    isError: false,
  });
  process.emit({ type: "agent_end", messages: [], willRetry: true });

  assert.equal((await events.next()).value?.payload.kind, "agent-message-chunk");
  assert.equal((await events.next()).value?.payload.kind, "agent-message-finalized");
  assert.deepEqual((await events.next()).value?.payload, {
    kind: "tool-invocation-update",
    protocolToolCallId: "call-1",
    title: "read",
    status: "in-progress",
  });
  assert.deepEqual((await events.next()).value?.payload, {
    kind: "tool-invocation-finalized",
    protocolToolCallId: "call-1",
    title: "read",
    status: "completed",
  });

  let terminalReady = false;
  const terminal = events.next().then((value) => {
    terminalReady = true;
    return value;
  });
  await tick();
  assert.equal(terminalReady, false, "agent_end must not terminalize a retrying run");
  process.emit({ type: "agent_settled" });
  assert.deepEqual((await terminal).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "completed" },
    partialOutputAvailable: true,
  });
  assert.deepEqual(await events.next(), { done: true, value: undefined });
});

test("Pi cancellation emits one correlated abort and settles cancelled", async () => {
  const { runtime, process } = await attachedReady();
  const input = preparation();
  const run = await runtime.prepareTurn(input);
  await run.submitProtocolPrompt(armed(input));
  process.emit({
    id: `hitch:prompt:${input.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  await run.awaitPromptAcceptance();

  await run.cancel("operator cancellation");
  await run.cancel("duplicate cancellation");
  assert.deepEqual(process.decodedWrites().filter((wire) => wire.type === "abort"), [
    { id: `hitch:abort:${input.attemptId}`, type: "abort" },
  ]);
  process.emit({
    id: `hitch:abort:${input.attemptId}`,
    type: "response",
    command: "abort",
    success: true,
  });
  process.emit({ type: "agent_settled" });
  const events = run.events()[Symbol.asyncIterator]();
  assert.deepEqual((await events.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "cancelled" },
    partialOutputAvailable: false,
  });
});

test("Pi cancellation permanently disarms a prepared prompt under call races", async () => {
  const first = await attachedReady();
  const firstInput = preparation();
  const firstRun = await first.runtime.prepareTurn(firstInput);
  const cancelling = firstRun.cancel("cancel before durable submission");
  await assert.rejects(
    () => firstRun.submitProtocolPrompt(armed(firstInput)),
    /disarmed after cancellation/,
  );
  await cancelling;
  assert.deepEqual(first.process.decodedWrites().map((frame) => frame.type), [
    "get_state",
    "abort",
  ]);

  const second = await attachedReady();
  const secondInput = preparation();
  const secondRun = await second.runtime.prepareTurn(secondInput);
  const promptWrite = deferred<AgentTransportWriteResult>();
  second.process.nextWritePromise = promptWrite.promise;
  const submitting = secondRun.submitProtocolPrompt(armed(secondInput));
  const cancelAfterSubmission = secondRun.cancel("cancel after prompt write began");
  promptWrite.resolve({ kind: "complete", completedAt: NOW });
  assert.equal((await submitting).kind, "submitted");
  await cancelAfterSubmission;
  assert.deepEqual(second.process.decodedWrites().map((frame) => frame.type), [
    "get_state",
    "prompt",
    "abort",
  ]);
});

test("Pi exact response replays fail the active run", async () => {
  const promptReplay = await attachedReady();
  const promptInput = preparation();
  const promptRun = await promptReplay.runtime.prepareTurn(promptInput);
  await promptRun.submitProtocolPrompt(armed(promptInput));
  const promptResponse = {
    id: `hitch:prompt:${promptInput.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  };
  promptReplay.process.emit(promptResponse);
  await promptRun.awaitPromptAcceptance();
  promptReplay.process.emit(promptResponse);
  const promptEvents = promptRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await promptEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "failed", code: "protocol-error" },
    partialOutputAvailable: false,
  });

  const abortReplay = await attachedReady();
  const abortInput = preparation();
  const abortRun = await abortReplay.runtime.prepareTurn(abortInput);
  await abortRun.submitProtocolPrompt(armed(abortInput));
  abortReplay.process.emit({
    id: `hitch:prompt:${abortInput.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  await abortRun.awaitPromptAcceptance();
  await abortRun.cancel("cancel");
  const abortResponse = {
    id: `hitch:abort:${abortInput.attemptId}`,
    type: "response",
    command: "abort",
    success: true,
  };
  abortReplay.process.emit(abortResponse);
  abortReplay.process.emit(abortResponse);
  const abortEvents = abortRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await abortEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "failed", code: "protocol-error" },
    partialOutputAvailable: false,
  });
});

test("Pi stdout EOF and logical close fail every nonterminal lifecycle phase", async () => {
  const duringInit = new FakeProcess();
  const initRuntime = await driver().attach(duringInit);
  const initializing = initRuntime.initialize();
  duringInit.stdout.close();
  await assert.rejects(initializing, /stdout ended/);

  const idle = await attachedReady();
  idle.process.stdout.close();
  await tick();
  assert.equal(await idle.runtime.inspect(), "unknown");

  const prepared = await attachedReady();
  const preparedInput = preparation();
  const preparedRun = await prepared.runtime.prepareTurn(preparedInput);
  prepared.process.stdout.close();
  const preparedEvents = preparedRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await preparedEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "failed", code: "protocol-error" },
    partialOutputAvailable: false,
  });

  const submitted = await attachedReady();
  const submittedInput = preparation();
  const submittedRun = await submitted.runtime.prepareTurn(submittedInput);
  await submittedRun.submitProtocolPrompt(armed(submittedInput));
  submitted.process.stdout.close();
  assert.equal((await submittedRun.awaitPromptAcceptance()).kind, "unknown");
  const submittedEvents = submittedRun.events()[Symbol.asyncIterator]();
  assert.equal(
    (await submittedEvents.next()).value?.payload.kind,
    "terminal",
  );

  const accepted = await attachedReady();
  const acceptedInput = preparation();
  const acceptedRun = await accepted.runtime.prepareTurn(acceptedInput);
  await acceptedRun.submitProtocolPrompt(armed(acceptedInput));
  accepted.process.emit({
    id: `hitch:prompt:${acceptedInput.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  await acceptedRun.awaitPromptAcceptance();
  accepted.process.stdout.close();
  const acceptedEvents = acceptedRun.events()[Symbol.asyncIterator]();
  assert.equal((await acceptedEvents.next()).value?.payload.kind, "terminal");

  const closed = await attachedReady();
  const closedInput = preparation();
  const closedRun = await closed.runtime.prepareTurn(closedInput);
  await closedRun.submitProtocolPrompt(armed(closedInput));
  closed.process.emit({
    id: `hitch:prompt:${closedInput.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  await closedRun.awaitPromptAcceptance();
  await closed.runtime.closeProtocol();
  const closedEvents = closedRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await closedEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "failed", code: "protocol-error" },
    partialOutputAvailable: false,
  });
  assert.equal(await closed.runtime.inspect(), "closed");
});

test("Pi JSONL rejects duplicates, invalid UTF-8, empty, and unterminated frames", async () => {
  const invalidFrames = [
    {
      bytes: new TextEncoder().encode(
        '{"type":"extension_ui_request","type":"response"}\n',
      ),
      close: false,
    },
    { bytes: Uint8Array.from([0xc3, 0x28, 0x0a]), close: false },
    { bytes: Uint8Array.from([0x0a]), close: false },
    {
      bytes: new TextEncoder().encode(JSON.stringify(attestation())),
      close: true,
    },
  ];
  for (const invalid of invalidFrames) {
    const process = new FakeProcess();
    const runtime = await driver().attach(process);
    const initializing = runtime.initialize();
    process.emitRaw(invalid.bytes);
    if (invalid.close) process.stdout.close();
    await assert.rejects(initializing);
  }
});

test("Pi reconciliation and unsupported interactions perform no protocol I/O", async () => {
  const { runtime, process } = await attachedReady();
  const input = preparation();
  const run = await runtime.prepareTurn(input);
  const before = process.writes.length;
  assert.deepEqual(await run.reconcile(), {
    kind: "unknown",
    attemptId: input.attemptId,
    reason: "Pi MVP reconciliation is unsupported",
  });
  const response = {
    responseDispatchId: "TurnInteractionResponse:test",
  } as unknown as Parameters<typeof run.respondToInteraction>[0];
  assert.deepEqual(await run.respondToInteraction(response), {
    kind: "duplicate-rejected",
    responseDispatchId: "TurnInteractionResponse:test",
  });
  assert.equal(process.writes.length, before);
});

test("Pi framing, tool selection, output, and submission ambiguity fail closed", async () => {
  const ambiguous = await attachedReady();
  const ambiguousInput = preparation();
  const ambiguousRun = await ambiguous.runtime.prepareTurn(ambiguousInput);
  ambiguous.process.nextWriteResult = {
    kind: "write-uncertain",
    failedAt: NOW,
    reason: "partial write",
  };
  assert.deepEqual(await ambiguousRun.submitProtocolPrompt(armed(ambiguousInput)), {
    kind: "submission-unknown",
    failedAt: NOW,
    reason: "agent transport could not prove prompt submission",
  });
  assert.equal((await ambiguousRun.awaitPromptAcceptance()).kind, "unknown");
  const ambiguousEvents = ambiguousRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await ambiguousEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "failed", code: "protocol-error" },
    partialOutputAvailable: false,
  });
  ambiguous.process.emit({ type: "agent_settled" });
  await tick();
  assert.equal(await ambiguous.runtime.inspect(), "unknown");

  const unsafe = await attachedReady();
  const unsafeInput = preparation();
  const unsafeRun = await unsafe.runtime.prepareTurn(unsafeInput);
  await unsafeRun.submitProtocolPrompt(armed(unsafeInput));
  unsafe.process.emit({
    id: `hitch:prompt:${unsafeInput.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  await unsafeRun.awaitPromptAcceptance();
  unsafe.process.emit({
    type: "tool_execution_start",
    toolCallId: "call-shell",
    toolName: "bash",
    args: { command: "id" },
  });
  const unsafeEvents = unsafeRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await unsafeEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "failed", code: "protocol-error" },
    partialOutputAvailable: false,
  });

  const limitedProcess = new FakeProcess();
  const limitedRuntime = await driver({ maximumOutputBytes: 1_000 }).attach(
    limitedProcess,
  );
  const limitedInit = limitedRuntime.initialize();
  limitedProcess.emit(attestation());
  limitedProcess.emit(stateResponse());
  await limitedInit;
  const limitedInput = preparation();
  const limitedRun = await limitedRuntime.prepareTurn(limitedInput);
  await limitedRun.submitProtocolPrompt(armed(limitedInput));
  limitedProcess.emit({
    id: `hitch:prompt:${limitedInput.attemptId}`,
    type: "response",
    command: "prompt",
    success: true,
  });
  await limitedRun.awaitPromptAcceptance();
  limitedProcess.stderr.push(new Uint8Array(1_001));
  const limitedEvents = limitedRun.events()[Symbol.asyncIterator]();
  assert.deepEqual((await limitedEvents.next()).value?.payload, {
    kind: "terminal",
    terminal: { outcome: "output-limit" },
    partialOutputAvailable: false,
  });

  const malformedProcess = new FakeProcess();
  const malformedRuntime = await driver({
    maximumFrameBytes: 64,
    maximumPromptBytes: 32,
    maximumEventTextBytes: 32,
  }).attach(malformedProcess);
  const malformedInit = malformedRuntime.initialize();
  malformedProcess.emitRaw(new Uint8Array(66).fill(0x61));
  await assert.rejects(malformedInit, /frame exceeded/);

  const textOnly = await attachedReady();
  await assert.rejects(
    () =>
      textOnly.runtime.prepareTurn({
        ...preparation(),
        prompt: {
          text: "image",
          image: {
            mimeType: "image/png",
            byteLength: 1,
            base64Data: "AA==" as Base64Payload,
          },
        },
      }),
    /text prompts only/,
  );
});

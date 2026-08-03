import assert from "node:assert/strict";
import { test } from "node:test";

import { FIRST_SLICE_CONFIGURATION_V1 } from "../../bootstrap/fixture-v1.js";
import { decodeProviderConnectionSpec } from "../../bootstrap/records.js";
import {
  generatePiNativeBridgeExtension,
} from "../../bridges/pi-native/extension-generator.js";
import {
  CodecDecodeError,
} from "../../codecs/errors.js";
import type { BootstrapPublicationArtifactBindings } from "../../model/application.js";
import type {
  PiNativeBridgeSidecarFrame,
  PiNativeInvokeFrame,
} from "../../bridges/pi-native/frames.js";
import {
  PI_NATIVE_BRIDGE_LIMITS,
  decodePiNativeBridgeClientFrame,
} from "../../bridges/pi-native/frames.js";
import type { PiNativeInvocationInput } from "./sidecar.js";
import type {
  BoundPiNativeCredentialSource,
  PiNativeCredential,
} from "./credential-store.js";
import { installPiNativeSidecarFetchBoundary } from "./fetch-boundary.js";
import {
  assemblePiNativeSidecarManifest,
  type PiNativeSidecarManifest,
} from "./manifest.js";
import {
  PiNativeEventAdapter,
  type PiNativeEventStream,
} from "./native-events.js";
import { PiNativeReplayError, PiNativeReplayGuard } from "./replay-guard.js";
import {
  createPiNativeBridgeRuntime,
  type PiNativeBridgeInvocation,
} from "./runtime.js";

const MANIFEST = firstSliceManifest();
const BOUNDARY = installPiNativeSidecarFetchBoundary(MANIFEST);
const NATIVE_USAGE = Object.freeze({
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  cacheWrite1h: 0,
  totalTokens: 23,
  reasoning: 4,
  cost: Object.freeze({
    input: 0.1,
    output: 0.2,
    cacheRead: 0.01,
    cacheWrite: 0.02,
    total: 0.33,
  }),
});

test("[V2-S20/pi-native-a3-runtime] maps the full Pi stream, OAuth refresh, retry policy, and replay denial", async () => {
  const credential = oauthCredentialSource();
  let calls = 0;
  let observed: PiNativeInvocationInput | undefined;
  const runtime = createPiNativeBridgeRuntime({
    boundary: BOUNDARY,
    credentialSource: credential.source,
    executor: {
      async invoke(input): Promise<PiNativeEventStream> {
        calls += 1;
        observed = input;
        await input.credentials.modify(input.model.providerId, (current) => {
          assert.equal(current?.type, "oauth");
          return current?.type === "oauth"
            ? { ...current, access: "rotated-access-secret", expires: 2 }
            : current;
        });
        return successStream();
      },
    },
  });
  const request = invokeFrame("00000000-0000-4000-8000-000000000001");
  const invocation = runtime.invoke(request);
  const frames = await collect(invocation);
  assert.deepEqual(frames.map((frame) => frame.kind), [
    "started",
    "oauth-status",
    "oauth-status",
    "reasoning-start",
    "reasoning-delta",
    "reasoning-end",
    "text-start",
    "text-delta",
    "text-end",
    "tool-start",
    "tool-delta",
    "tool-end",
    "usage",
    "terminal",
  ]);
  assert.deepEqual(
    frames.filter((frame) => frame.kind === "oauth-status").map((frame) => frame.state),
    ["refresh-started", "refresh-succeeded"],
  );
  assert.deepEqual(observed?.options, {
    maximumOutputTokens: 1_024,
    maxRetries: 0,
    transport: "sse",
    reasoning: "high",
  });
  assert.equal(observed?.signal.aborted, false);
  assert.equal(Object.isFrozen(observed?.options), true);
  assert.equal(calls, 1);
  assert.equal(frames.at(-1)?.kind, "terminal");
  assert.doesNotMatch(JSON.stringify(frames), /rotated-access-secret|refresh-secret/u);
  assert.throws(() => invocation[Symbol.asyncIterator](), /one-use/u);

  const exactReplay = await collect(runtime.invoke(request));
  assert.deepEqual(exactReplay.map((frame) => frame.kind), ["error"]);
  assert.equal(exactReplay[0]?.kind === "error" ? exactReplay[0].code : undefined, "policy-denied");
  const semanticReplay = await collect(runtime.invoke({
    ...request,
    correlationId: "00000000-0000-4000-8000-000000000002",
  }));
  assert.equal(
    semanticReplay[0]?.kind === "error" ? semanticReplay[0].code : undefined,
    "policy-denied",
  );
  assert.equal(calls, 1);
  assert.throws(
    () => runtime.invoke({
      ...request,
      correlationId: "00000000-0000-4000-8000-000000000003",
      nativeSeam: { maxRetries: 1, transport: "sse" },
    }),
    CodecDecodeError,
  );
  assert.equal(calls, 1);
});

test("native provider, credential, and protocol failures are classified without raw error leakage", async (context) => {
  await context.test("native terminal provider error", async () => {
    const final = assistant([], "error", {
      errorMessage: "RAW_PROVIDER_BODY_SECRET",
      diagnostics: { responseBody: "RAW_DIAGNOSTIC_SECRET" },
      rawStopReason: "failed",
    });
    const runtime = runtimeWithExecutor(async () => streamFrom([
      { type: "start", partial: partialAssistant() },
      { type: "error", reason: "error", error: final },
    ], final));
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000001", "provider-error"),
    ));
    assert.deepEqual(frames.map((frame) => frame.kind), ["started", "usage", "error"]);
    assert.equal(errorCode(frames), "provider-error");
    assert.doesNotMatch(JSON.stringify(frames), /RAW_PROVIDER|RAW_DIAGNOSTIC/u);
  });

  await context.test("Pi-shaped partial text followed by provider error", async () => {
    const partialText = { type: "text", text: "partial" };
    const final = assistant([partialText], "error", {
      errorMessage: "RAW_PARTIAL_PROVIDER_SECRET",
    });
    const runtime = runtimeWithExecutor(async () => streamFrom([
      { type: "start", partial: partialAssistant() },
      {
        type: "text_start",
        contentIndex: 0,
        partial: partialAssistant([{ type: "text", text: "" }]),
      },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        partial: partialAssistant([partialText]),
      },
      { type: "error", reason: "error", error: final },
    ], final));
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000008", "partial-provider-error"),
    ));
    assert.deepEqual(frames.map((frame) => frame.kind), [
      "started",
      "text-start",
      "text-delta",
      "usage",
      "error",
    ]);
    assert.equal(errorCode(frames), "provider-error");
    assert.doesNotMatch(JSON.stringify(frames), /RAW_PARTIAL_PROVIDER_SECRET/u);
  });

  await context.test("bound credential failure", async () => {
    const credential = oauthCredentialSource(true);
    const runtime = createPiNativeBridgeRuntime({
      boundary: BOUNDARY,
      credentialSource: credential.source,
      executor: {
        async invoke(input): Promise<PiNativeEventStream> {
          await input.credentials.modify(input.model.providerId, (current) => current);
          throw new Error("executor must not continue after failed refresh");
        },
      },
    });
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000002", "credential-error"),
    ));
    assert.deepEqual(frames.map((frame) => frame.kind), [
      "started",
      "oauth-status",
      "oauth-status",
      "error",
    ]);
    assert.deepEqual(
      frames.filter((frame) => frame.kind === "oauth-status").map((frame) => frame.state),
      ["refresh-started", "refresh-failed"],
    );
    assert.equal(errorCode(frames), "credential-unavailable");
    assert.doesNotMatch(JSON.stringify(frames), /CONTROL_PLANE_SECRET/u);
  });

  await context.test("Pi-shaped lazy credential failure before native start", async () => {
    const credential = oauthCredentialSource();
    const final = assistant([], "error", { errorMessage: "RAW_LAZY_AUTH_SECRET" });
    const runtime = createPiNativeBridgeRuntime({
      boundary: BOUNDARY,
      credentialSource: credential.source,
      executor: {
        async invoke(input): Promise<PiNativeEventStream> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
              try {
                await input.credentials.modify(input.model.providerId, () => {
                  throw new Error("RAW_OAUTH_REFRESH_SECRET");
                });
              } catch {
                yield { type: "error", reason: "error", error: final };
              }
            },
            async result(): Promise<unknown> {
              return final;
            },
          };
        },
      },
    });
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000006", "lazy-credential-error"),
    ));
    assert.deepEqual(frames.map((frame) => frame.kind), [
      "started",
      "oauth-status",
      "oauth-status",
      "usage",
      "error",
    ]);
    assert.equal(errorCode(frames), "credential-unavailable");
    assert.doesNotMatch(JSON.stringify(frames), /RAW_LAZY_AUTH_SECRET|RAW_OAUTH_REFRESH_SECRET/u);
  });

  await context.test("malformed native order", async () => {
    const runtime = runtimeWithExecutor(async () => streamFrom([
      { type: "start", partial: partialAssistant() },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "orphan",
        partial: partialAssistant(),
      },
    ], assistant([], "stop")));
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000003", "protocol-error"),
    ));
    assert.deepEqual(frames.map((frame) => frame.kind), ["started", "error"]);
    assert.equal(errorCode(frames), "protocol-error");
  });

  await context.test("terminal/result mismatch", async () => {
    const final = assistant([], "stop");
    const runtime = runtimeWithExecutor(async () => streamFrom([
      { type: "start", partial: partialAssistant() },
      { type: "done", reason: "stop", message: final },
    ], { ...final, timestamp: 999 }));
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000004", "result-mismatch"),
    ));
    assert.equal(errorCode(frames), "protocol-error");
  });

  await context.test("tool delta/final argument mismatch", async () => {
    const toolCall = {
      type: "toolCall",
      id: "call-1|fc-item-1",
      name: "read",
      arguments: { path: "B" },
    };
    const runtime = runtimeWithExecutor(async () => streamFrom([
      { type: "start", partial: partialAssistant() },
      { type: "toolcall_start", contentIndex: 0, partial: partialAssistant() },
      { type: "toolcall_delta", contentIndex: 0, delta: "{\"path\":\"A\"}", partial: partialAssistant() },
      { type: "toolcall_end", contentIndex: 0, toolCall, partial: partialAssistant() },
    ], assistant([toolCall], "toolUse")));
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000007", "tool-mismatch"),
    ));
    assert.equal(errorCode(frames), "protocol-error");
  });

  await context.test("duplicate tool argument fields", async () => {
    const toolCall = {
      type: "toolCall",
      id: "call-duplicate|fc-item-duplicate",
      name: "read",
      arguments: { path: "B" },
    };
    const runtime = runtimeWithExecutor(async () => streamFrom([
      { type: "start", partial: partialAssistant() },
      {
        type: "toolcall_start",
        contentIndex: 0,
        partial: partialAssistant([{
          ...toolCall,
          arguments: {},
          partialJson: "",
        }]),
      },
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{\"path\":\"A\",\"path\":\"B\"}",
        partial: partialAssistant([toolCall]),
      },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial: partialAssistant([toolCall]),
      },
    ], assistant([toolCall], "toolUse")));
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000009", "duplicate-tool-field"),
    ));
    assert.equal(errorCode(frames), "protocol-error");
  });

  await context.test("executor rejection", async () => {
    const runtime = runtimeWithExecutor(async () => {
      throw new Error("RAW_EXECUTOR_SECRET");
    });
    const frames = await collect(runtime.invoke(
      invokeFrame("10000000-0000-4000-8000-000000000005", "executor-error"),
    ));
    assert.equal(errorCode(frames), "provider-error");
    assert.doesNotMatch(JSON.stringify(frames), /RAW_EXECUTOR_SECRET/u);
  });
});

test("cancellation aborts the exact native signal and emits one correlated cancellation", async () => {
  let signal: AbortSignal | undefined;
  const runtime = runtimeWithExecutor(async (input) => {
    signal = input.signal;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { type: "start", partial: partialAssistant() };
        yield {
          type: "text_start",
          contentIndex: 0,
          partial: partialAssistant([{ type: "text", text: "" }]),
        };
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("RAW_CANCEL_SECRET");
      },
      async result(): Promise<unknown> {
        throw new Error("result must not run after cancellation");
      },
    };
  });
  const request = invokeFrame("20000000-0000-4000-8000-000000000001", "cancel-during-stream");
  const iterator = runtime.invoke(request)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "started");
  assert.equal((await iterator.next()).value?.kind, "text-start");
  const pending = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  runtime.cancel(cancelFrame(request));
  const cancelled = await pending;
  assert.equal(cancelled.value?.kind, "cancelled");
  assert.equal(signal?.aborted, true);
  assert.equal((await iterator.next()).done, true);
  assert.doesNotMatch(JSON.stringify(cancelled.value), /RAW_CANCEL_SECRET/u);
});

test("cancellation before iteration prevents the native executor from running", async () => {
  let calls = 0;
  const runtime = runtimeWithExecutor(async () => {
    calls += 1;
    return successStream();
  });
  const request = invokeFrame("20000000-0000-4000-8000-000000000002", "cancel-before-start");
  const invocation = runtime.invoke(request);
  runtime.cancel(cancelFrame(request));
  const frames = await collect(invocation);
  assert.deepEqual(frames.map((frame) => frame.kind), ["cancelled"]);
  assert.equal(calls, 0);
});

test("cancellation after bridge start does not open native execution", async () => {
  let calls = 0;
  const runtime = runtimeWithExecutor(async () => {
    calls += 1;
    return successStream();
  });
  const request = invokeFrame(
    "20000000-0000-4000-8000-000000000003",
    "cancel-after-bridge-start",
  );
  const iterator = runtime.invoke(request)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "started");

  runtime.cancel(cancelFrame(request));

  assert.equal((await iterator.next()).value?.kind, "cancelled");
  assert.equal((await iterator.next()).done, true);
  assert.equal(calls, 0);
});

test("process-local replay guard distinguishes replay and evicts its oldest bounded record", () => {
  const guard = new PiNativeReplayGuard(1);
  const first = invokeFrame("30000000-0000-4000-8000-000000000001", "first");
  const maximum = MANIFEST.catalog.model.maximumOutputTokens;
  guard.claim(first, maximum);
  assert.throws(
    () => guard.claim(first, maximum),
    (error) => error instanceof PiNativeReplayError && error.reason === "correlation-replay",
  );
  assert.throws(
    () => guard.claim({
      ...first,
      correlationId: "30000000-0000-4000-8000-000000000002",
    }, maximum),
    (error) => error instanceof PiNativeReplayError && error.reason === "semantic-replay",
  );
  guard.claim(
    invokeFrame("30000000-0000-4000-8000-000000000003", "different"),
    maximum,
  );
  assert.equal(guard.size, 1);
  guard.claim(first, maximum);
});

test("replay fingerprint normalizes effective defaults and accepts aggregate decoded A1 data", async () => {
  let calls = 0;
  const runtime = runtimeWithExecutor(async () => {
    calls += 1;
    return successStream();
  });
  const omitted = invokeFrame("31000000-0000-4000-8000-000000000001", "normalized");
  const withoutMaximum: PiNativeInvokeFrame = {
    ...omitted,
    context: { ...omitted.context, systemPrompt: "", tools: [] },
    options: { reasoning: "high" },
  };
  await collect(runtime.invoke(withoutMaximum));
  const duplicate = await collect(runtime.invoke({
    ...omitted,
    correlationId: "31000000-0000-4000-8000-000000000002",
    options: {
      maximumOutputTokens: PI_NATIVE_BRIDGE_LIMITS.maximumOutputTokens,
      reasoning: "high",
    },
  }));
  assert.equal(errorCode(duplicate), "policy-denied");
  assert.equal(calls, 1);

  const large = invokeFrame("31000000-0000-4000-8000-000000000003", "large-decoded-frame");
  const largeRaw = {
    ...large,
    context: {
      ...large.context,
      tools: Array.from({ length: 45 }, (_, toolIndex) => ({
        name: `tool-${toolIndex}`,
        description: "Aggregate replay digest bound test",
        parameters: Object.fromEntries(
          Array.from({ length: 250 }, (_, fieldIndex) => [`field${fieldIndex}`, fieldIndex]),
        ),
      })),
    },
  };
  const decoded = decodePiNativeBridgeClientFrame(largeRaw, {
    binding: large.binding,
  });
  assert.equal(decoded.kind, "invoke");
  const guard = new PiNativeReplayGuard();
  if (decoded.kind === "invoke") {
    guard.claim(decoded, MANIFEST.catalog.model.maximumOutputTokens);
  }
  assert.equal(guard.size, 1);
});

test("bounded replay history evicts without permanently denying a live runtime", async () => {
  let calls = 0;
  const runtime = createPiNativeBridgeRuntime({
    boundary: BOUNDARY,
    credentialSource: apiKeyCredentialSource(),
    replayMaximumRecords: 1,
    executor: {
      async invoke(): Promise<PiNativeEventStream> {
        calls += 1;
        return successStream();
      },
    },
  });
  const first = invokeFrame("32000000-0000-4000-8000-000000000001", "first-window");
  await collect(runtime.invoke(first));
  await collect(runtime.invoke(
    invokeFrame("32000000-0000-4000-8000-000000000002", "second-window"),
  ));
  await collect(runtime.invoke(first));
  assert.equal(calls, 3);
});

test("invocation disposal and early return release correlations and abort hidden native work", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const runtime = runtimeWithExecutor(async (input) => {
    calls += 1;
    signal = input.signal;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield { type: "start", partial: partialAssistant() };
        yield {
          type: "text_start",
          contentIndex: 0,
          partial: partialAssistant([{ type: "text", text: "" }]),
        };
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async result(): Promise<unknown> {
        return assistant([], "aborted");
      },
    };
  });

  for (let index = 0; index < 257; index += 1) {
    const unopened = runtime.invoke(invokeFrame(
      `33000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      `unopened-${index}`,
    ));
    await unopened.dispose();
    assert.throws(() => unopened[Symbol.asyncIterator](), /disposed/u);
  }
  for (let index = 0; index < 257; index += 1) {
    const unopened = runtime.invoke(invokeFrame(
      `33100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      `iterator-only-${index}`,
    ));
    const unopenedIterator = unopened[Symbol.asyncIterator]();
    await unopenedIterator.return?.();
  }
  const acquiredThenDisposed = runtime.invoke(
    invokeFrame("33200000-0000-4000-8000-000000000001", "acquired-then-disposed"),
  );
  acquiredThenDisposed[Symbol.asyncIterator]();
  await acquiredThenDisposed.dispose();
  assert.equal(calls, 0);

  const startOnlyRequest = invokeFrame(
    "33200000-0000-4000-8000-000000000002",
    "returned-after-bridge-start",
  );
  const startOnlyIterator = runtime.invoke(startOnlyRequest)[Symbol.asyncIterator]();
  assert.equal((await startOnlyIterator.next()).value?.kind, "started");
  await startOnlyIterator.return?.();
  const retriedStartOnly = runtime.invoke(startOnlyRequest)[Symbol.asyncIterator]();
  assert.equal((await retriedStartOnly.next()).value?.kind, "started");
  assert.equal((await retriedStartOnly.next()).value?.kind, "text-start");
  await retriedStartOnly.return?.();

  const request = invokeFrame("33000000-0000-4000-8000-999999999999", "early-return");
  const iterator = runtime.invoke(request)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "started");
  assert.equal((await iterator.next()).value?.kind, "text-start");
  await iterator.return?.();
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 2);
  assert.throws(() => runtime.cancel(cancelFrame(request)), /no active invocation/u);
});

test("runtime close invalidates invocations whose native execution has not started", async (context) => {
  await context.test("unopened invocation", async () => {
    let calls = 0;
    const runtime = runtimeWithExecutor(async () => {
      calls += 1;
      return successStream();
    });
    const invocation = runtime.invoke(
      invokeFrame("33300000-0000-4000-8000-000000000001", "close-unopened"),
    );

    runtime.close();

    assert.throws(() => invocation[Symbol.asyncIterator](), /disposed/u);
    assert.equal(calls, 0);
  });

  await context.test("iterator acquired before close", async () => {
    let calls = 0;
    const runtime = runtimeWithExecutor(async () => {
      calls += 1;
      return successStream();
    });
    const invocation = runtime.invoke(
      invokeFrame("33300000-0000-4000-8000-000000000002", "close-acquired"),
    );
    const iterator = invocation[Symbol.asyncIterator]();

    runtime.close();

    await assert.rejects(() => iterator.next(), /disposed/u);
    assert.equal(calls, 0);
  });

  await context.test("paused after bridge start", async () => {
    let calls = 0;
    const runtime = runtimeWithExecutor(async () => {
      calls += 1;
      return successStream();
    });
    const request = invokeFrame(
      "33300000-0000-4000-8000-000000000003",
      "close-after-start",
    );
    const invocation = runtime.invoke(request);
    const iterator = invocation[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.kind, "started");

    runtime.close();
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(() => iterator.next(), /disposed/u);
    assert.throws(() => runtime.cancel(cancelFrame(request)), /no active invocation/u);
    assert.equal(calls, 0);
  });
});

test("terminal frame removes active state before a manual consumer requests done", async () => {
  const runtime = runtimeWithExecutor(async () => successStream());
  const request = invokeFrame("34000000-0000-4000-8000-000000000001", "manual-terminal");
  const iterator = runtime.invoke(request)[Symbol.asyncIterator]();
  let terminalSeen = false;
  while (!terminalSeen) {
    const step = await iterator.next();
    assert.equal(step.done, false);
    terminalSeen = step.value?.kind === "terminal";
  }
  assert.throws(() => runtime.cancel(cancelFrame(request)), /no active invocation/u);
  const replay = await collect(runtime.invoke(request));
  assert.equal(errorCode(replay), "policy-denied");
  await iterator.return?.();
});

test("native terminal digest supports an aggregate above the generic JSON node default", () => {
  const adapter = new PiNativeEventAdapter(MANIFEST.catalog.model);
  adapter.accept({ type: "start", partial: partialAssistant() });
  const content = Array.from({ length: 101 }, (_, index) => ({
    type: "toolCall",
    id: `call-${index}|fc-item-${index}`,
    name: "read",
    arguments: Object.fromEntries(
      Array.from({ length: 110 }, (_, fieldIndex) => [`field${fieldIndex}`, fieldIndex]),
    ),
  }));
  for (let index = 0; index < content.length; index += 1) {
    adapter.accept({
      type: "toolcall_start",
      contentIndex: index,
      partial: partialAssistant(content.slice(0, index + 1)),
    });
    adapter.accept({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: content[index],
      partial: partialAssistant(content.slice(0, index + 1)),
    });
  }
  const final = assistant(content, "toolUse", { rawStopReason: "completed" });
  adapter.accept({ type: "done", reason: "toolUse", message: final });
  assert.equal(adapter.finish(final).outcome, "done");
});

test("native tool start preserves Pi's initial function-call argument prefix", () => {
  const adapter = new PiNativeEventAdapter(MANIFEST.catalog.model);
  const toolCall = {
    type: "toolCall",
    id: "call-initial|fc-item-initial",
    name: "read",
    arguments: { path: "README.md" },
  };
  adapter.accept({ type: "start", partial: partialAssistant() });
  adapter.accept({
    type: "toolcall_start",
    contentIndex: 0,
    partial: partialAssistant([{
      ...toolCall,
      arguments: { path: "README.md" },
      partialJson: "{\"path\":\"README.md\"}",
    }]),
  });
  adapter.accept({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: partialAssistant([toolCall]),
  });
  const final = assistant([toolCall], "toolUse");
  adapter.accept({ type: "done", reason: "toolUse", message: final });
  assert.equal(adapter.finish(final).outcome, "done");
});

test("native partial validation remains shallow across many growing deltas", () => {
  const adapter = new PiNativeEventAdapter(MANIFEST.catalog.model);
  let content = "";
  adapter.accept({ type: "start", partial: partialAssistant() });
  adapter.accept({
    type: "text_start",
    contentIndex: 0,
    partial: partialAssistant([{ type: "text", text: "" }]),
  });
  for (let index = 0; index < 2_000; index += 1) {
    content += "x";
    adapter.accept({
      type: "text_delta",
      contentIndex: 0,
      delta: "x",
      partial: partialAssistant([{ type: "text", text: content }]),
    });
  }
  adapter.accept({
    type: "text_end",
    contentIndex: 0,
    content,
    partial: partialAssistant([{ type: "text", text: content }]),
  });
  const final = assistant([{ type: "text", text: content }], "stop", {
    rawStopReason: "completed",
  });
  adapter.accept({ type: "done", reason: "stop", message: final });
  assert.equal(adapter.finish(final).outcome, "done");
});

test("alternating native SSE fragmentation is coalesced inside the bounded A1 frame envelope", async () => {
  const deltaCount = 5_000;
  const finalTexts = ["x".repeat(deltaCount / 2), "y".repeat(deltaCount / 2)];
  const finalContent = finalTexts.map((text) => ({ type: "text", text }));
  const final = assistant(finalContent, "stop");
  const runtime = runtimeWithExecutor(async () => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      const texts = ["", ""];
      yield { type: "start", partial: partialAssistant() };
      yield {
        type: "text_start",
        contentIndex: 0,
        partial: partialAssistant([{ type: "text", text: "" }]),
      };
      yield {
        type: "text_start",
        contentIndex: 1,
        partial: partialAssistant([
          { type: "text", text: "" },
          { type: "text", text: "" },
        ]),
      };
      for (let index = 0; index < deltaCount; index += 1) {
        const contentIndex = index % 2;
        const delta = contentIndex === 0 ? "x" : "y";
        texts[contentIndex] += delta;
        yield {
          type: "text_delta",
          contentIndex,
          delta,
          partial: partialAssistant(texts.map((text) => ({ type: "text", text }))),
        };
      }
      for (let contentIndex = 0; contentIndex < finalTexts.length; contentIndex += 1) {
        yield {
          type: "text_end",
          contentIndex,
          content: finalTexts[contentIndex],
          partial: partialAssistant(finalContent),
        };
      }
      yield { type: "done", reason: "stop", message: final };
    },
    async result(): Promise<unknown> {
      return final;
    },
  }));

  const frames = await collect(runtime.invoke(
    invokeFrame("35000000-0000-4000-8000-000000000001", "fragmented-output"),
  ));
  const deltas = frames.filter((frame) => frame.kind === "text-delta");
  assert.equal(deltas.length, 6);
  for (let contentIndex = 0; contentIndex < finalTexts.length; contentIndex += 1) {
    assert.equal(
      deltas
        .filter((frame) => frame.contentIndex === contentIndex)
        .map((frame) => frame.delta)
        .join(""),
      finalTexts[contentIndex],
    );
  }
  assert.equal(frames.at(-1)?.kind, "terminal");
  assert.ok(frames.length < 4_096);
});

function firstSliceManifest(): PiNativeSidecarManifest {
  const configured = FIRST_SLICE_CONFIGURATION_V1.provider.connection;
  const extension = generatePiNativeBridgeExtension({
    manifestVersion: 1,
    bridgeId: configured.transport.bridgeId,
    compatibility: {
      piCodingAgentVersion: "0.82.0",
      piAiVersion: "0.82.0",
      nativeStackDigest: configured.transport.nativeStackDigest,
    },
    nativeCatalogDigest: configured.transport.nativeCatalogDigest,
    provider: {
      id: configured.providerId,
      displayName: "OpenAI Codex through Hitch",
      model: {
        id: configured.model.id,
        displayName: "GPT-5.4 mini",
        api: configured.model.apiProtocol,
        reasoning: true,
        input: ["text", "image"],
        contextWindowTokens: configured.model.contextWindowTokens,
        maximumOutputTokens: configured.model.maximumOutputTokens,
      },
    },
  });
  const connection = decodeProviderConnectionSpec({
    id: configured.id,
    installationId: "hitch-v2-first-slice",
    providerId: configured.providerId,
    displayName: configured.displayName,
    transport: {
      mode: configured.transport.mode,
      credentialCustody: configured.transport.credentialCustody,
      bridgeId: configured.transport.bridgeId,
      nativeStack: configured.transport.nativeStack,
      nativeStackVersion: configured.transport.nativeStackVersion,
      bridgeProtocolVersion: configured.transport.bridgeProtocolVersion,
      nativeCatalogDigest: configured.transport.nativeCatalogDigest,
      credentialResolverId: configured.transport.credentialResolverId,
      nativeRetries: configured.transport.nativeRetries,
      invocation: configured.transport.invocation,
    },
    allowedUpstreamOrigins: configured.allowedOrigins,
    models: [{
      providerId: configured.model.providerId,
      modelId: configured.model.id,
      apiProtocolId: configured.model.apiProtocol,
      contextWindowTokens: configured.model.contextWindowTokens,
      maximumOutputTokens: configured.model.maximumOutputTokens,
      tokenEstimatorId: configured.model.tokenEstimatorId,
      imageInput: configured.model.imageInput,
      tools: configured.model.tools,
      reasoning: configured.model.reasoning,
      nativeModelMetadata: configured.model.nativeModelMetadata,
      integrityDigest: configured.model.integrityDigest,
    }],
    integrityDigest: configured.integrityDigest,
    createdAt: "2026-08-03T00:00:00.000Z",
  });
  if (connection.transport.mode !== "native-library-sidecar") {
    throw new Error("runtime test expected a native sidecar connection");
  }
  const artifacts: BootstrapPublicationArtifactBindings["provider"] = {
    providerConnectionId: connection.id,
    bridgeId: connection.transport.bridgeId,
    bridgeArtifactDigest: configured.transport.bridgeArtifactDigest as BootstrapPublicationArtifactBindings["provider"]["bridgeArtifactDigest"],
    nativeStack: configured.transport.nativeStack,
    nativeStackVersion: configured.transport.nativeStackVersion,
    nativeStackDigest: configured.transport.nativeStackDigest as BootstrapPublicationArtifactBindings["provider"]["nativeStackDigest"],
    nativeCatalogDigest: configured.transport.nativeCatalogDigest,
  };
  return assemblePiNativeSidecarManifest({ connection, artifacts, extension });
}

function invokeFrame(correlationId: string, text = "hello"): PiNativeInvokeFrame {
  return {
    protocolVersion: 1,
    kind: "invoke",
    correlationId,
    compatibility: {
      piCodingAgentVersion: "0.82.0",
      piAiVersion: "0.82.0",
    },
    binding: {
      bridgeId: MANIFEST.bridge.id,
      nativeStackDigest: MANIFEST.nativeStackDigest,
      nativeCatalogDigest: MANIFEST.catalog.digest,
    },
    context: {
      messages: [{ role: "user", content: text, timestamp: 0 }],
    },
    options: { maximumOutputTokens: 1_024, reasoning: "high" },
    nativeSeam: { maxRetries: 0, transport: "sse" },
  };
}

function cancelFrame(frame: PiNativeInvokeFrame): unknown {
  const { context: _context, options: _options, nativeSeam: _nativeSeam, ...base } = frame;
  return { ...base, kind: "cancel" };
}

function assistant(
  content: readonly unknown[],
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted",
  optional: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: MANIFEST.catalog.model.api,
    provider: MANIFEST.catalog.model.providerId,
    model: MANIFEST.catalog.model.id,
    usage: NATIVE_USAGE,
    stopReason,
    timestamp: 1,
    ...optional,
  };
}

function successStream(): PiNativeEventStream {
  const reasoning = { type: "thinking", thinking: "plan", thinkingSignature: "signature", redacted: false };
  const text = { type: "text", text: "answer", textSignature: "signature" };
  const toolCall = {
    type: "toolCall",
    id: "call-1|fc-item-1",
    name: "read",
    arguments: { path: "README.md" },
    thoughtSignature: "signature",
  };
  const final = assistant([reasoning, text, toolCall], "toolUse", { rawStopReason: "completed" });
  const partialToolCall = {
    ...toolCall,
    arguments: {},
    partialJson: "",
  };
  return streamFrom([
    { type: "start", partial: partialAssistant() },
    { type: "thinking_start", contentIndex: 0, partial: partialAssistant([{ type: "thinking", thinking: "" }]) },
    { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: partialAssistant([{ type: "thinking", thinking: "plan" }]) },
    { type: "thinking_end", contentIndex: 0, content: "plan", partial: partialAssistant([reasoning]) },
    { type: "text_start", contentIndex: 1, partial: partialAssistant([reasoning, { type: "text", text: "" }]) },
    { type: "text_delta", contentIndex: 1, delta: "answer", partial: partialAssistant([reasoning, { type: "text", text: "answer" }]) },
    { type: "text_end", contentIndex: 1, content: "answer", partial: partialAssistant([reasoning, text]) },
    { type: "toolcall_start", contentIndex: 2, partial: partialAssistant([reasoning, text, partialToolCall]) },
    { type: "toolcall_delta", contentIndex: 2, delta: "{\"path\":\"README.md\"}", partial: partialAssistant([reasoning, text, partialToolCall]) },
    { type: "toolcall_end", contentIndex: 2, toolCall, partial: partialAssistant([reasoning, text, toolCall]) },
    { type: "done", reason: "toolUse", message: final },
  ], final);
}

function partialAssistant(content: readonly unknown[] = []): Record<string, unknown> {
  return assistant(content, "pending");
}

function streamFrom(events: readonly unknown[], result: unknown): PiNativeEventStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const event of events) yield event;
    },
    async result(): Promise<unknown> {
      return result;
    },
  };
}

function runtimeWithExecutor(
  invoke: (input: PiNativeInvocationInput) => Promise<PiNativeEventStream>,
) {
  return createPiNativeBridgeRuntime({
    boundary: BOUNDARY,
    credentialSource: apiKeyCredentialSource(),
    executor: { invoke },
  });
}

function apiKeyCredentialSource(): BoundPiNativeCredentialSource {
  return {
    resolverId: MANIFEST.credentialStore.resolverId,
    providerId: MANIFEST.credentialStore.providerId,
    credentialType: "api_key",
    async read() {
      return { type: "api_key", key: "api-key-secret" };
    },
    async modify() {
      throw new Error("API key source modification must not run");
    },
  };
}

function oauthCredentialSource(failModify = false): {
  readonly source: BoundPiNativeCredentialSource;
} {
  let credential: PiNativeCredential = {
    type: "oauth",
    access: "initial-access-secret",
    refresh: "refresh-secret",
    expires: 1,
    accountId: "account-123",
  };
  return {
    source: {
      resolverId: MANIFEST.credentialStore.resolverId,
      providerId: MANIFEST.credentialStore.providerId,
      credentialType: "oauth",
      async read() {
        return credential;
      },
      async modify(transform) {
        const replacement = await transform(credential);
        if (failModify) throw new Error("CONTROL_PLANE_SECRET");
        credential = replacement as PiNativeCredential;
        return credential;
      },
    },
  };
}

async function collect(invocation: PiNativeBridgeInvocation) {
  const frames: PiNativeBridgeSidecarFrame[] = [];
  for await (const frame of invocation) frames.push(frame);
  return frames;
}

function errorCode(frames: readonly PiNativeBridgeSidecarFrame[]): string | undefined {
  const final = frames.at(-1);
  return final?.kind === "error" ? final.code : undefined;
}

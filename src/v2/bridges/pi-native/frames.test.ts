import assert from "node:assert/strict";
import { test } from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import { scenarioCase } from "../../acceptance/runner.js";
import {
  PI_NATIVE_BRIDGE_COMPATIBILITY,
  PI_NATIVE_BRIDGE_ID,
  PI_NATIVE_BRIDGE_LIMITS,
  PiNativeBridgeCorrelationGuard,
  decodePiNativeBridgeClientFrame as decodeClientFrameBoundary,
  decodePiNativeBridgeFrame as decodeFrameBoundary,
  decodePiNativeBridgeJsonlFrame as decodeJsonlFrameBoundary,
  decodePiNativeBridgeSidecarFrame as decodeSidecarFrameBoundary,
  encodePiNativeBridgeFrame,
  type PiNativeBridgeBinding,
  type PiNativeBridgeFrame,
  type PiNativeBridgeFrameExpectation,
  type PiNativeBridgeFrameLimits,
} from "./frames.js";

const STACK_DIGEST = `sha256:${"a".repeat(64)}`;
const CATALOG_DIGEST = `sha256:${"b".repeat(64)}`;
const CORRELATION_ID = "01234567-89ab-4cde-8fab-0123456789ab";

const binding = {
  bridgeId: PI_NATIVE_BRIDGE_ID,
  nativeStackDigest: STACK_DIGEST,
  nativeCatalogDigest: CATALOG_DIGEST,
} as PiNativeBridgeBinding;
const expectation = Object.freeze({ binding });

function decodePiNativeBridgeFrame(
  input: unknown,
  expected: PiNativeBridgeFrameExpectation = expectation,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeFrame {
  return decodeFrameBoundary(input, expected, limits);
}

function decodePiNativeBridgeClientFrame(
  input: unknown,
  expected: PiNativeBridgeFrameExpectation = expectation,
  limits?: PiNativeBridgeFrameLimits,
) {
  return decodeClientFrameBoundary(input, expected, limits);
}

function decodePiNativeBridgeSidecarFrame(
  input: unknown,
  expected: PiNativeBridgeFrameExpectation = expectation,
  limits?: PiNativeBridgeFrameLimits,
) {
  return decodeSidecarFrameBoundary(input, expected, limits);
}

function decodePiNativeBridgeJsonlFrame(
  input: Uint8Array,
  expected: PiNativeBridgeFrameExpectation = expectation,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeFrame {
  return decodeJsonlFrameBoundary(input, expected, limits);
}

function base(correlationId = CORRELATION_ID): Record<string, unknown> {
  return {
    protocolVersion: 1,
    correlationId,
    compatibility: { ...PI_NATIVE_BRIDGE_COMPATIBILITY },
    binding: { ...binding },
  };
}

function usage(): Record<string, unknown> {
  return {
    inputTokens: 3,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    reasoningTokens: 2,
    totalTokens: 8,
  };
}

function invoke(): Record<string, unknown> {
  return {
    ...base(),
    kind: "invoke",
    context: {
      systemPrompt: "Use only the approved tool.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the image." },
            { type: "image", mimeType: "image/png", data: Buffer.from("image-bytes").toString("base64") },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "thinking", thinking: "Need image reasoning.", redacted: true },
            { type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } },
          ],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.4-mini",
          stopReason: "toolUse",
          timestamp: 2,
          usage: usage(),
        },
        {
          role: "toolResult",
          toolCallId: "tool-call-1",
          toolName: "read",
          content: [{ type: "text", text: "# Hitch" }],
          isError: false,
          timestamp: 3,
          addedToolNames: ["read"],
          usage: usage(),
        },
      ],
      tools: [{ name: "read", description: "Read one approved file.", parameters: { type: "object", additionalProperties: false } }],
    },
    options: { maximumOutputTokens: 128, reasoning: "low" },
    nativeSeam: { maxRetries: 0, transport: "sse" },
  };
}

function frames(): readonly unknown[] {
  return [
    invoke(),
    { ...base(), kind: "cancel" },
    { ...base(), kind: "started" },
    { ...base(), kind: "text-start", contentIndex: 0 },
    { ...base(), kind: "text-delta", contentIndex: 0, delta: "hello" },
    { ...base(), kind: "text-end", contentIndex: 0, content: "hello" },
    { ...base(), kind: "reasoning-start", contentIndex: 1 },
    { ...base(), kind: "reasoning-delta", contentIndex: 1, delta: "reason" },
    { ...base(), kind: "reasoning-end", contentIndex: 1, content: "reason" },
    { ...base(), kind: "tool-start", contentIndex: 2 },
    { ...base(), kind: "tool-delta", contentIndex: 2, delta: "{\"path\"" },
    { ...base(), kind: "tool-end", contentIndex: 2, toolCall: { type: "toolCall", id: "tool-call-2", name: "read", arguments: { path: "README.md" } } },
    { ...base(), kind: "usage", usage: usage() },
    { ...base(), kind: "error", code: "provider-error", message: "provider returned a sanitized failure" },
    { ...base(), kind: "terminal", reason: "stop", usage: usage() },
    { ...base(), kind: "cancelled" },
    { ...base(), kind: "oauth-status", state: "refresh-succeeded" },
  ];
}

function decodeAllFrameKinds(): readonly PiNativeBridgeFrame[] {
  return frames().map((frame) => decodePiNativeBridgeFrame(frame, { correlationId: CORRELATION_ID, binding }));
}

test("Pi native bridge codecs round trip every closed frame kind", () => {
  const decoded = decodeAllFrameKinds();
  assert.deepEqual(
    decoded.map((frame) => frame.kind),
    ["invoke", "cancel", "started", "text-start", "text-delta", "text-end", "reasoning-start", "reasoning-delta", "reasoning-end", "tool-start", "tool-delta", "tool-end", "usage", "error", "terminal", "cancelled", "oauth-status"],
  );
  for (const frame of decoded) {
    const wire = encodePiNativeBridgeFrame(frame);
    const roundTrip = decodePiNativeBridgeJsonlFrame(wire, { correlationId: CORRELATION_ID, binding });
    assert.deepEqual(roundTrip, frame);
    assert.ok(Object.isFrozen(roundTrip));
    assert.ok(Object.isFrozen(roundTrip.binding));
  }
});

test("Pi native bridge JSONL has exact byte, UTF-8, blank, and one-line boundaries", () => {
  const wire = encodePiNativeBridgeFrame(invoke());
  assert.deepEqual(
    decodePiNativeBridgeJsonlFrame(wire, undefined, { maximumFrameBytes: wire.length }).kind,
    "invoke",
  );
  assert.throws(
    () => decodePiNativeBridgeJsonlFrame(wire, undefined, { maximumFrameBytes: wire.length - 1 }),
    CodecDecodeError,
  );
  assert.throws(() => decodePiNativeBridgeJsonlFrame(Uint8Array.of(0x0a)), CodecDecodeError);
  assert.throws(() => decodePiNativeBridgeJsonlFrame(Uint8Array.of(0x7b, 0xc3, 0x0a)), CodecDecodeError);
  const multiple = new Uint8Array([...wire, ...wire]);
  assert.throws(() => decodePiNativeBridgeJsonlFrame(multiple), CodecDecodeError);
  const carriageReturn = new TextEncoder().encode(`${new TextDecoder().decode(wire).replace("\n", "\r\n")}`);
  assert.throws(() => decodePiNativeBridgeJsonlFrame(carriageReturn), CodecDecodeError);
});

test("Pi native bridge JSON parser stops deep and wide structures before typed frame decoding", () => {
  const cancel = new TextDecoder().decode(encodePiNativeBridgeFrame({ ...base(), kind: "cancel" })).trimEnd();
  const deep = `${cancel.slice(0, -1)},"unknown":${"[".repeat(65)}0${"]".repeat(66)}`;
  assert.throws(() => decodePiNativeBridgeJsonlFrame(new TextEncoder().encode(`${deep}\n`)), CodecDecodeError);
  const wide = `${cancel.slice(0, -1)},"unknown":[${Array.from({ length: 1_025 }, () => "0").join(",")}]}`;
  assert.throws(() => decodePiNativeBridgeJsonlFrame(new TextEncoder().encode(`${wide}\n`)), CodecDecodeError);
});

test("Pi native bridge bounds context strings, arrays, and context bytes without off-by-one widening", () => {
  const exact = invoke();
  const exactContextBytes = Buffer.byteLength(JSON.stringify(exact.context), "utf8");
  assert.equal(
    decodePiNativeBridgeFrame(exact, undefined, { maximumContextBytes: exactContextBytes }).kind,
    "invoke",
  );
  assert.throws(
    () => decodePiNativeBridgeFrame(exact, undefined, { maximumContextBytes: exactContextBytes - 1 }),
    CodecDecodeError,
  );
  const longestText = invoke();
  ((((longestText.context as Record<string, unknown>).messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[])[0]!).text = "x".repeat(262_144);
  assert.equal(decodePiNativeBridgeFrame(longestText).kind, "invoke");
  const tooLongText = invoke();
  ((((tooLongText.context as Record<string, unknown>).messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[])[0]!).text = "x".repeat(262_145);
  assert.throws(() => decodePiNativeBridgeFrame(tooLongText), CodecDecodeError);
  const tooManyMessages = invoke();
  (tooManyMessages.context as Record<string, unknown>).messages = Array.from(
    { length: 257 },
    () => ({ role: "user", content: "bounded", timestamp: 1 }),
  );
  assert.throws(() => decodePiNativeBridgeFrame(tooManyMessages), CodecDecodeError);
});

test("Pi native bridge rejects duplicate fields, prototypes, unknown fields, and unsafe injection shapes", () => {
  const wireText = new TextDecoder().decode(encodePiNativeBridgeFrame({ ...base(), kind: "cancel" }));
  const duplicate = wireText.replace('"protocolVersion":1,', '"protocolVersion":1,"protocolVersion":1,');
  assert.throws(() => decodePiNativeBridgeJsonlFrame(new TextEncoder().encode(duplicate)), CodecDecodeError);

  const prototyped = Object.assign(Object.create({ inherited: true }), { ...base(), kind: "cancel" });
  assert.throws(() => decodePiNativeBridgeFrame(prototyped), CodecDecodeError);
  assert.throws(() => decodePiNativeBridgeFrame({ ...base(), kind: "cancel", extra: true }), CodecDecodeError);

  for (const forbidden of ["origin", "headers", "auth", "credential", "path", "command", "env", "loader"] as const) {
    assert.throws(
      () => decodePiNativeBridgeFrame({ ...invoke(), [forbidden]: "attacker-selected" }),
      CodecDecodeError,
      forbidden,
    );
  }
  assert.throws(
    () => decodePiNativeBridgeFrame({ ...invoke(), options: { origin: "https://attacker.invalid" } }),
    CodecDecodeError,
  );
  assert.throws(
    () => decodePiNativeBridgeFrame({ ...invoke(), nativeSeam: { maxRetries: 1, transport: "sse" } }),
    CodecDecodeError,
  );
  assert.throws(
    () => decodePiNativeBridgeFrame({ ...invoke(), nativeSeam: { maxRetries: 0, transport: "websocket" } }),
    CodecDecodeError,
  );
});

test("Pi native bridge rejects version, correlation, native-stack/catalog mismatch, and wrong direction", () => {
  assert.throws(
    () => decodeFrameBoundary({ ...base(), kind: "cancel" }, undefined as never),
    CodecDecodeError,
  );
  assert.throws(
    () => decodeFrameBoundary({ ...base(), kind: "cancel" }, {} as never),
    CodecDecodeError,
  );
  assert.throws(() => decodePiNativeBridgeFrame({ ...base(), kind: "cancel", protocolVersion: 2 }), CodecDecodeError);
  assert.throws(
    () => decodePiNativeBridgeFrame({ ...base("11111111-1111-4111-8111-111111111111"), kind: "cancel" }, { correlationId: CORRELATION_ID, binding }),
    CodecDecodeError,
  );
  assert.throws(
    () => decodePiNativeBridgeFrame({ ...base(), kind: "cancel", binding: { ...binding, nativeStackDigest: `sha256:${"c".repeat(64)}` } }, { binding }),
    CodecDecodeError,
  );
  assert.throws(
    () => decodePiNativeBridgeFrame({ ...base(), kind: "cancel", binding: { ...binding, nativeCatalogDigest: `sha256:${"d".repeat(64)}` } }, { binding }),
    CodecDecodeError,
  );
  assert.throws(() => decodePiNativeBridgeClientFrame({ ...base(), kind: "started" }), CodecDecodeError);
  assert.throws(() => decodePiNativeBridgeSidecarFrame({ ...base(), kind: "cancel" }), CodecDecodeError);
});

test("Pi native bridge correlation guard rejects duplicate invocation and invalid stream ordering", () => {
  const guard = new PiNativeBridgeCorrelationGuard();
  const request = decodePiNativeBridgeClientFrame(invoke());
  guard.acceptClient(request);
  assert.throws(() => guard.acceptClient(request), CodecDecodeError);
  const driftedBinding = {
    ...binding,
    nativeCatalogDigest: `sha256:${"c".repeat(64)}`,
  } as PiNativeBridgeBinding;
  const driftedCancel = decodePiNativeBridgeClientFrame(
    {
      ...base(),
      kind: "cancel",
      binding: driftedBinding,
    },
    { binding: driftedBinding },
  );
  assert.throws(() => guard.acceptClient(driftedCancel), CodecDecodeError);
  assert.throws(() => guard.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "text-start", contentIndex: 0 })), CodecDecodeError);
  guard.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "started" }));
  guard.acceptClient(decodePiNativeBridgeClientFrame({ ...base(), kind: "cancel" }));
  guard.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "cancelled" }));
  assert.throws(() => guard.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "terminal", reason: "stop", usage: usage() })), CodecDecodeError);
});

test("Pi native bridge correlation guard bounds active state and accepts pre-start failure", () => {
  const preStartFailure = new PiNativeBridgeCorrelationGuard();
  preStartFailure.acceptClient(decodePiNativeBridgeClientFrame(invoke()));
  preStartFailure.acceptSidecar(
    decodePiNativeBridgeSidecarFrame({
      ...base(),
      kind: "error",
      code: "provider-error",
      message: "sanitized setup failure",
    }),
  );
  assert.throws(
    () =>
      preStartFailure.acceptSidecar(
        decodePiNativeBridgeSidecarFrame({ ...base(), kind: "started" }),
      ),
    CodecDecodeError,
  );

  const bounded = new PiNativeBridgeCorrelationGuard();
  for (
    let index = 0;
    index < PI_NATIVE_BRIDGE_LIMITS.maximumActiveCorrelations;
    index += 1
  ) {
    const correlationId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    bounded.acceptClient(
      decodePiNativeBridgeClientFrame(
        { ...invoke(), correlationId },
        { binding, correlationId },
      ),
    );
  }
  const overflowCorrelation = "00000000-0000-4000-8000-999999999999";
  assert.throws(
    () =>
      bounded.acceptClient(
        decodePiNativeBridgeClientFrame(
          { ...invoke(), correlationId: overflowCorrelation },
          { binding, correlationId: overflowCorrelation },
        ),
      ),
    CodecDecodeError,
  );
});

test("Pi native bridge correlation guard closes each stream content index before terminal", () => {
  const begin = (): PiNativeBridgeCorrelationGuard => {
    const guard = new PiNativeBridgeCorrelationGuard();
    guard.acceptClient(decodePiNativeBridgeClientFrame(invoke()));
    guard.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "started" }));
    return guard;
  };
  assert.throws(
    () => begin().acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "text-delta", contentIndex: 0, delta: "before start" })),
    CodecDecodeError,
  );
  const mismatched = begin();
  mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "text-start", contentIndex: 0 }));
  assert.throws(
    () => mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "reasoning-delta", contentIndex: 0, delta: "wrong kind" })),
    CodecDecodeError,
  );
  assert.throws(
    () => mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "text-start", contentIndex: 0 })),
    CodecDecodeError,
  );
  assert.throws(
    () => mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "terminal", reason: "stop", usage: usage() })),
    CodecDecodeError,
  );
  mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "text-end", contentIndex: 0, content: "closed" }));
  assert.throws(
    () => mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "text-end", contentIndex: 0, content: "duplicate end" })),
    CodecDecodeError,
  );
  mismatched.acceptSidecar(decodePiNativeBridgeSidecarFrame({ ...base(), kind: "terminal", reason: "stop", usage: usage() }));
});

test("Pi native bridge copies and freezes decoded data", () => {
  const input = invoke();
  const decoded = decodePiNativeBridgeFrame(input);
  (input.binding as Record<string, unknown>).nativeStackDigest = `sha256:${"e".repeat(64)}`;
  assert.equal(decoded.binding.nativeStackDigest, STACK_DIGEST);
  assert.throws(() => {
    (decoded.binding as { nativeCatalogDigest: string }).nativeCatalogDigest = `sha256:${"f".repeat(64)}`;
  }, TypeError);
  const first = encodePiNativeBridgeFrame(decoded);
  first[0] = 0;
  assert.equal(decodePiNativeBridgeJsonlFrame(encodePiNativeBridgeFrame(decoded)).kind, "invoke");
});

scenarioCase({
  scenarioId: "V2-S20",
  caseId: "pi-native-typed-stream-frames",
  title: "the Pi 0.82.0 bridge codec executes every bounded stream frame and pins correlation/native stack/catalog identity",
  run: () => {
    const all = decodeAllFrameKinds();
    assert.equal(all.length, 17);
    assert.ok(all.some((frame) => frame.kind === "oauth-status"));
    const invokeFrame = all.find((frame) => frame.kind === "invoke");
    assert.equal(
      invokeFrame?.kind === "invoke" &&
        invokeFrame.context.messages.some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((content) => content.type === "image"),
        ),
      true,
    );
    assert.ok(all.some((frame) => frame.kind === "terminal"));
  },
});

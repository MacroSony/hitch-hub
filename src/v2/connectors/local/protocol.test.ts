import assert from "node:assert/strict";
import test from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  decodeLocalProtocolClientFrame,
  decodeLocalProtocolServerFrame,
  encodeCanonicalLocalProtocolClientFrame,
  encodeCanonicalLocalProtocolServerFrame,
} from "./protocol.js";

function request(command: unknown, requestId = "request-1"): unknown {
  return {
    protocol: "hitch.local",
    version: 1,
    frame: "request",
    requestId,
    command,
  };
}

function serverFrame(
  frame: "response" | "event" | "stream-end",
  body: Record<string, unknown> = {},
): unknown {
  return {
    protocol: "hitch.local",
    version: 1,
    frame,
    requestId: "request-1",
    ...body,
  };
}

const TERMINAL_RESPONSE = {
  id: "terminal-response-1",
  turnId: "turn-1",
  result: { outcome: "completed" },
  partialOutputAvailable: false,
  finalizedMessages: [
    {
      messageId: "message-1",
      sequence: 0,
      content: [{ kind: "text", text: "done" }],
    },
  ],
  finalizedAt: "2026-07-29T12:00:00.000Z",
} as const;

function collectKeys(input: unknown, output = new Set<string>()): Set<string> {
  if (input === null || typeof input !== "object") return output;
  if (Array.isArray(input)) {
    for (const item of input) collectKeys(item, output);
    return output;
  }
  for (const [key, value] of Object.entries(input)) {
    output.add(key);
    collectKeys(value, output);
  }
  return output;
}

test("local client codec covers the closed command set and freezes detached values", () => {
  const commands = [
    {
      kind: "create-session",
      profileReference: "coding",
      workspaceReference: "hitch-hub",
      displayName: "Review",
    },
    {
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-1" },
      idempotencyKey: "retry-1",
      text: "Review the current branch.",
    },
    {
      kind: "submit-turn",
      session: { kind: "session-name", name: "Review" },
      idempotencyKey: "retry-2",
      text: "Inspect this image.",
      image: {
        encoding: "base64",
        byteLength: 5,
        data: "aGVsbG8=",
      },
    },
    { kind: "get-turn", turnId: "turn-1" },
    { kind: "cancel-turn", turnId: "turn-1" },
    { kind: "stop-session", sessionId: "session-1" },
    {
      kind: "resolve-interaction",
      interactionId: "interaction-1",
      decision: "approve",
    },
  ];

  for (const [index, command] of commands.entries()) {
    const source = request(command, `request-${index + 1}`);
    const decoded = decodeLocalProtocolClientFrame(source);
    assert.equal(decoded.command.kind, command.kind);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.command));
    assert.deepEqual(
      JSON.parse(encodeCanonicalLocalProtocolClientFrame(decoded)),
      decoded,
    );
  }

  const mutable = request({
    kind: "submit-turn",
    session: { kind: "session-name", name: "Before" },
    idempotencyKey: "retry-detached",
    text: "before",
  }) as {
    command: {
      session: { name: string };
      text: string;
    };
  };
  const detached = decodeLocalProtocolClientFrame(mutable);
  mutable.command.session.name = "After";
  mutable.command.text = "after";
  assert.deepEqual(detached.command, {
    kind: "submit-turn",
    session: { kind: "session-name", name: "Before" },
    idempotencyKey: "retry-detached",
    text: "before",
  });
});

test("[V2-S02/local-protocol-authority-exclusion] local requests cannot select identity, origin, durable specs, grants, or authorization", () => {
  const base = {
    kind: "submit-turn",
    session: { kind: "session-id", sessionId: "session-1" },
    idempotencyKey: "retry-1",
    text: "hello",
  };
  const forbidden = {
    principalId: "principal-2",
    endpointId: "endpoint-2",
    origin: { kind: "endpoint" },
    sessionSpecId: "spec-2",
    spec: {},
    grantId: "grant-2",
    authorization: { decision: "allowed" },
  };
  for (const [field, value] of Object.entries(forbidden)) {
    assert.throws(
      () =>
        decodeLocalProtocolClientFrame(
          request({ ...base, [field]: value }),
        ),
      CodecDecodeError,
    );
  }

  const decoded = decodeLocalProtocolClientFrame(request(base));
  const keys = collectKeys(decoded);
  for (const field of Object.keys(forbidden)) {
    assert.equal(keys.has(field), false);
  }
});

test("local request bounds reject malformed references, text, images, and object behavior", () => {
  assert.throws(
    () =>
      decodeLocalProtocolClientFrame(
        request({
          kind: "create-session",
          profileReference: "../coding",
          workspaceReference: "hitch-hub",
        }),
      ),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      decodeLocalProtocolClientFrame(
        request({
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: "session-1" },
          idempotencyKey: "retry-1",
          text: "x".repeat(
            LOCAL_PROTOCOL_LIMITS.maximumPromptCharacters + 1,
          ),
        }),
      ),
    CodecDecodeError,
  );
  for (const image of [
    { encoding: "base64", byteLength: 4, data: "aGVsbG8=" },
    { encoding: "base64", byteLength: 5, data: "aGVsbG8" },
    { encoding: "hex", byteLength: 5, data: "aGVsbG8=" },
    {
      encoding: "base64",
      byteLength: LOCAL_PROTOCOL_LIMITS.maximumImageBytes + 1,
      data: "eA==",
    },
  ]) {
    assert.throws(
      () =>
        decodeLocalProtocolClientFrame(
          request({
            kind: "submit-turn",
            session: { kind: "session-id", sessionId: "session-1" },
            idempotencyKey: "retry-1",
            text: "hello",
            image,
          }),
        ),
      CodecDecodeError,
    );
  }

  const prototyped = Object.assign(
    Object.create({ principalId: "principal-2" }),
    request({ kind: "get-turn", turnId: "turn-1" }),
  );
  assert.throws(
    () => decodeLocalProtocolClientFrame(prototyped),
    CodecDecodeError,
  );

  const imageBytes = Buffer.alloc(65_537, 0x5a);
  const largeImageFrame = request({
    kind: "submit-turn",
    session: { kind: "session-id", sessionId: "session-1" },
    idempotencyKey: "retry-large-image",
    text: "inspect",
    image: {
      encoding: "base64",
      byteLength: imageBytes.length,
      data: imageBytes.toString("base64"),
    },
  });
  assert.deepEqual(
    decodeLocalProtocolClientFrame(
      JSON.parse(encodeCanonicalLocalProtocolClientFrame(largeImageFrame)),
    ),
    decodeLocalProtocolClientFrame(largeImageFrame),
  );
});

test("local response codec validates every command result and rejection", () => {
  const results = [
    { kind: "session-created", sessionId: "session-1" },
    {
      kind: "turn-submitted",
      turnId: "turn-1",
      status: "starting",
      canCancel: true,
    },
    {
      kind: "turn-submitted",
      turnId: "turn-2",
      status: "queued",
      position: 1,
      canCancel: true,
    },
    {
      kind: "turn-found",
      turnId: "turn-1",
      state: "running",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
    {
      kind: "turn-found",
      turnId: "turn-1",
      state: "terminal",
      updatedAt: "2026-07-29T12:00:00.000Z",
      terminalResponse: TERMINAL_RESPONSE,
    },
    { kind: "turn-cancelled", turnId: "turn-1" },
    { kind: "turn-already-cancelled", turnId: "turn-1" },
    {
      kind: "turn-not-cancelled",
      turnId: "turn-1",
      reason: "already-terminal",
    },
    { kind: "session-stop-requested", sessionId: "session-1" },
    { kind: "session-already-stopped", sessionId: "session-1" },
    { kind: "interaction-resolved", interactionId: "interaction-1" },
    {
      kind: "interaction-not-pending",
      interactionId: "interaction-1",
    },
  ];

  for (const result of results) {
    const decoded = decodeLocalProtocolServerFrame(
      serverFrame("response", {
        outcome: { status: "succeeded", result },
      }),
    );
    assert.equal(decoded.frame, "response");
    assert.ok(Object.isFrozen(decoded));
    assert.deepEqual(
      JSON.parse(encodeCanonicalLocalProtocolServerFrame(decoded)),
      decoded,
    );
  }

  for (const code of [
    "not-authorized",
    "not-found",
    "invalid-request",
    "queue-capacity-exceeded",
    "conflict",
    "temporarily-unavailable",
  ]) {
    const decoded = decodeLocalProtocolServerFrame(
      serverFrame("response", {
        outcome: { status: "rejected", code },
      }),
    );
    assert.equal(
      decoded.frame === "response" ? decoded.outcome.status : undefined,
      "rejected",
    );
  }
});

test("local server events admit only sanitized connector projections", () => {
  const events = [
    {
      kind: "turn-checkpoint",
      turnId: "turn-1",
      sequence: 1,
      payload: {
        kind: "plan",
        entries: [
          { content: "Inspect", status: "in-progress", priority: "high" },
        ],
      },
    },
    {
      kind: "approval-requested",
      turnId: "turn-1",
      interactionId: "interaction-1",
      request: {
        kind: "approval",
        toolInvocationId: "tool-1",
        title: "Run formatter",
        advertisedAgentOptions: [],
        options: [],
      },
    },
    { kind: "turn-terminal", response: TERMINAL_RESPONSE },
    {
      kind: "response-delivery-state",
      turnId: "turn-1",
      deliveryId: "delivery-1",
      state: "delivered",
    },
  ];

  for (const event of events) {
    const decoded = decodeLocalProtocolServerFrame(
      serverFrame("event", { event }),
    );
    assert.equal(decoded.frame, "event");
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.event));
  }
  assert.equal(
    decodeLocalProtocolServerFrame(serverFrame("stream-end")).frame,
    "stream-end",
  );

  assert.throws(
    () =>
      decodeLocalProtocolServerFrame(
        serverFrame("event", {
          event: {
            kind: "turn-checkpoint",
            turnId: "turn-1",
            sequence: 1,
            payload: {
              kind: "agent-message-chunk",
              messageId: "message-1",
              content: { kind: "text", text: "raw" },
            },
          },
        }),
      ),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      decodeLocalProtocolServerFrame(
        serverFrame("event", {
          event: {
            kind: "approval-requested",
            turnId: "turn-1",
            interactionId: "interaction-1",
            request: { kind: "input", sanitizedPrompt: "secret?" },
          },
        }),
      ),
    CodecDecodeError,
  );
});

test("terminal response correlation and frame byte ceilings fail closed", () => {
  assert.throws(
    () =>
      decodeLocalProtocolServerFrame(
        serverFrame("response", {
          outcome: {
            status: "succeeded",
            result: {
              kind: "turn-found",
              turnId: "turn-2",
              state: "terminal",
              updatedAt: "2026-07-29T12:00:00.000Z",
              terminalResponse: TERMINAL_RESPONSE,
            },
          },
        }),
      ),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      decodeLocalProtocolServerFrame(
        serverFrame("response", {
          outcome: {
            status: "succeeded",
            result: {
              kind: "turn-found",
              turnId: "turn-1",
              state: "running",
              updatedAt: "2026-07-29T12:00:00.000Z",
              terminalResponse: TERMINAL_RESPONSE,
            },
          },
        }),
      ),
    CodecDecodeError,
  );

  const oversizedMessages = Array.from(
    { length: LOCAL_PROTOCOL_LIMITS.maximumTerminalMessages },
    (_, index) => ({
      messageId: `message-${index}`,
      sequence: index,
      content: [
        {
          kind: "text",
          text: "x".repeat(LOCAL_PROTOCOL_LIMITS.maximumPromptCharacters),
        },
      ],
    }),
  );
  assert.throws(
    () =>
      encodeCanonicalLocalProtocolServerFrame(
        serverFrame("response", {
          outcome: {
            status: "succeeded",
            result: {
              kind: "turn-found",
              turnId: "turn-1",
              state: "terminal",
              updatedAt: "2026-07-29T12:00:00.000Z",
              terminalResponse: {
                ...TERMINAL_RESPONSE,
                finalizedMessages: oversizedMessages,
              },
            },
          },
        }),
      ),
    CodecDecodeError,
  );
});

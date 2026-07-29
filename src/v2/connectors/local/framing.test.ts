import assert from "node:assert/strict";
import test from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  decodeLocalProtocolClientFrame,
  decodeLocalProtocolServerFrame,
} from "./protocol.js";
import {
  LocalProtocolCorrelationGuard,
  decodeLocalProtocolClientJsonlFrame,
  decodeLocalProtocolServerJsonlFrame,
  encodeLocalProtocolClientJsonlFrame,
  encodeLocalProtocolServerJsonlFrame,
} from "./framing.js";

function request(
  command: unknown,
  requestId = "request-1",
): ReturnType<typeof decodeLocalProtocolClientFrame> {
  return decodeLocalProtocolClientFrame({
    protocol: "hitch.local",
    version: 1,
    frame: "request",
    requestId,
    command,
  });
}

function server(
  frame: "response" | "event" | "stream-end",
  body: Record<string, unknown> = {},
  requestId = "request-1",
): ReturnType<typeof decodeLocalProtocolServerFrame> {
  return decodeLocalProtocolServerFrame({
    protocol: "hitch.local",
    version: 1,
    frame,
    requestId,
    ...body,
  });
}

function jsonl(text: string): Uint8Array {
  return new TextEncoder().encode(`${text}\n`);
}

test("local JSONL round trips canonical client and server frames", () => {
  const image = Buffer.alloc(65_537, 0x41);
  const client = request({
    kind: "submit-turn",
    session: { kind: "session-id", sessionId: "session-1" },
    idempotencyKey: "retry-1",
    text: "inspect",
    image: {
      encoding: "base64",
      byteLength: image.length,
      data: image.toString("base64"),
    },
  });
  const encodedClient = encodeLocalProtocolClientJsonlFrame(client);
  assert.equal(encodedClient.at(-1), 0x0a);
  assert.deepEqual(
    decodeLocalProtocolClientJsonlFrame(encodedClient),
    client,
  );

  const response = server("response", {
    outcome: {
      status: "succeeded",
      result: {
        kind: "turn-submitted",
        turnId: "turn-1",
        status: "starting",
        canCancel: true,
      },
    },
  });
  const encodedServer = encodeLocalProtocolServerJsonlFrame(response);
  assert.equal(encodedServer.at(-1), 0x0a);
  assert.deepEqual(
    decodeLocalProtocolServerJsonlFrame(encodedServer),
    response,
  );
});

test("local JSONL rejects byte, UTF-8, line, and BOM violations before object decoding", () => {
  const valid = encodeLocalProtocolClientJsonlFrame(
    request({ kind: "get-turn", turnId: "turn-1" }),
  );
  const cases = [
    new Uint8Array(),
    new Uint8Array([0x0a]),
    valid.subarray(0, -1),
    new Uint8Array([0xc3, 0x28, 0x0a]),
    new Uint8Array([0xef, 0xbb, 0xbf, ...valid]),
    jsonl('{"protocol":"hitch.local",\r"version":1}'),
    jsonl('{"protocol":"hitch.local",\n"version":1}'),
  ];
  for (const candidate of cases) {
    assert.throws(
      () => decodeLocalProtocolClientJsonlFrame(candidate),
      CodecDecodeError,
    );
  }
  assert.throws(
    () =>
      decodeLocalProtocolClientJsonlFrame(
        new Uint8Array(LOCAL_PROTOCOL_LIMITS.maximumFrameBytes + 1),
      ),
    CodecDecodeError,
  );
});

test("strict local JSON rejects duplicate, deep, and wide structures before command decoding", () => {
  assert.throws(
    () =>
      decodeLocalProtocolClientJsonlFrame(
        jsonl(
          '{"protocol":"hitch.local","protocol":"hitch.local","version":1,"frame":"request","requestId":"request-1","command":{"kind":"get-turn","turnId":"turn-1"}}',
        ),
      ),
    (error) =>
      error instanceof CodecDecodeError &&
      error.issues[0]?.code === "duplicate-item",
  );
  assert.throws(
    () =>
      decodeLocalProtocolClientJsonlFrame(
        jsonl(
          '{"protocol":"hitch.local","version":1,"frame":"request","requestId":"request-1","command":{"kind":"get-turn","kind":"cancel-turn","turnId":"turn-1"}}',
        ),
      ),
    (error) =>
      error instanceof CodecDecodeError &&
      error.issues[0]?.code === "duplicate-item",
  );

  const deep = `${"[".repeat(66)}null${"]".repeat(66)}`;
  assert.throws(
    () => decodeLocalProtocolClientJsonlFrame(jsonl(deep)),
    CodecDecodeError,
  );
  const wide = Object.fromEntries(
    Array.from({ length: 1_025 }, (_, index) => [`field${index}`, index]),
  );
  assert.throws(
    () =>
      decodeLocalProtocolClientJsonlFrame(
        jsonl(JSON.stringify(wide)),
      ),
    CodecDecodeError,
  );
});

test("strict local JSON round trips the maximum structural terminal projection below its byte cap", () => {
  const attachment = {
    kind: "attachment",
    attachmentId: "attachment-1",
    mediaType: "image",
    mimeType: "image/png",
    displayName: "image.png",
  };
  const content = Array.from(
    {
      length:
        LOCAL_PROTOCOL_LIMITS.maximumContentBlocksPerMessage,
    },
    () => attachment,
  );
  const finalizedMessages = Array.from(
    { length: LOCAL_PROTOCOL_LIMITS.maximumTerminalMessages },
    (_, index) => ({
      messageId: `message-${index}`,
      sequence: index,
      content,
    }),
  );
  const frame = server("response", {
    outcome: {
      status: "succeeded",
      result: {
        kind: "turn-found",
        turnId: "turn-1",
        state: "terminal",
        updatedAt: "2026-07-29T12:00:00.000Z",
        terminalResponse: {
          id: "terminal-response-1",
          turnId: "turn-1",
          result: { outcome: "completed" },
          partialOutputAvailable: false,
          finalizedMessages,
          finalizedAt: "2026-07-29T12:00:00.000Z",
        },
      },
    },
  });
  const encoded = encodeLocalProtocolServerJsonlFrame(frame);
  assert.ok(encoded.length < LOCAL_PROTOCOL_LIMITS.maximumFrameBytes);
  const decoded = decodeLocalProtocolServerJsonlFrame(encoded);
  assert.equal(decoded.frame, "response");
  if (
    decoded.frame !== "response" ||
    decoded.outcome.status !== "succeeded" ||
    decoded.outcome.result.kind !== "turn-found" ||
    decoded.outcome.result.state !== "terminal"
  ) {
    assert.fail("expected a decoded terminal Turn response");
  }
  assert.equal(
    decoded.outcome.result.terminalResponse?.finalizedMessages.length,
    LOCAL_PROTOCOL_LIMITS.maximumTerminalMessages,
  );
  assert.equal(
    decoded.outcome.result.terminalResponse?.finalizedMessages[0]?.content
      .length,
    LOCAL_PROTOCOL_LIMITS.maximumContentBlocksPerMessage,
  );
});

test("correlation guard accepts one ordinary request and one streamed Turn exchange", () => {
  const ordinary = new LocalProtocolCorrelationGuard();
  ordinary.acceptClient(
    request({
      kind: "create-session",
      profileReference: "coding",
      workspaceReference: "hitch-hub",
    }),
  );
  ordinary.acceptServer(
    server("response", {
      outcome: {
        status: "succeeded",
        result: { kind: "session-created", sessionId: "session-1" },
      },
    }),
  );
  assert.equal(ordinary.isComplete, true);

  const streamed = new LocalProtocolCorrelationGuard();
  streamed.acceptClient(
    request({
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-1" },
      idempotencyKey: "retry-1",
      text: "hello",
    }),
  );
  streamed.acceptServer(
    server("response", {
      outcome: {
        status: "succeeded",
        result: {
          kind: "turn-submitted",
          turnId: "turn-1",
          status: "starting",
          canCancel: true,
        },
      },
    }),
  );
  streamed.acceptServer(
    server("event", {
      event: {
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
    }),
  );
  assert.equal(streamed.isComplete, false);
  streamed.acceptServer(server("stream-end"));
  assert.equal(streamed.isComplete, true);
});

test("correlation guard rejects multiplexing, response drift, and stream reordering", () => {
  const secondRequest = new LocalProtocolCorrelationGuard();
  secondRequest.acceptClient(
    request({ kind: "get-turn", turnId: "turn-1" }),
  );
  assert.throws(
    () =>
      secondRequest.acceptClient(
        request({ kind: "get-turn", turnId: "turn-2" }, "request-2"),
      ),
    CodecDecodeError,
  );

  const wrongResult = new LocalProtocolCorrelationGuard();
  wrongResult.acceptClient(
    request({ kind: "get-turn", turnId: "turn-1" }),
  );
  assert.throws(
    () =>
      wrongResult.acceptServer(
        server("response", {
          outcome: {
            status: "succeeded",
            result: { kind: "session-created", sessionId: "session-1" },
          },
        }),
      ),
    CodecDecodeError,
  );

  const streamed = new LocalProtocolCorrelationGuard();
  streamed.acceptClient(
    request({
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-1" },
      idempotencyKey: "retry-1",
      text: "hello",
    }),
  );
  const event = server("event", {
    event: {
      kind: "turn-checkpoint",
      turnId: "turn-1",
      sequence: 1,
      payload: { kind: "plan", entries: [] },
    },
  });
  assert.throws(() => streamed.acceptServer(event), CodecDecodeError);

  const correlated = new LocalProtocolCorrelationGuard();
  correlated.acceptClient(
    request({
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-1" },
      idempotencyKey: "retry-1",
      text: "hello",
    }),
  );
  correlated.acceptServer(
    server("response", {
      outcome: {
        status: "succeeded",
        result: {
          kind: "turn-submitted",
          turnId: "turn-1",
          status: "starting",
          canCancel: true,
        },
      },
    }),
  );
  assert.throws(
    () =>
      correlated.acceptServer(
        server("event", {
          event: {
            kind: "turn-checkpoint",
            turnId: "turn-2",
            sequence: 1,
            payload: { kind: "plan", entries: [] },
          },
        }),
      ),
    CodecDecodeError,
  );
  assert.throws(
    () => correlated.acceptServer(server("stream-end", {}, "request-2")),
    CodecDecodeError,
  );
});

test("correlation guard binds every ID-addressed result to its request subject", () => {
  const cases = [
    {
      command: { kind: "get-turn", turnId: "turn-1" },
      result: {
        kind: "turn-found",
        turnId: "turn-2",
        state: "running",
        updatedAt: "2026-07-29T12:00:00.000Z",
      },
    },
    {
      command: { kind: "cancel-turn", turnId: "turn-1" },
      result: { kind: "turn-cancelled", turnId: "turn-2" },
    },
    {
      command: { kind: "stop-session", sessionId: "session-1" },
      result: {
        kind: "session-stop-requested",
        sessionId: "session-2",
      },
    },
    {
      command: {
        kind: "resolve-interaction",
        interactionId: "interaction-1",
        decision: "deny",
      },
      result: {
        kind: "interaction-resolved",
        interactionId: "interaction-2",
      },
    },
  ];

  for (const { command, result } of cases) {
    const guard = new LocalProtocolCorrelationGuard();
    guard.acceptClient(request(command));
    assert.throws(
      () =>
        guard.acceptServer(
          server("response", {
            outcome: { status: "succeeded", result },
          }),
        ),
      CodecDecodeError,
    );
  }
});

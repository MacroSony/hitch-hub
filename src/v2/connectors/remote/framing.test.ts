import assert from "node:assert/strict";
import test from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import {
  decodeRemoteProtocolClientJsonlFrame,
  decodeRemoteProtocolServerJsonlFrame,
  encodeRemoteProtocolClientJsonlFrame,
  encodeRemoteProtocolServerJsonlFrame,
  RemoteProtocolCorrelationGuard,
} from "./framing.js";
import {
  decodeRemoteProtocolClientFrame,
  decodeRemoteProtocolServerFrame,
} from "./protocol.js";

function request(command: unknown, requestId = "remote-request-1") {
  return decodeRemoteProtocolClientFrame({
    protocol: "hitch.remote",
    version: 1,
    frame: "request",
    requestId,
    command,
  });
}

function response(outcome: unknown, requestId = "remote-request-1") {
  return decodeRemoteProtocolServerFrame({
    protocol: "hitch.remote",
    version: 1,
    frame: "response",
    requestId,
    outcome,
  });
}

test("remote JSONL framing round-trips one strict bounded request and response", () => {
  const client = request({ kind: "get-turn", turnId: "turn-1" });
  const server = response({
    status: "succeeded",
    result: {
      kind: "turn-found",
      turnId: "turn-1",
      state: "queued",
      updatedAt: "2026-08-09T12:00:00.000Z",
    },
  });
  assert.deepEqual(
    decodeRemoteProtocolClientJsonlFrame(
      encodeRemoteProtocolClientJsonlFrame(client),
    ),
    client,
  );
  assert.deepEqual(
    decodeRemoteProtocolServerJsonlFrame(
      encodeRemoteProtocolServerJsonlFrame(server),
    ),
    server,
  );
});

test("remote JSONL rejects duplicate fields, CR framing, and multiple frames", () => {
  const invalid = [
    '{"protocol":"hitch.remote","version":1,"frame":"request","requestId":"one","requestId":"two","command":{"kind":"get-turn","turnId":"turn-1"}}\n',
    '{"protocol":"hitch.remote","version":1,"frame":"request","requestId":"one","command":{"kind":"get-turn","turnId":"turn-1"}}\r\n',
    '{"protocol":"hitch.remote","version":1,"frame":"request","requestId":"one","command":{"kind":"get-turn","turnId":"turn-1"}}\n{}\n',
  ];
  for (const frame of invalid) {
    assert.throws(
      () =>
        decodeRemoteProtocolClientJsonlFrame(
          new TextEncoder().encode(frame),
        ),
      CodecDecodeError,
    );
  }
});

test("remote correlation accepts exactly one matching response", () => {
  const guard = new RemoteProtocolCorrelationGuard();
  guard.acceptClient(request({ kind: "cancel-turn", turnId: "turn-1" }));
  guard.acceptServer(
    response({
      status: "succeeded",
      result: { kind: "turn-cancelled", turnId: "turn-1" },
    }),
  );
  assert.equal(guard.isComplete, true);
  assert.throws(
    () =>
      guard.acceptServer(
        response({ status: "rejected", code: "not-found" }),
      ),
    CodecDecodeError,
  );

  const wrongKind = new RemoteProtocolCorrelationGuard();
  wrongKind.acceptClient(request({ kind: "get-turn", turnId: "turn-1" }));
  assert.throws(
    () =>
      wrongKind.acceptServer(
        response({
          status: "succeeded",
          result: { kind: "session-created", sessionId: "session-1" },
        }),
      ),
    CodecDecodeError,
  );

  const wrongSubject = new RemoteProtocolCorrelationGuard();
  wrongSubject.acceptClient(
    request({ kind: "get-turn", turnId: "turn-1" }),
  );
  assert.throws(
    () =>
      wrongSubject.acceptServer(
        response({
          status: "succeeded",
          result: {
            kind: "turn-found",
            turnId: "turn-2",
            state: "queued",
            updatedAt: "2026-08-09T12:00:00.000Z",
          },
        }),
      ),
    CodecDecodeError,
  );
});

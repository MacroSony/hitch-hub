import assert from "node:assert/strict";
import test from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import {
  decodeRemoteProtocolClientFrame,
  decodeRemoteProtocolServerFrame,
  encodeCanonicalRemoteProtocolClientFrame,
  encodeCanonicalRemoteProtocolServerFrame,
} from "./protocol.js";

function request(command: unknown): unknown {
  return {
    protocol: "hitch.remote",
    version: 1,
    frame: "request",
    requestId: "remote-request-1",
    command,
  };
}

test("remote protocol reuses the bounded application command surface with no identity fields", () => {
  const commands = [
    {
      kind: "create-session",
      profileReference: "coding",
      workspaceReference: "workspace-a",
    },
    {
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-1" },
      idempotencyKey: "retry-1",
      text: "inspect the workspace",
    },
    { kind: "get-turn", turnId: "turn-1" },
    { kind: "cancel-turn", turnId: "turn-1" },
    { kind: "stop-session", sessionId: "session-1" },
  ];
  for (const command of commands) {
    const decoded = decodeRemoteProtocolClientFrame(request(command));
    assert.equal(decoded.command.kind, command.kind);
    assert.ok(Object.isFrozen(decoded));
    assert.deepEqual(
      JSON.parse(encodeCanonicalRemoteProtocolClientFrame(decoded)),
      decoded,
    );
  }

  const base = commands[1] as Record<string, unknown>;
  for (const forbidden of [
    ["principalId", "principal-2"],
    ["endpointId", "endpoint-2"],
    ["authorization", { decision: "allowed" }],
  ] as const) {
    assert.throws(
      () =>
        decodeRemoteProtocolClientFrame(
          request({ ...base, [forbidden[0]]: forbidden[1] }),
        ),
      CodecDecodeError,
    );
  }
});

test("remote protocol rejects local administration and attachments", () => {
  const administrative = [
    {
      kind: "resolve-interaction",
      interactionId: "interaction-1",
      decision: "deny",
    },
    {
      kind: "admin-create-principal",
      principalReference: "user-b",
      displayName: "User B",
      role: "member",
      workspaceReference: "workspace-b",
      workspaceRoot: "/srv/hitch/workspaces/user-b",
    },
    { kind: "admin-disable-principal", principalReference: "user-b" },
    {
      kind: "admin-bind-client-certificate",
      principalReference: "user-b",
      bindingReference: "user-b-cert-v1",
      certificateDer: {
        encoding: "base64",
        byteLength: 1,
        data: "eA==",
      },
    },
    {
      kind: "admin-revoke-client-certificate",
      bindingReference: "user-b-cert-v1",
    },
  ];
  for (const command of administrative) {
    assert.throws(
      () => decodeRemoteProtocolClientFrame(request(command)),
      CodecDecodeError,
    );
  }
  assert.throws(
    () =>
      decodeRemoteProtocolClientFrame(
        request({
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: "session-1" },
          idempotencyKey: "retry-image",
          text: "inspect",
          image: { encoding: "base64", byteLength: 1, data: "eA==" },
        }),
      ),
    CodecDecodeError,
  );
});

test("remote server frames retain bounded local response semantics under a distinct protocol name", () => {
  const frame = {
    protocol: "hitch.remote",
    version: 1,
    frame: "response",
    requestId: "remote-request-1",
    outcome: {
      status: "succeeded",
      result: { kind: "session-created", sessionId: "session-1" },
    },
  };
  const decoded = decodeRemoteProtocolServerFrame(frame);
  assert.deepEqual(
    JSON.parse(encodeCanonicalRemoteProtocolServerFrame(decoded)),
    decoded,
  );
  assert.throws(
    () =>
      decodeRemoteProtocolClientFrame({
        ...request({ kind: "get-turn", turnId: "turn-1" }) as object,
        protocol: "hitch.local",
      }),
    CodecDecodeError,
  );

  for (const forbidden of [
    {
      ...frame,
      outcome: {
        status: "succeeded",
        result: { kind: "principal-disabled", principalId: "principal-2" },
      },
    },
    {
      protocol: "hitch.remote",
      version: 1,
      frame: "stream-end",
      requestId: "remote-request-1",
    },
    {
      protocol: "hitch.remote",
      version: 1,
      frame: "event",
      requestId: "remote-request-1",
      event: {
        kind: "response-delivery-state",
        turnId: "turn-1",
        deliveryId: "delivery-1",
        state: "pending",
      },
    },
  ]) {
    assert.throws(
      () => decodeRemoteProtocolServerFrame(forbidden),
      CodecDecodeError,
    );
  }
});

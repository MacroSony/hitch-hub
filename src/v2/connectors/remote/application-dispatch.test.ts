import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthenticatedConnectorContext,
  FirstSliceConnectorApplication,
} from "../../model/application.js";
import { createRemoteProtocolApplicationDispatch } from "./application-dispatch.js";
import {
  decodeRemoteProtocolClientFrame,
  type RemoteProtocolCommandOutcome,
} from "./protocol.js";
import type { AuthenticatedRemoteProtocolExchange } from "./socket.js";

const CONTEXT = Object.freeze({
  actor: Object.freeze({
    kind: "authenticated-principal",
    principalId: "principal-2",
    identityBindingId: "binding-2",
    method: "mtls-client",
    assurance: "normal",
    requestId: "authentication-2",
    authenticatedAt: "2026-08-09T12:00:00.000Z",
  }),
  endpointId: "endpoint-2",
}) as AuthenticatedConnectorContext;

test("remote submit returns a durable receipt and closes rather than iterating the live stream", async () => {
  let closeCount = 0;
  let iterateCount = 0;
  const application: FirstSliceConnectorApplication = {
    execute: (async (context, command) => {
      assert.equal(context, CONTEXT);
      assert.equal(command.kind, "submit-turn");
      assert.equal("image" in command, false);
      return {
        status: "succeeded",
        result: {
          kind: "turn-submitted",
          receipt: {
            turnId: "turn-2",
            status: "queued",
            queue: {
              position: 0,
              controls: { canCancel: true },
            },
          },
        },
        responseEvents: {
          events: {
            [Symbol.asyncIterator]() {
              iterateCount += 1;
              return {
                async next() {
                  return { done: true, value: undefined };
                },
              };
            },
          },
          async close() {
            closeCount += 1;
          },
        },
      };
    }) as FirstSliceConnectorApplication["execute"],
  };
  const request = decodeRemoteProtocolClientFrame({
    protocol: "hitch.remote",
    version: 1,
    frame: "request",
    requestId: "remote-request-2",
    command: {
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-2" },
      idempotencyKey: "retry-2",
      text: "inspect",
    },
  });
  const outcomes: unknown[] = [];
  const dispatch = createRemoteProtocolApplicationDispatch({ application });
  await dispatch(Object.freeze({
    context: CONTEXT,
    request,
    signal: new AbortController().signal,
    async respond(outcome: RemoteProtocolCommandOutcome) {
      outcomes.push(outcome);
    },
  }) satisfies AuthenticatedRemoteProtocolExchange);

  assert.deepEqual(outcomes, [{
    status: "succeeded",
    result: {
      kind: "turn-submitted",
      turnId: "turn-2",
      status: "queued",
      position: 1,
      canCancel: true,
    },
  }]);
  assert.equal(closeCount, 1);
  assert.equal(iterateCount, 0);
});

test("remote submit closes its attached stream when response delivery fails", async () => {
  let closeCount = 0;
  const application: FirstSliceConnectorApplication = {
    execute: (async () => ({
      status: "succeeded",
      result: {
        kind: "turn-submitted",
        receipt: {
          turnId: "turn-2",
          status: "starting",
          controls: { canCancel: true },
        },
      },
      responseEvents: {
        events: {
          async *[Symbol.asyncIterator]() {
            throw new Error("must not iterate");
          },
        },
        async close() {
          closeCount += 1;
        },
      },
    })) as unknown as FirstSliceConnectorApplication["execute"],
  };
  const dispatch = createRemoteProtocolApplicationDispatch({ application });
  const request = decodeRemoteProtocolClientFrame({
    protocol: "hitch.remote",
    version: 1,
    frame: "request",
    requestId: "remote-request-2",
    command: {
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-2" },
      idempotencyKey: "retry-2",
      text: "inspect",
    },
  });
  await assert.rejects(
    dispatch(Object.freeze({
      context: CONTEXT,
      request,
      signal: new AbortController().signal,
      async respond() {
        throw new Error("disconnected");
      },
    }) satisfies AuthenticatedRemoteProtocolExchange),
    /disconnected/u,
  );
  assert.equal(closeCount, 1);
});

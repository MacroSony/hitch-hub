import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthenticatedConnectorContext,
  ConnectorCommand,
  ConnectorCommandResponse,
  ConnectorResponseEvent,
  FirstSliceConnectorApplication,
  LocalAdministrationCommand,
} from "../../model/application.js";
import { createLocalImageIntakeVault } from "../../persistence/attachment-store.js";
import {
  decodeLocalProtocolClientFrame,
  type LocalProtocolCommandOutcome,
} from "./protocol.js";
import type { AuthenticatedLocalProtocolExchange } from "./socket.js";
import {
  LocalProtocolApplicationDispatchError,
  createLocalProtocolApplicationDispatch,
} from "./application-dispatch.js";

const CONTEXT = Object.freeze({
  actor: Object.freeze({
    kind: "authenticated-principal",
    principalId: "principal-1",
    identityBindingId: "binding-1",
    method: "local-peer",
    assurance: "normal",
    requestId: "authentication-1",
    authenticatedAt: "2026-07-29T12:00:00.000Z",
  }),
  endpointId: "endpoint-1",
}) as AuthenticatedConnectorContext;

function application(
  execute: (
    context: AuthenticatedConnectorContext,
    command: ConnectorCommand,
  ) => Promise<unknown>,
): FirstSliceConnectorApplication {
  return Object.freeze({
    execute: execute as FirstSliceConnectorApplication["execute"],
  });
}

function responseFor<Command extends ConnectorCommand>(
  response: ConnectorCommandResponse<Command>,
): ConnectorCommandResponse<Command> {
  return response;
}

function exchange(command: unknown): {
  readonly exchange: AuthenticatedLocalProtocolExchange;
  readonly responses: LocalProtocolCommandOutcome[];
  readonly events: ConnectorResponseEvent[];
  readonly ended: { count: number };
  readonly abort: AbortController;
} {
  const request = decodeLocalProtocolClientFrame({
    protocol: "hitch.local",
    version: 1,
    frame: "request",
    requestId: "request-1",
    command,
  });
  const responses: LocalProtocolCommandOutcome[] = [];
  const events: ConnectorResponseEvent[] = [];
  const ended = { count: 0 };
  const abort = new AbortController();
  return {
    responses,
    events,
    ended,
    abort,
    exchange: Object.freeze({
      context: CONTEXT,
      request,
      signal: abort.signal,
      async respond(outcome: LocalProtocolCommandOutcome) {
        responses.push(outcome);
      },
      async emit(event: ConnectorResponseEvent) {
        events.push(event);
      },
      async endStream() {
        ended.count += 1;
      },
    }),
  };
}

test("authenticated local dispatch maps session creation without adding caller authority", async () => {
  const imageIntake = createLocalImageIntakeVault();
  let observedContext: AuthenticatedConnectorContext | undefined;
  let observedCommand: ConnectorCommand | undefined;
  const dispatch = createLocalProtocolApplicationDispatch({
    imageIntake,
    application: application(async (context, command) => {
      observedContext = context;
      observedCommand = command;
      return responseFor({
        status: "succeeded",
        result: {
          kind: "session-created",
          sessionId: "session-1" as never,
        },
      });
    }),
  });
  const request = exchange({
    kind: "create-session",
    profileReference: "pi-profile",
    workspaceReference: "workspace",
    displayName: "Skeleton",
  });

  await dispatch(request.exchange);

  assert.equal(observedContext, CONTEXT);
  assert.deepEqual(observedCommand, request.exchange.request.command);
  assert.deepEqual(request.responses, [
    {
      status: "succeeded",
      result: { kind: "session-created", sessionId: "session-1" },
    },
  ]);
  assert.equal(request.ended.count, 0);
});

test("submit dispatch seals decoded image bytes and maps a zero-based durable queue receipt", async () => {
  const imageIntake = createLocalImageIntakeVault();
  const imageBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  let closeCount = 0;
  const checkpoint = Object.freeze({
    kind: "response-delivery-state" as const,
    turnId: "turn-1" as never,
    deliveryId: "delivery-1" as never,
    state: "pending" as const,
  });
  const dispatch = createLocalProtocolApplicationDispatch({
    imageIntake,
    application: application(async (context, command) => {
      assert.equal(command.kind, "submit-turn");
      if (command.kind !== "submit-turn" || command.image === undefined) {
        throw new Error("expected a sealed image upload");
      }
      assert.equal("data" in command.image, false);
      const consumed = imageIntake.consume(command.image);
      assert.ok(consumed !== undefined);
      assert.deepEqual(consumed.bytes, imageBytes);
      assert.equal(
        consumed.authenticationRequestId,
        context.actor.requestId,
      );
      return responseFor({
        status: "succeeded",
        result: {
          kind: "turn-submitted",
          receipt: {
            turnId: "turn-1" as never,
            status: "queued",
            queue: {
              turnId: "turn-1" as never,
              position: 0,
              requesterPrincipalId: "principal-1" as never,
              controls: { canCancel: true },
            },
          },
        },
        responseEvents: {
          events: (async function* () {
            yield checkpoint;
          })(),
          async close() {
            closeCount += 1;
          },
        },
      });
    }),
  });
  const request = exchange({
    kind: "submit-turn",
    session: { kind: "session-name", name: "Skeleton" },
    idempotencyKey: "idempotency-1",
    text: "Inspect this image",
    image: {
      encoding: "base64",
      byteLength: imageBytes.length,
      data: imageBytes.toString("base64"),
    },
  });

  await dispatch(request.exchange);

  assert.deepEqual(request.responses, [
    {
      status: "succeeded",
      result: {
        kind: "turn-submitted",
        turnId: "turn-1",
        status: "queued",
        position: 1,
        canCancel: true,
      },
    },
  ]);
  assert.deepEqual(request.events, [checkpoint]);
  assert.equal(request.ended.count, 1);
  assert.equal(closeCount, 1);
});

test("get-turn dispatch flattens the authorized nonterminal runtime projection", async () => {
  const dispatch = createLocalProtocolApplicationDispatch({
    imageIntake: createLocalImageIntakeVault(),
    application: application(async (_context, command) => {
      assert.equal(command.kind, "get-turn");
      return responseFor({
        status: "succeeded",
        result: {
          kind: "turn-found",
          turnId: "turn-1" as never,
          status: "active",
          runtime: {
            turnId: "turn-1" as never,
            state: { status: "queued" },
            updatedAt: "2026-07-29T12:05:00.000Z" as never,
          },
        },
      });
    }),
  });
  const request = exchange({ kind: "get-turn", turnId: "turn-1" });

  await dispatch(request.exchange);

  assert.deepEqual(request.responses, [
    {
      status: "succeeded",
      result: {
        kind: "turn-found",
        turnId: "turn-1",
        state: "queued",
        updatedAt: "2026-07-29T12:05:00.000Z",
      },
    },
  ]);
});

test("application rejection remains one bounded response with no stream", async () => {
  const dispatch = createLocalProtocolApplicationDispatch({
    imageIntake: createLocalImageIntakeVault(),
    application: application(async () => responseFor({
      status: "rejected",
      code: "not-authorized",
    })),
  });
  const request = exchange({
    kind: "submit-turn",
    session: { kind: "session-id", sessionId: "session-1" },
    idempotencyKey: "idempotency-1",
    text: "Denied",
  });

  await dispatch(request.exchange);

  assert.deepEqual(request.responses, [
    { status: "rejected", code: "not-authorized" },
  ]);
  assert.equal(request.ended.count, 0);
});

test("attached stream failures close exactly once and fail the exchange", async () => {
  let closeCount = 0;
  const dispatch = createLocalProtocolApplicationDispatch({
    imageIntake: createLocalImageIntakeVault(),
    application: application(async () => responseFor({
      status: "succeeded",
      result: {
        kind: "turn-submitted",
        receipt: {
          turnId: "turn-1" as never,
          status: "starting",
          controls: { canCancel: false },
        },
      },
      responseEvents: {
        events: (async function* () {
          throw new Error("subscription failed");
        })(),
        async close() {
          closeCount += 1;
        },
      },
    })),
  });
  const request = exchange({
    kind: "submit-turn",
    session: { kind: "session-id", sessionId: "session-1" },
    idempotencyKey: "idempotency-1",
    text: "Start",
  });

  await assert.rejects(
    dispatch(request.exchange),
    /subscription failed/u,
  );
  assert.equal(closeCount, 1);
  assert.equal(request.ended.count, 0);

  const closeFailure = createLocalProtocolApplicationDispatch({
    imageIntake: createLocalImageIntakeVault(),
    application: application(async () => responseFor({
      status: "succeeded",
      result: {
        kind: "turn-submitted",
        receipt: {
          turnId: "turn-2" as never,
          status: "starting",
          controls: { canCancel: false },
        },
      },
      responseEvents: {
        events: (async function* () {})(),
        async close() {
          throw new Error("close failed");
        },
      },
    })),
  });
  await assert.rejects(
    closeFailure(exchange({
      kind: "submit-turn",
      session: { kind: "session-id", sessionId: "session-1" },
      idempotencyKey: "idempotency-2",
      text: "Start again",
    }).exchange),
    LocalProtocolApplicationDispatchError,
  );
});

test("local administration dispatch converts bounded certificate DER without invoking the user application", async () => {
  let observed: LocalAdministrationCommand | undefined;
  const dispatch = createLocalProtocolApplicationDispatch({
    imageIntake: createLocalImageIntakeVault(),
    application: application(async () => {
      throw new Error("ordinary application must not receive administration");
    }),
    administration: Object.freeze({
      async execute(
        context: AuthenticatedConnectorContext,
        command: LocalAdministrationCommand,
      ) {
        assert.equal(context, CONTEXT);
        observed = command;
        return {
          status: "succeeded" as const,
          result: {
            kind: "client-certificate-bound" as const,
            principalId: "principal-2" as never,
            identityBindingId: "binding-2" as never,
            fingerprint: `sha256:${"ab".repeat(32)}` as never,
          },
        };
      },
    }),
  });
  const request = exchange({
    kind: "admin-bind-client-certificate",
    principalReference: "user-b",
    bindingReference: "user-b-cert-v1",
    certificateDer: {
      encoding: "base64",
      byteLength: 5,
      data: "aGVsbG8=",
    },
  });
  await dispatch(request.exchange);
  assert.deepEqual(observed, {
    kind: "bind-client-certificate",
    principalReference: "user-b",
    bindingReference: "user-b-cert-v1",
    completeDer: Buffer.from("hello"),
  });
  assert.deepEqual(request.responses, [
    {
      status: "succeeded",
      result: {
        kind: "client-certificate-bound",
        principalId: "principal-2",
        identityBindingId: "binding-2",
        fingerprint: `sha256:${"ab".repeat(32)}`,
      },
    },
  ]);
});

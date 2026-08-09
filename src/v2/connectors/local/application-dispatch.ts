/**
 * V2-008c: authenticated local-protocol to application dispatch.
 *
 * The socket has already authenticated the connection and decoded one closed
 * protocol frame before this adapter runs. This layer performs the remaining
 * connector-owned work: it converts bounded image bytes into an opaque
 * process-local intake, invokes the application with trusted authentication
 * context, projects semantic results onto the wire contract, and closes an
 * attached response stream on completion or disconnect.
 */

import type {
  AttachedConnectorResponseStream,
  ConnectorCommandFailureCode,
  FirstSliceConnectorApplication,
  GetTurnConnectorCommand,
  LocalAdministrationPort,
} from "../../model/application.js";
import type { LocalImageIntakeVault } from "../../persistence/attachment-store.js";
import type { AuthenticatedLocalProtocolExchange } from "./socket.js";
import type {
  LocalProtocolCommandOutcome,
  LocalProtocolCommandResult,
} from "./protocol.js";

export interface LocalProtocolApplicationDispatchOptions {
  readonly application: FirstSliceConnectorApplication;
  readonly imageIntake: LocalImageIntakeVault;
  readonly administration?: LocalAdministrationPort;
}

export class LocalProtocolApplicationDispatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalProtocolApplicationDispatchError";
  }
}

function rejected(
  code: ConnectorCommandFailureCode,
): LocalProtocolCommandOutcome {
  return Object.freeze({ status: "rejected" as const, code });
}

function succeeded(
  result: LocalProtocolCommandResult,
): LocalProtocolCommandOutcome {
  return Object.freeze({ status: "succeeded" as const, result });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("local request was aborted", "AbortError");
}

async function closeResponseStream(
  stream: AttachedConnectorResponseStream,
): Promise<void> {
  try {
    await stream.close();
  } catch (error) {
    throw new LocalProtocolApplicationDispatchError(
      "unable to close the attached connector response stream",
      { cause: error },
    );
  }
}

async function emitAttachedResponseStream(
  exchange: AuthenticatedLocalProtocolExchange,
  stream: AttachedConnectorResponseStream,
): Promise<void> {
  let closePromise: Promise<void> | undefined;
  const closeOnce = (): Promise<void> => {
    closePromise ??= closeResponseStream(stream);
    return closePromise;
  };
  const onAbort = (): void => {
    void closeOnce().catch(() => undefined);
  };
  exchange.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const event of stream.events) {
      if (exchange.signal.aborted) throw abortReason(exchange.signal);
      await exchange.emit(event);
    }
    if (exchange.signal.aborted) throw abortReason(exchange.signal);
    await exchange.endStream();
  } finally {
    exchange.signal.removeEventListener("abort", onAbort);
    await closeOnce();
  }
}

function projectTurnQueryResult(
  result: Extract<
    Awaited<
      ReturnType<FirstSliceConnectorApplication["execute"]>
    >,
    { readonly status: "succeeded" }
  >["result"],
): LocalProtocolCommandResult {
  if (result.kind !== "turn-found") {
    throw new LocalProtocolApplicationDispatchError(
      "get-turn returned an incompatible application result",
    );
  }
  if (result.status === "terminal") {
    return Object.freeze({
      kind: "turn-found" as const,
      turnId: result.turnId,
      state: result.runtime.state.status,
      updatedAt: result.runtime.updatedAt,
      terminalResponse: result.terminalResponse,
    });
  }
  return Object.freeze({
    kind: "turn-found" as const,
    turnId: result.turnId,
    state: result.runtime.state.status,
    updatedAt: result.runtime.updatedAt,
  });
}

/** Creates the handler passed directly to `listenLocalProtocolSocket`. */
export function createLocalProtocolApplicationDispatch(
  options: LocalProtocolApplicationDispatchOptions,
): (exchange: AuthenticatedLocalProtocolExchange) => Promise<void> {
  const { application, imageIntake, administration } = options;

  return async (exchange): Promise<void> => {
    if (exchange.signal.aborted) throw abortReason(exchange.signal);
    const command = exchange.request.command;

    switch (command.kind) {
      case "create-session": {
        const response = await application.execute(
          exchange.context,
          command,
        );
        await exchange.respond(
          response.status === "rejected"
            ? rejected(response.code)
            : succeeded(Object.freeze({
                kind: "session-created" as const,
                sessionId: response.result.sessionId,
              })),
        );
        return;
      }

      case "submit-turn": {
        const image = command.image === undefined
          ? undefined
          : imageIntake.seal({
              bytes: Buffer.from(command.image.data, "base64"),
              authenticationRequestId: exchange.context.actor.requestId,
            });
        const applicationCommand = Object.freeze({
          kind: "submit-turn" as const,
          session: command.session,
          idempotencyKey: command.idempotencyKey,
          text: command.text,
          ...(image === undefined ? {} : { image }),
        });
        const response = await application.execute(
          exchange.context,
          applicationCommand,
        );
        if (response.status === "rejected") {
          await exchange.respond(rejected(response.code));
          return;
        }
        const receipt = response.result.receipt;
        const result: LocalProtocolCommandResult = receipt.status === "starting"
          ? Object.freeze({
              kind: "turn-submitted" as const,
              turnId: receipt.turnId,
              status: "starting" as const,
              canCancel: receipt.controls.canCancel,
            })
          : Object.freeze({
              kind: "turn-submitted" as const,
              turnId: receipt.turnId,
              status: "queued" as const,
              // The durable queue is zero-based; the user-facing protocol is
              // deliberately one-based and rejects zero.
              position: receipt.queue.position + 1,
              canCancel: receipt.queue.controls.canCancel,
            });
        await exchange.respond(succeeded(result));
        await emitAttachedResponseStream(exchange, response.responseEvents);
        return;
      }

      case "get-turn": {
        const applicationCommand: GetTurnConnectorCommand = command;
        const response = await application.execute(
          exchange.context,
          applicationCommand,
        );
        await exchange.respond(
          response.status === "rejected"
            ? rejected(response.code)
            : succeeded(projectTurnQueryResult(response.result)),
        );
        return;
      }

      case "cancel-turn":
      case "stop-session":
      case "resolve-interaction": {
        const response = await application.execute(
          exchange.context,
          command,
        );
        await exchange.respond(
          response.status === "rejected"
            ? rejected(response.code)
            : succeeded(response.result),
        );
        return;
      }

      case "admin-create-principal":
      case "admin-disable-principal":
      case "admin-bind-client-certificate":
      case "admin-revoke-client-certificate": {
        if (administration === undefined) {
          // A walking-skeleton composition without the explicit local
          // administration boundary fails closed.
          await exchange.respond(rejected("invalid-request"));
          return;
        }
        const adminCommand = command.kind === "admin-create-principal"
          ? Object.freeze({
              kind: "create-principal" as const,
              principalReference: command.principalReference,
              displayName: command.displayName,
              role: command.role,
              workspaceReference: command.workspaceReference,
              canonicalWorkspaceRoot: command.workspaceRoot,
            })
          : command.kind === "admin-disable-principal"
            ? Object.freeze({
                kind: "disable-principal" as const,
                principalReference: command.principalReference,
              })
            : command.kind === "admin-bind-client-certificate"
              ? Object.freeze({
                  kind: "bind-client-certificate" as const,
                  principalReference: command.principalReference,
                  bindingReference: command.bindingReference,
                  completeDer: Buffer.from(command.certificateDer.data, "base64"),
                })
              : Object.freeze({
                  kind: "revoke-client-certificate" as const,
                  bindingReference: command.bindingReference,
                });
        const response = await administration.execute(
          exchange.context,
          adminCommand,
        );
        await exchange.respond(
          response.status === "rejected"
            ? rejected(response.code)
            : succeeded(response.result),
        );
        return;
      }
    }
  };
}

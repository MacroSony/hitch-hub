import type {
  AttachedConnectorResponseStream,
  ConnectorCommandFailureCode,
  FirstSliceConnectorApplication,
  GetTurnConnectorCommand,
} from "../../model/application.js";
import type { AuthenticatedRemoteProtocolExchange } from "./socket.js";
import type {
  RemoteProtocolCommandOutcome,
  RemoteProtocolCommandResult,
} from "./protocol.js";

export class RemoteProtocolApplicationDispatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteProtocolApplicationDispatchError";
  }
}

function rejected(
  code: ConnectorCommandFailureCode,
): RemoteProtocolCommandOutcome {
  return Object.freeze({ status: "rejected" as const, code });
}

function succeeded(
  result: RemoteProtocolCommandResult,
): RemoteProtocolCommandOutcome {
  return Object.freeze({ status: "succeeded" as const, result });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("remote request was aborted", "AbortError");
}

async function closeDeferredResponseStream(
  stream: AttachedConnectorResponseStream,
): Promise<void> {
  try {
    await stream.close();
  } catch (error) {
    throw new RemoteProtocolApplicationDispatchError(
      "unable to close the deferred remote response stream",
      { cause: error },
    );
  }
}

function projectTurnQueryResult(
  result: Extract<
    Awaited<ReturnType<FirstSliceConnectorApplication["execute"]>>,
    { readonly status: "succeeded" }
  >["result"],
): RemoteProtocolCommandResult {
  if (result.kind !== "turn-found") {
    throw new RemoteProtocolApplicationDispatchError(
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

/**
 * Remote MVP dispatch is response-only. A successful submission still returns
 * its durable receipt, but the attached live event stream is immediately
 * closed; clients retrieve state and terminal output with `get-turn`.
 */
export function createRemoteProtocolApplicationDispatch(options: {
  readonly application: FirstSliceConnectorApplication;
}): (exchange: AuthenticatedRemoteProtocolExchange) => Promise<void> {
  const { application } = options;

  return async (exchange): Promise<void> => {
    if (exchange.signal.aborted) throw abortReason(exchange.signal);
    const command = exchange.request.command;

    switch (command.kind) {
      case "create-session": {
        const response = await application.execute(exchange.context, command);
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
        const response = await application.execute(exchange.context, command);
        if (response.status === "rejected") {
          await exchange.respond(rejected(response.code));
          return;
        }
        const receipt = response.result.receipt;
        const result: RemoteProtocolCommandResult = receipt.status === "starting"
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
              position: receipt.queue.position + 1,
              canCancel: receipt.queue.controls.canCancel,
            });
        try {
          await exchange.respond(succeeded(result));
        } finally {
          await closeDeferredResponseStream(response.responseEvents);
        }
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
      case "stop-session": {
        const response = await application.execute(exchange.context, command);
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

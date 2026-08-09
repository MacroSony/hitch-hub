import { codecFail } from "../../codecs/errors.js";
import type { ConnectorCommandFailureCode } from "../../model/application.js";
import {
  decodeLiteral,
  decodePlainObject,
} from "../../codecs/structure.js";
import type {
  LocalApplicationProtocolCommand,
  LocalProtocolClientFrame,
  LocalProtocolCommandResult,
} from "../local/protocol.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  LOCAL_PROTOCOL_NAME,
  LOCAL_PROTOCOL_VERSION,
  decodeLocalProtocolClientFrame,
  decodeLocalProtocolServerFrame,
} from "../local/protocol.js";

export const REMOTE_PROTOCOL_NAME = "hitch.remote" as const;
export const REMOTE_PROTOCOL_VERSION = 1 as const;

type RemoteTextTurnCommand = Omit<
  Extract<LocalApplicationProtocolCommand, { readonly kind: "submit-turn" }>,
  "image"
> & { readonly image?: never };

export type RemoteProtocolCommand =
  | Exclude<
      LocalApplicationProtocolCommand,
      { readonly kind: "submit-turn" | "resolve-interaction" }
    >
  | RemoteTextTurnCommand;

export interface RemoteProtocolClientFrame {
  readonly protocol: typeof REMOTE_PROTOCOL_NAME;
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly frame: "request";
  readonly requestId: string;
  readonly command: RemoteProtocolCommand;
}

export type RemoteProtocolCommandResult = Exclude<
  LocalProtocolCommandResult,
  | { readonly kind: "interaction-resolved" | "interaction-not-pending" }
  | {
      readonly kind:
        | "principal-created"
        | "principal-disabled"
        | "principal-already-disabled"
        | "client-certificate-bound"
        | "client-certificate-revoked"
        | "client-certificate-already-revoked";
    }
>;

export type RemoteProtocolCommandOutcome =
  | { readonly status: "rejected"; readonly code: ConnectorCommandFailureCode }
  | { readonly status: "succeeded"; readonly result: RemoteProtocolCommandResult };

/** Live event streaming and every administrator result are deferred. */
export interface RemoteProtocolServerFrame {
  readonly protocol: typeof REMOTE_PROTOCOL_NAME;
  readonly version: typeof REMOTE_PROTOCOL_VERSION;
  readonly frame: "response";
  readonly requestId: string;
  readonly outcome: RemoteProtocolCommandOutcome;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function requireRemoteEnvelope(input: unknown): Record<string, unknown> {
  const object = decodePlainObject(input);
  decodeLiteral(object.protocol, REMOTE_PROTOCOL_NAME, ["protocol"]);
  if (object.version !== REMOTE_PROTOCOL_VERSION) {
    codecFail(
      ["version"],
      "invalid-format",
      `expected remote protocol version ${REMOTE_PROTOCOL_VERSION}`,
    );
  }
  return object;
}

function asLocalEnvelope(
  object: Record<string, unknown>,
): Record<string, unknown> {
  return { ...object, protocol: LOCAL_PROTOCOL_NAME };
}

function isLocalAdministrationCommand(
  command: LocalProtocolClientFrame["command"],
): boolean {
  return command.kind.startsWith("admin-");
}

function isRemoteCommand(
  command: LocalProtocolClientFrame["command"],
): command is RemoteProtocolCommand {
  switch (command.kind) {
    case "create-session":
    case "submit-turn":
    case "get-turn":
    case "cancel-turn":
    case "stop-session":
      return true;
    case "resolve-interaction":
    case "admin-create-principal":
    case "admin-disable-principal":
    case "admin-bind-client-certificate":
    case "admin-revoke-client-certificate":
      return false;
  }
}

function isRemoteResult(
  result: LocalProtocolCommandResult,
): result is RemoteProtocolCommandResult {
  switch (result.kind) {
    case "session-created":
    case "turn-submitted":
    case "turn-found":
    case "turn-cancelled":
    case "turn-already-cancelled":
    case "turn-not-cancelled":
    case "session-stop-requested":
    case "session-already-stopped":
      return true;
    case "interaction-resolved":
    case "interaction-not-pending":
    case "principal-created":
    case "principal-disabled":
    case "principal-already-disabled":
    case "client-certificate-bound":
    case "client-certificate-revoked":
    case "client-certificate-already-revoked":
      return false;
  }
}

/**
 * Reuses the strict bounded local command codec, then narrows the remote
 * surface to user application commands and text-only submission. Identity,
 * host paths, certificate administration, and attachments remain absent.
 */
export function decodeRemoteProtocolClientFrame(
  input: unknown,
): RemoteProtocolClientFrame {
  const object = requireRemoteEnvelope(input);
  const decoded = decodeLocalProtocolClientFrame(asLocalEnvelope(object));
  if (isLocalAdministrationCommand(decoded.command)) {
    codecFail(
      ["command", "kind"],
      "unsupported-discriminant",
      "remote administration is not exposed",
    );
  }
  if (!isRemoteCommand(decoded.command)) {
    codecFail(
      ["command", "kind"],
      "unsupported-discriminant",
      "remote interactions are deferred from the MVP",
    );
  }
  if (
    decoded.command.kind === "submit-turn" &&
    decoded.command.image !== undefined
  ) {
    codecFail(
      ["command", "image"],
      "unknown-field",
      "remote attachments are deferred from the MVP",
    );
  }
  return deepFreeze({
    protocol: REMOTE_PROTOCOL_NAME,
    version: REMOTE_PROTOCOL_VERSION,
    frame: "request" as const,
    requestId: decoded.requestId,
    command: decoded.command,
  });
}

export function decodeRemoteProtocolServerFrame(
  input: unknown,
): RemoteProtocolServerFrame {
  const object = requireRemoteEnvelope(input);
  const decoded = decodeLocalProtocolServerFrame(asLocalEnvelope(object));
  if (decoded.frame !== "response") {
    codecFail(
      ["frame"],
      "unsupported-discriminant",
      "live remote response streaming is deferred from the MVP",
    );
  }
  if (
    decoded.outcome.status === "succeeded" &&
    !isRemoteResult(decoded.outcome.result)
  ) {
    codecFail(
      ["outcome", "result", "kind"],
      "unsupported-discriminant",
      "local-only results cannot cross the remote protocol",
    );
  }
  return deepFreeze({
    protocol: REMOTE_PROTOCOL_NAME,
    version: REMOTE_PROTOCOL_VERSION,
    frame: "response" as const,
    requestId: decoded.requestId,
    outcome: decoded.outcome as RemoteProtocolCommandOutcome,
  });
}

function encodeBounded(input: unknown, side: "client" | "server"): string {
  const decoded = side === "client"
    ? decodeRemoteProtocolClientFrame(input)
    : decodeRemoteProtocolServerFrame(input);
  const encoded = JSON.stringify(decoded);
  if (
    Buffer.byteLength(encoded, "utf8") >
      LOCAL_PROTOCOL_LIMITS.maximumFrameBytes
  ) {
    codecFail([], "too-long", "encoded remote protocol frame exceeds its byte limit");
  }
  return encoded;
}

export function encodeCanonicalRemoteProtocolClientFrame(
  input: unknown,
): string {
  return encodeBounded(input, "client");
}

export function encodeCanonicalRemoteProtocolServerFrame(
  input: unknown,
): string {
  return encodeBounded(input, "server");
}

import { codecFail } from "../../codecs/errors.js";
import {
  decodeStrictBoundedProtocolJsonl,
  encodeBoundedProtocolJsonl,
} from "../local/framing.js";
import {
  decodeRemoteProtocolClientFrame,
  decodeRemoteProtocolServerFrame,
  encodeCanonicalRemoteProtocolClientFrame,
  encodeCanonicalRemoteProtocolServerFrame,
  type RemoteProtocolClientFrame,
  type RemoteProtocolCommand,
  type RemoteProtocolCommandResult,
  type RemoteProtocolServerFrame,
} from "./protocol.js";

type RemoteCommandKind = RemoteProtocolCommand["kind"];

interface CorrelatedRemoteRequest {
  readonly requestId: string;
  readonly commandKind: RemoteCommandKind;
  readonly subjectId?: string;
}

function commandSubjectId(
  command: RemoteProtocolCommand,
): string | undefined {
  switch (command.kind) {
    case "get-turn":
    case "cancel-turn":
      return command.turnId;
    case "stop-session":
      return command.sessionId;
    case "create-session":
    case "submit-turn":
      return undefined;
  }
}

function resultSubjectId(
  result: RemoteProtocolCommandResult,
): string | undefined {
  switch (result.kind) {
    case "turn-found":
    case "turn-cancelled":
    case "turn-already-cancelled":
    case "turn-not-cancelled":
      return result.turnId;
    case "session-stop-requested":
    case "session-already-stopped":
      return result.sessionId;
    case "session-created":
    case "turn-submitted":
      return undefined;
  }
}

function resultMatchesCommand(
  command: RemoteCommandKind,
  result: RemoteProtocolCommandResult,
): boolean {
  switch (command) {
    case "create-session":
      return result.kind === "session-created";
    case "submit-turn":
      return result.kind === "turn-submitted";
    case "get-turn":
      return result.kind === "turn-found";
    case "cancel-turn":
      return (
        result.kind === "turn-cancelled" ||
        result.kind === "turn-already-cancelled" ||
        result.kind === "turn-not-cancelled"
      );
    case "stop-session":
      return (
        result.kind === "session-stop-requested" ||
        result.kind === "session-already-stopped"
      );
  }
}

export function encodeRemoteProtocolClientJsonlFrame(
  input: unknown,
): Uint8Array {
  return encodeBoundedProtocolJsonl(
    encodeCanonicalRemoteProtocolClientFrame(input),
    "remote",
  );
}

export function encodeRemoteProtocolServerJsonlFrame(
  input: unknown,
): Uint8Array {
  return encodeBoundedProtocolJsonl(
    encodeCanonicalRemoteProtocolServerFrame(input),
    "remote",
  );
}

export function decodeRemoteProtocolClientJsonlFrame(
  bytes: Uint8Array,
): RemoteProtocolClientFrame {
  return decodeRemoteProtocolClientFrame(
    decodeStrictBoundedProtocolJsonl(bytes, "remote"),
  );
}

export function decodeRemoteProtocolServerJsonlFrame(
  bytes: Uint8Array,
): RemoteProtocolServerFrame {
  return decodeRemoteProtocolServerFrame(
    decodeStrictBoundedProtocolJsonl(bytes, "remote"),
  );
}

/** One remote TLS connection carries exactly one request and one response. */
export class RemoteProtocolCorrelationGuard {
  #request?: CorrelatedRemoteRequest;
  #complete = false;

  get isComplete(): boolean {
    return this.#complete;
  }

  acceptClient(frame: RemoteProtocolClientFrame): void {
    if (this.#request !== undefined || this.#complete) {
      codecFail(
        ["requestId"],
        "duplicate-item",
        "a remote connection accepts exactly one request",
      );
    }
    const subjectId = commandSubjectId(frame.command);
    this.#request = Object.freeze({
      requestId: frame.requestId,
      commandKind: frame.command.kind,
      ...(subjectId === undefined ? {} : { subjectId }),
    });
  }

  acceptServer(frame: RemoteProtocolServerFrame): void {
    const request = this.#request;
    if (request === undefined) {
      codecFail(
        ["requestId"],
        "invalid-format",
        "remote response has no correlated request",
      );
    }
    if (this.#complete) {
      codecFail(
        ["frame"],
        "duplicate-item",
        "remote request exchange is already complete",
      );
    }
    if (frame.requestId !== request.requestId) {
      codecFail(
        ["requestId"],
        "invalid-format",
        "remote response correlation does not match",
      );
    }
    if (frame.outcome.status === "succeeded") {
      if (!resultMatchesCommand(request.commandKind, frame.outcome.result)) {
        codecFail(
          ["outcome", "result", "kind"],
          "invalid-format",
          "remote response kind does not match its request command",
        );
      }
      if (
        request.subjectId !== undefined &&
        resultSubjectId(frame.outcome.result) !== request.subjectId
      ) {
        codecFail(
          ["outcome", "result"],
          "invalid-format",
          "remote response subject does not match its request command",
        );
      }
    }
    this.#complete = true;
  }
}

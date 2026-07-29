import { codecFail } from "../../codecs/errors.js";
import type {
  LocalProtocolClientFrame,
  LocalProtocolCommand,
  LocalProtocolCommandResult,
  LocalProtocolServerFrame,
} from "./protocol.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  decodeLocalProtocolClientFrame,
  decodeLocalProtocolServerFrame,
  encodeCanonicalLocalProtocolClientFrame,
  encodeCanonicalLocalProtocolServerFrame,
} from "./protocol.js";

const JSON_PARSER_LIMITS = Object.freeze({
  maximumDepth: 64,
  // A maximal terminal response contains 256 message objects, each with a
  // 256-item content array. The widest content block has one object plus five
  // scalar values. Keep a fixed envelope/result allowance above that exact
  // multiplicative structural maximum.
  maximumNodes:
    LOCAL_PROTOCOL_LIMITS.maximumTerminalMessages *
      (4 +
        LOCAL_PROTOCOL_LIMITS.maximumContentBlocksPerMessage * 6) +
    1_024,
  maximumContainerItems: 1_024,
  maximumStringCharacters: LOCAL_PROTOCOL_LIMITS.maximumFrameBytes,
});

type LocalCommandKind = LocalProtocolCommand["kind"];

interface CorrelatedRequest {
  readonly requestId: string;
  readonly commandKind: LocalCommandKind;
  readonly subjectId?: string;
  responseSeen: boolean;
  streamingTurnId?: string;
}

function commandSubjectId(
  command: LocalProtocolCommand,
): string | undefined {
  switch (command.kind) {
    case "get-turn":
    case "cancel-turn":
      return command.turnId;
    case "stop-session":
      return command.sessionId;
    case "resolve-interaction":
      return command.interactionId;
    case "create-session":
    case "submit-turn":
      return undefined;
  }
}

function resultSubjectId(
  result: LocalProtocolCommandResult,
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
    case "interaction-resolved":
    case "interaction-not-pending":
      return result.interactionId;
    case "session-created":
    case "turn-submitted":
      return undefined;
  }
}

function parseStrictJson(input: string): unknown {
  let index = 0;
  let nodes = 0;

  const whitespace = (): void => {
    while (
      input[index] === " " ||
      input[index] === "\t" ||
      input[index] === "\r" ||
      input[index] === "\n"
    ) {
      index += 1;
    }
  };

  const fail = (message: string): never =>
    codecFail(
      [],
      "invalid-format",
      `invalid local protocol JSON: ${message}`,
    );

  const string = (): string => {
    if (input[index] !== '"') return fail("expected a string");
    const start = index;
    index += 1;
    let escaped = false;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code < 0x20) return fail("control character in string");
      if (!escaped && input[index] === '"') {
        index += 1;
        try {
          const decoded = JSON.parse(input.slice(start, index)) as string;
          if (
            decoded.length >
            JSON_PARSER_LIMITS.maximumStringCharacters
          ) {
            return fail("string exceeds parser limit");
          }
          return decoded;
        } catch {
          return fail("invalid string escape");
        }
      }
      if (!escaped && input[index] === "\\") escaped = true;
      else escaped = false;
      index += 1;
    }
    return fail("unterminated string");
  };

  const value = (depth: number): unknown => {
    nodes += 1;
    if (nodes > JSON_PARSER_LIMITS.maximumNodes) {
      return fail("node limit exceeded");
    }
    if (depth > JSON_PARSER_LIMITS.maximumDepth) {
      return fail("nesting limit exceeded");
    }
    whitespace();
    const token = input[index];
    if (token === '"') return string();
    if (token === "{") {
      index += 1;
      whitespace();
      const output: Record<string, unknown> = {};
      const seen = new Set<string>();
      if (input[index] === "}") {
        index += 1;
        return output;
      }
      while (true) {
        if (seen.size >= JSON_PARSER_LIMITS.maximumContainerItems) {
          return fail("object field limit exceeded");
        }
        whitespace();
        const key = string();
        if (seen.has(key)) {
          codecFail(
            [key],
            "duplicate-item",
            "duplicate local protocol JSON object field",
          );
        }
        seen.add(key);
        whitespace();
        if (input[index] !== ":") return fail("expected colon");
        index += 1;
        const child = value(depth + 1);
        Object.defineProperty(output, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        whitespace();
        if (input[index] === "}") {
          index += 1;
          return output;
        }
        if (input[index] !== ",") {
          return fail("expected comma or object end");
        }
        index += 1;
      }
    }
    if (token === "[") {
      index += 1;
      whitespace();
      const output: unknown[] = [];
      if (input[index] === "]") {
        index += 1;
        return output;
      }
      while (true) {
        if (
          output.length >= JSON_PARSER_LIMITS.maximumContainerItems
        ) {
          return fail("array item limit exceeded");
        }
        output.push(value(depth + 1));
        whitespace();
        if (input[index] === "]") {
          index += 1;
          return output;
        }
        if (input[index] !== ",") {
          return fail("expected comma or array end");
        }
        index += 1;
      }
    }
    if (input.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (input.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (input.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const number = input
      .slice(index)
      .match(
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u,
      )?.[0];
    if (number !== undefined) {
      index += number.length;
      const parsed = Number(number);
      if (!Number.isFinite(parsed)) return fail("non-finite number");
      return parsed;
    }
    return fail("unexpected token");
  };

  const parsed = value(0);
  whitespace();
  if (index !== input.length) return fail("trailing data");
  return parsed;
}

function decodeJsonlText(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    codecFail([], "invalid-type", "local JSONL frame must be bytes");
  }
  if (
    bytes.length <= 1 ||
    bytes.length > LOCAL_PROTOCOL_LIMITS.maximumFrameBytes
  ) {
    codecFail(
      [],
      "too-long",
      "local JSONL frame violates the byte limit",
    );
  }
  if (bytes[bytes.length - 1] !== 0x0a) {
    codecFail(
      [],
      "invalid-format",
      "local JSONL requires one non-blank LF-terminated frame",
    );
  }
  for (let byteIndex = 0; byteIndex < bytes.length - 1; byteIndex += 1) {
    const byte = bytes[byteIndex]!;
    if (byte === 0x0a || byte === 0x0d) {
      codecFail(
        [],
        "invalid-format",
        "local JSONL forbids embedded or CR line breaks",
      );
    }
  }
  if (
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    codecFail(
      [],
      "invalid-format",
      "local JSONL forbids a UTF-8 byte-order mark",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, -1),
    );
  } catch {
    codecFail([], "invalid-format", "local JSONL is not valid UTF-8");
  }
}

function encodeJsonl(encoded: string): Uint8Array {
  const bytes = new TextEncoder().encode(`${encoded}\n`);
  if (bytes.length > LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
    codecFail(
      [],
      "too-long",
      "encoded local JSONL frame exceeds the byte limit",
    );
  }
  return bytes;
}

export function encodeLocalProtocolClientJsonlFrame(
  input: unknown,
): Uint8Array {
  return encodeJsonl(encodeCanonicalLocalProtocolClientFrame(input));
}

export function encodeLocalProtocolServerJsonlFrame(
  input: unknown,
): Uint8Array {
  return encodeJsonl(encodeCanonicalLocalProtocolServerFrame(input));
}

export function decodeLocalProtocolClientJsonlFrame(
  bytes: Uint8Array,
): LocalProtocolClientFrame {
  return decodeLocalProtocolClientFrame(
    parseStrictJson(decodeJsonlText(bytes)),
  );
}

export function decodeLocalProtocolServerJsonlFrame(
  bytes: Uint8Array,
): LocalProtocolServerFrame {
  return decodeLocalProtocolServerFrame(
    parseStrictJson(decodeJsonlText(bytes)),
  );
}

function resultMatchesCommand(
  command: LocalCommandKind,
  result: LocalProtocolCommandResult,
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
    case "resolve-interaction":
      return (
        result.kind === "interaction-resolved" ||
        result.kind === "interaction-not-pending"
      );
  }
}

/**
 * One connection carries exactly one request exchange. This prevents request
 * ID reuse and multiplexing ambiguity while still allowing a successful
 * submit-turn response to be followed by its bounded event stream.
 */
export class LocalProtocolCorrelationGuard {
  #request?: CorrelatedRequest;
  #complete = false;

  get isComplete(): boolean {
    return this.#complete;
  }

  acceptClient(frame: LocalProtocolClientFrame): void {
    if (this.#request !== undefined || this.#complete) {
      codecFail(
        ["requestId"],
        "duplicate-item",
        "a local connection accepts exactly one request",
      );
    }
    const subjectId = commandSubjectId(frame.command);
    this.#request = {
      requestId: frame.requestId,
      commandKind: frame.command.kind,
      ...(subjectId === undefined ? {} : { subjectId }),
      responseSeen: false,
    };
  }

  acceptServer(frame: LocalProtocolServerFrame): void {
    const request = this.#request;
    if (request === undefined) {
      codecFail(
        ["requestId"],
        "invalid-format",
        "server frame has no correlated client request",
      );
    }
    if (this.#complete) {
      codecFail(
        ["frame"],
        "invalid-format",
        "local request exchange is already complete",
      );
    }
    if (frame.requestId !== request.requestId) {
      codecFail(
        ["requestId"],
        "invalid-format",
        "server frame request correlation does not match",
      );
    }

    if (frame.frame === "response") {
      if (request.responseSeen) {
        codecFail(
          ["frame"],
          "duplicate-item",
          "local request received more than one response",
        );
      }
      request.responseSeen = true;
      if (frame.outcome.status === "rejected") {
        this.#complete = true;
        return;
      }
      if (!resultMatchesCommand(request.commandKind, frame.outcome.result)) {
        codecFail(
          ["outcome", "result", "kind"],
          "invalid-format",
          "local response kind does not match its request command",
        );
      }
      if (
        request.subjectId !== undefined &&
        resultSubjectId(frame.outcome.result) !== request.subjectId
      ) {
        codecFail(
          ["outcome", "result"],
          "invalid-format",
          "local response subject does not match its request command",
        );
      }
      if (
        request.commandKind === "submit-turn" &&
        frame.outcome.result.kind === "turn-submitted"
      ) {
        request.streamingTurnId = frame.outcome.result.turnId;
        return;
      }
      this.#complete = true;
      return;
    }

    if (
      !request.responseSeen ||
      request.commandKind !== "submit-turn" ||
      request.streamingTurnId === undefined
    ) {
      codecFail(
        ["frame"],
        "invalid-format",
        "local event stream requires a successful submit-turn response",
      );
    }
    if (frame.frame === "stream-end") {
      this.#complete = true;
      return;
    }

    const eventTurnId =
      frame.event.kind === "turn-terminal"
        ? frame.event.response.turnId
        : frame.event.turnId;
    if (eventTurnId !== request.streamingTurnId) {
      codecFail(
        ["event", "turnId"],
        "invalid-format",
        "local event belongs to a different Turn",
      );
    }
  }
}

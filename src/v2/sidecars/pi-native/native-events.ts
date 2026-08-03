import { Buffer } from "node:buffer";

import {
  decodeJsonObject,
  decodeJsonValue,
  type JsonBounds,
} from "../../codecs/json.js";
import { codecFail, type CodecPath } from "../../codecs/errors.js";
import {
  decodeBoundedArray,
  decodeBoundedString,
  decodeNonNegativeSafeInteger,
} from "../../codecs/primitives.js";
import {
  at,
  decodeBoolean,
  decodeEnum,
  decodeLiteral,
  decodePlainObject,
  requireExactFields,
} from "../../codecs/structure.js";
import {
  PI_NATIVE_BRIDGE_LIMITS,
  parseStrictPiNativeBridgeJson,
  type PiNativeAssistantContent,
  type PiNativeUsage,
} from "../../bridges/pi-native/frames.js";
import type { PiNativeCatalogModel } from "./manifest.js";
import { digestDecodedPiNativeValue } from "./digest.js";

// A provider may fragment one bounded output unit per SSE event. The runtime
// coalesces those fragments before A1's smaller 4,096-frame worker seam.
export const PI_NATIVE_MAXIMUM_STREAM_EVENTS =
  PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters +
  (PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks * 2) +
  2;

const PI_NATIVE_OUTPUT_JSON_BOUNDS: JsonBounds = Object.freeze({
  maximumDepth: 20,
  maximumNodes: 4_096,
  maximumStringLength: 65_536,
  maximumArrayItems: 512,
  maximumObjectFields: 256,
});

export interface PiNativeEventStream extends AsyncIterable<unknown> {
  result(): Promise<unknown>;
}

export type PiNativeAdaptedEvent =
  | { readonly kind: "text-start"; readonly contentIndex: number }
  | { readonly kind: "text-delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly kind: "text-end"; readonly contentIndex: number; readonly content: string }
  | { readonly kind: "reasoning-start"; readonly contentIndex: number }
  | { readonly kind: "reasoning-delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly kind: "reasoning-end"; readonly contentIndex: number; readonly content: string }
  | { readonly kind: "tool-start"; readonly contentIndex: number }
  | { readonly kind: "tool-delta"; readonly contentIndex: number; readonly delta: string }
  | {
      readonly kind: "tool-end";
      readonly contentIndex: number;
      readonly toolCall: Extract<PiNativeAssistantContent, { readonly type: "toolCall" }>;
    }
  | { readonly kind: "native-terminal"; readonly terminal: PiNativeTerminalProjection };

export type PiNativeTerminalProjection =
  | {
      readonly outcome: "done";
      readonly reason: "stop" | "length" | "toolUse";
      readonly usage: PiNativeUsage;
    }
  | {
      readonly outcome: "error";
      readonly reason: "error" | "aborted";
      readonly usage: PiNativeUsage;
    };

type NativeContent =
  | Extract<PiNativeAssistantContent, { readonly type: "text" }>
  | Extract<PiNativeAssistantContent, { readonly type: "thinking" }>
  | Extract<PiNativeAssistantContent, { readonly type: "toolCall" }>;

interface NativeAssistantProjection {
  readonly content: readonly NativeContent[];
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: PiNativeUsage;
  readonly stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
  readonly timestamp: number;
  readonly hasErrorMessage: boolean;
}

type DecodedNativeEvent =
  | { readonly type: "start" }
  | {
      readonly type: "text_start" | "thinking_start" | "toolcall_start";
      readonly contentIndex: number;
      readonly initialDelta: string;
    }
  | {
      readonly type: "text_delta" | "thinking_delta" | "toolcall_delta";
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: "text_end" | "thinking_end";
      readonly contentIndex: number;
      readonly content: string;
    }
  | {
      readonly type: "toolcall_end";
      readonly contentIndex: number;
      readonly toolCall: Extract<PiNativeAssistantContent, { readonly type: "toolCall" }>;
    }
  | {
      readonly type: "done";
      readonly reason: "stop" | "length" | "toolUse";
      readonly message: NativeAssistantProjection;
    }
  | {
      readonly type: "error";
      readonly reason: "error" | "aborted";
      readonly error: NativeAssistantProjection;
    };

interface OpenContent {
  readonly kind: "text" | "reasoning" | "tool";
  state: "open" | "closed";
  cumulative: string;
  cumulativeUnits: number;
  final?: NativeContent;
}

/** Strict Pi 0.82 event sequencer that retains no raw provider error body. */
export class PiNativeEventAdapter {
  readonly #model: PiNativeCatalogModel;
  readonly #content = new Map<number, OpenContent>();
  #started = false;
  #eventCount = 0;
  #generatedContentUnits = 0;
  #terminal:
    | { readonly projection: PiNativeTerminalProjection; readonly snapshotDigest: string }
    | undefined;

  constructor(model: PiNativeCatalogModel) {
    this.#model = model;
  }

  accept(input: unknown): PiNativeAdaptedEvent | undefined {
    if (this.#terminal !== undefined) {
      throw new Error("Pi native stream emitted data after its terminal event");
    }
    this.#eventCount += 1;
    if (this.#eventCount > PI_NATIVE_MAXIMUM_STREAM_EVENTS) {
      throw new Error("Pi native stream exceeded its event limit");
    }
    const event = decodeNativeEvent(input, this.#model);
    if (event.type === "start") {
      if (this.#started) throw new Error("Pi native stream started more than once");
      this.#started = true;
      return undefined;
    }
    if (event.type === "done" || event.type === "error") {
      if (!this.#started && event.type !== "error") {
        throw new Error("Pi native stream completed before start");
      }
      if (
        event.type === "done" &&
        [...this.#content.values()].some((content) => content.state === "open")
      ) {
        throw new Error("Pi native stream terminated with open content");
      }
      const snapshot = event.type === "done" ? event.message : event.error;
      if (event.type === "done") {
        validateFinalContent(snapshot.content, this.#content);
      } else {
        validateErrorContent(snapshot.content, this.#content);
      }
      if (snapshot.stopReason !== event.reason) {
        throw new Error("Pi native terminal reason disagreed with its final message");
      }
      const projection: PiNativeTerminalProjection = event.type === "done"
        ? { outcome: "done", reason: event.reason, usage: snapshot.usage }
        : { outcome: "error", reason: event.reason, usage: snapshot.usage };
      this.#terminal = {
        projection: deepFreeze(projection),
        snapshotDigest: digestDecodedPiNativeValue(snapshot),
      };
      return { kind: "native-terminal", terminal: this.#terminal.projection };
    }
    if (!this.#started) {
      throw new Error("Pi native stream emitted content before start");
    }
    const kind = nativeContentKind(event.type);
    if (
      event.type === "text_start" ||
      event.type === "thinking_start" ||
      event.type === "toolcall_start"
    ) {
      if (this.#content.has(event.contentIndex)) {
        throw new Error("Pi native content index started more than once");
      }
      if (event.contentIndex !== this.#content.size) {
        throw new Error("Pi native content indexes must be contiguous and ordered");
      }
      const initialUnits = kind === "tool"
        ? Buffer.byteLength(event.initialDelta, "utf8")
        : event.initialDelta.length;
      this.#content.set(event.contentIndex, {
        kind,
        state: "open",
        cumulative: event.initialDelta,
        cumulativeUnits: initialUnits,
      });
      this.#generatedContentUnits += initialUnits;
      if (this.#generatedContentUnits > PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters) {
        throw new Error("Pi native stream exceeded its aggregate generated-content limit");
      }
      return { kind: bridgeKind(event.type), contentIndex: event.contentIndex } as PiNativeAdaptedEvent;
    }
    const current = this.#content.get(event.contentIndex);
    if (current === undefined || current.kind !== kind || current.state !== "open") {
      throw new Error("Pi native content continuation did not match an open stream");
    }
    if (
      event.type === "text_delta" ||
      event.type === "thinking_delta" ||
      event.type === "toolcall_delta"
    ) {
      const units = kind === "tool"
        ? Buffer.byteLength(event.delta, "utf8")
        : event.delta.length;
      this.#generatedContentUnits += units;
      if (this.#generatedContentUnits > PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters) {
        throw new Error("Pi native stream exceeded its aggregate generated-content limit");
      }
      current.cumulative += event.delta;
      current.cumulativeUnits += units;
      const maximum = kind === "tool"
        ? PI_NATIVE_BRIDGE_LIMITS.maximumToolArgumentsBytes
        : PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters;
      if (current.cumulativeUnits > maximum) {
        throw new Error("Pi native content deltas exceeded their cumulative limit");
      }
      return {
        kind: bridgeKind(event.type),
        contentIndex: event.contentIndex,
        delta: event.delta,
      } as PiNativeAdaptedEvent;
    }
    current.state = "closed";
    if (event.type === "toolcall_end") {
      if (current.cumulative.length > 0) {
        let accumulated: unknown;
        try {
          accumulated = parseStrictPiNativeBridgeJson(current.cumulative);
        } catch {
          throw new Error("Pi native tool deltas did not form final JSON arguments");
        }
        const decodedArguments = decodeJsonObject(
          accumulated,
          PI_NATIVE_OUTPUT_JSON_BOUNDS,
        );
        if (
          digestDecodedPiNativeValue(decodedArguments) !==
          digestDecodedPiNativeValue(event.toolCall.arguments)
        ) {
          throw new Error("Pi native final tool arguments disagreed with their deltas");
        }
      }
      current.final = event.toolCall;
      return {
        kind: "tool-end",
        contentIndex: event.contentIndex,
        toolCall: event.toolCall,
      };
    }
    if (event.type !== "text_end" && event.type !== "thinking_end") {
      throw new Error("Pi native stream reached an unsupported content transition");
    }
    if (current.cumulative !== event.content) {
      throw new Error("Pi native final content disagreed with its accumulated deltas");
    }
    current.final = event.type === "text_end"
      ? { type: "text", text: event.content }
      : { type: "thinking", thinking: event.content };
    return {
      kind: event.type === "text_end" ? "text-end" : "reasoning-end",
      contentIndex: event.contentIndex,
      content: event.content,
    };
  }

  finish(input: unknown): PiNativeTerminalProjection {
    if (this.#terminal === undefined) {
      throw new Error("Pi native stream ended without a terminal event");
    }
    const result = decodeNativeAssistant(input, this.#model, ["result"]);
    if (digestDecodedPiNativeValue(result) !== this.#terminal.snapshotDigest) {
      throw new Error("Pi native stream result disagreed with its terminal event");
    }
    return this.#terminal.projection;
  }
}

function decodeNativeEvent(
  input: unknown,
  model: PiNativeCatalogModel,
): DecodedNativeEvent {
  const object = decodePlainObject(input);
  const type = decodeBoundedString(
    object.type,
    { minimumLength: 1, maximumLength: 32, label: "Pi native event type" },
    ["type"],
  );
  if (type === "start") {
    requireExactFields(object, ["type", "partial"], [], []);
    decodeNativePartialAssistant(object.partial, model, ["partial"]);
    return { type };
  }
  if (type === "done") {
    requireExactFields(object, ["type", "reason", "message"], [], []);
    return {
      type,
      reason: decodeEnum(object.reason, ["stop", "length", "toolUse"] as const, ["reason"]),
      message: decodeNativeAssistant(object.message, model, ["message"]),
    };
  }
  if (type === "error") {
    requireExactFields(object, ["type", "reason", "error"], [], []);
    return {
      type,
      reason: decodeEnum(object.reason, ["error", "aborted"] as const, ["reason"]),
      error: decodeNativeAssistant(object.error, model, ["error"]),
    };
  }
  const starts = ["text_start", "thinking_start", "toolcall_start"] as const;
  if ((starts as readonly string[]).includes(type)) {
    requireExactFields(object, ["type", "contentIndex", "partial"], [], []);
    decodeNativePartialAssistant(object.partial, model, ["partial"]);
    const contentIndex = decodeContentIndex(object.contentIndex, ["contentIndex"]);
    return {
      type: type as (typeof starts)[number],
      contentIndex,
      initialDelta: decodeNativeStartContent(
        object.partial,
        contentIndex,
        type as (typeof starts)[number],
      ),
    };
  }
  const deltas = ["text_delta", "thinking_delta", "toolcall_delta"] as const;
  if ((deltas as readonly string[]).includes(type)) {
    requireExactFields(object, ["type", "contentIndex", "delta", "partial"], [], []);
    decodeNativePartialAssistant(object.partial, model, ["partial"]);
    return {
      type: type as (typeof deltas)[number],
      contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]),
      delta: decodeContentString(object.delta, ["delta"], "Pi native event delta"),
    };
  }
  const ends = ["text_end", "thinking_end"] as const;
  if ((ends as readonly string[]).includes(type)) {
    requireExactFields(object, ["type", "contentIndex", "content", "partial"], [], []);
    decodeNativePartialAssistant(object.partial, model, ["partial"]);
    return {
      type: type as (typeof ends)[number],
      contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]),
      content: decodeContentString(object.content, ["content"], "Pi native final content"),
    };
  }
  if (type === "toolcall_end") {
    requireExactFields(object, ["type", "contentIndex", "toolCall", "partial"], [], []);
    decodeNativePartialAssistant(object.partial, model, ["partial"]);
    return {
      type,
      contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]),
      toolCall: decodeNativeToolCall(object.toolCall, ["toolCall"]),
    };
  }
  codecFail(["type"], "unsupported-discriminant", "unsupported Pi 0.82 native event");
}

function decodeNativeAssistant(
  input: unknown,
  model: PiNativeCatalogModel,
  path: CodecPath,
): NativeAssistantProjection {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
    ["responseModel", "responseId", "errorMessage", "diagnostics", "rawStopReason"],
    path,
  );
  decodeLiteral(object.role, "assistant", at(path, "role"));
  const api = decodeReference(object.api, at(path, "api"), "native result API");
  const provider = decodeReference(object.provider, at(path, "provider"), "native result provider");
  const modelId = decodeReference(object.model, at(path, "model"), "native result model");
  if (api !== model.api || provider !== model.providerId || modelId !== model.id) {
    codecFail(path, "invalid-format", "Pi native result changed the frozen model binding");
  }
  if (object.responseModel !== undefined) {
    decodeReference(object.responseModel, at(path, "responseModel"), "native response model");
  }
  if (object.responseId !== undefined) {
    decodeReference(object.responseId, at(path, "responseId"), "native response ID");
  }
  if (object.errorMessage !== undefined) {
    decodeBoundedString(
      object.errorMessage,
      { maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumErrorCharacters, label: "native provider error" },
      at(path, "errorMessage"),
    );
  }
  if (object.rawStopReason !== undefined) {
    decodeBoundedString(
      object.rawStopReason,
      { maximumLength: 256, label: "native raw stop reason" },
      at(path, "rawStopReason"),
    );
  }
  if (object.diagnostics !== undefined) {
    decodeJsonValue(object.diagnostics);
  }
  return deepFreeze({
    content: decodeBoundedArray(
      object.content,
      decodeNativeContent,
      { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks },
      at(path, "content"),
    ),
    api,
    provider,
    model: modelId,
    usage: decodeNativeUsage(object.usage, at(path, "usage")),
    stopReason: decodeEnum(
      object.stopReason,
      ["pending", "stop", "length", "toolUse", "error", "aborted"] as const,
      at(path, "stopReason"),
    ),
    timestamp: decodeNonNegativeSafeInteger(object.timestamp, at(path, "timestamp")),
    hasErrorMessage: object.errorMessage !== undefined,
  });
}

/** Validate the repeated Pi partial envelope without re-walking growing content. */
function decodeNativePartialAssistant(
  input: unknown,
  model: PiNativeCatalogModel,
  path: CodecPath,
): void {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
    ["responseModel", "responseId", "errorMessage", "diagnostics", "rawStopReason"],
    path,
  );
  decodeLiteral(object.role, "assistant", at(path, "role"));
  const api = decodeReference(object.api, at(path, "api"), "native partial API");
  const provider = decodeReference(object.provider, at(path, "provider"), "native partial provider");
  const modelId = decodeReference(object.model, at(path, "model"), "native partial model");
  if (api !== model.api || provider !== model.providerId || modelId !== model.id) {
    codecFail(path, "invalid-format", "Pi native partial changed the frozen model binding");
  }
  decodeBoundedArray(
    object.content,
    (content, contentPath) => {
      decodePlainObject(content, contentPath);
      return null;
    },
    { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks },
    at(path, "content"),
  );
  decodeNativeUsage(object.usage, at(path, "usage"));
  decodeEnum(
    object.stopReason,
    ["pending", "stop", "length", "toolUse", "error", "aborted"] as const,
    at(path, "stopReason"),
  );
  decodeNonNegativeSafeInteger(object.timestamp, at(path, "timestamp"));
  if (object.responseModel !== undefined) {
    decodeReference(object.responseModel, at(path, "responseModel"), "native partial response model");
  }
  if (object.responseId !== undefined) {
    decodeReference(object.responseId, at(path, "responseId"), "native partial response ID");
  }
  if (object.errorMessage !== undefined) {
    decodeBoundedString(
      object.errorMessage,
      { maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumErrorCharacters, label: "native partial provider error" },
      at(path, "errorMessage"),
    );
  }
  if (object.rawStopReason !== undefined) {
    decodeBoundedString(
      object.rawStopReason,
      { maximumLength: 256, label: "native partial raw stop reason" },
      at(path, "rawStopReason"),
    );
  }
  if (object.diagnostics !== undefined) {
    decodeBoundedArray(
      object.diagnostics,
      (diagnostic, diagnosticPath) => {
        decodePlainObject(diagnostic, diagnosticPath);
        return null;
      },
      { maximumItems: 128 },
      at(path, "diagnostics"),
    );
  }
}

function decodeNativeStartContent(
  input: unknown,
  contentIndex: number,
  type: "text_start" | "thinking_start" | "toolcall_start",
): string {
  const partial = decodePlainObject(input, ["partial"]);
  const content = decodeBoundedArray(
    partial.content,
    (entry, path) => decodePlainObject(entry, path),
    { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks },
    ["partial", "content"],
  );
  const path: CodecPath = ["partial", "content", contentIndex];
  const block = content[contentIndex];
  if (block === undefined) {
    codecFail(path, "invalid-format", "native start partial omitted its content index");
  }
  if (type === "text_start") {
    requireExactFields(block, ["type", "text"], ["textSignature"], path);
    decodeLiteral(block.type, "text", at(path, "type"));
    const text = decodeContentString(block.text, at(path, "text"), "native starting text");
    if (text.length !== 0) {
      codecFail(at(path, "text"), "invalid-format", "native text start was not empty");
    }
    return "";
  }
  if (type === "thinking_start") {
    requireExactFields(block, ["type", "thinking"], ["thinkingSignature", "redacted"], path);
    decodeLiteral(block.type, "thinking", at(path, "type"));
    const thinking = decodeContentString(
      block.thinking,
      at(path, "thinking"),
      "native starting reasoning",
    );
    if (thinking.length !== 0) {
      codecFail(at(path, "thinking"), "invalid-format", "native reasoning start was not empty");
    }
    return "";
  }
  requireExactFields(
    block,
    ["type", "id", "name", "arguments"],
    ["thoughtSignature", "partialJson", "customInput"],
    path,
  );
  decodeLiteral(block.type, "toolCall", at(path, "type"));
  decodeToolCallId(block.id, at(path, "id"));
  decodeReference(block.name, at(path, "name"), "native starting tool name");
  decodeJsonObject(block.arguments, PI_NATIVE_OUTPUT_JSON_BOUNDS);
  if (block.customInput !== undefined) {
    decodeJsonValue(block.customInput, PI_NATIVE_OUTPUT_JSON_BOUNDS);
  }
  if (block.partialJson === undefined) return "";
  const initialDelta = decodeContentString(
    block.partialJson,
    at(path, "partialJson"),
    "native starting tool arguments",
  );
  if (Buffer.byteLength(initialDelta, "utf8") > PI_NATIVE_BRIDGE_LIMITS.maximumToolArgumentsBytes) {
    codecFail(
      at(path, "partialJson"),
      "too-long",
      "native starting tool arguments exceed the bridge limit",
    );
  }
  return initialDelta;
}

function decodeNativeContent(input: unknown, path: CodecPath): NativeContent {
  const object = decodePlainObject(input, path);
  if (object.type === "text") {
    requireExactFields(object, ["type", "text"], ["textSignature"], path);
    return {
      type: decodeLiteral(object.type, "text", at(path, "type")),
      text: decodeContentString(object.text, at(path, "text"), "native text"),
      ...(object.textSignature === undefined
        ? {}
        : { textSignature: decodeContentString(object.textSignature, at(path, "textSignature"), "native text signature") }),
    };
  }
  if (object.type === "thinking") {
    requireExactFields(object, ["type", "thinking"], ["thinkingSignature", "redacted"], path);
    return {
      type: decodeLiteral(object.type, "thinking", at(path, "type")),
      thinking: decodeContentString(object.thinking, at(path, "thinking"), "native reasoning"),
      ...(object.thinkingSignature === undefined
        ? {}
        : { thinkingSignature: decodeContentString(object.thinkingSignature, at(path, "thinkingSignature"), "native reasoning signature") }),
      ...(object.redacted === undefined
        ? {}
        : { redacted: decodeBoolean(object.redacted, at(path, "redacted")) }),
    };
  }
  if (object.type === "toolCall") return decodeNativeToolCall(object, path);
  codecFail(at(path, "type"), "unsupported-discriminant", "unsupported native assistant content");
}

function decodeNativeToolCall(
  input: unknown,
  path: CodecPath,
): Extract<PiNativeAssistantContent, { readonly type: "toolCall" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["type", "id", "name", "arguments"], ["thoughtSignature"], path);
  const args = decodeJsonObject(object.arguments, PI_NATIVE_OUTPUT_JSON_BOUNDS);
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > PI_NATIVE_BRIDGE_LIMITS.maximumToolArgumentsBytes) {
    codecFail(at(path, "arguments"), "too-long", "native tool arguments exceed the bridge limit");
  }
  return {
    type: decodeLiteral(object.type, "toolCall", at(path, "type")),
    id: decodeToolCallId(object.id, at(path, "id")),
    name: decodeReference(object.name, at(path, "name"), "native tool name"),
    arguments: args,
    ...(object.thoughtSignature === undefined
      ? {}
      : { thoughtSignature: decodeContentString(object.thoughtSignature, at(path, "thoughtSignature"), "native tool thought signature") }),
  };
}

function decodeNativeUsage(input: unknown, path: CodecPath): PiNativeUsage {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
    ["reasoning", "cacheWrite1h"],
    path,
  );
  if (object.cacheWrite1h !== undefined) {
    decodeNonNegativeSafeInteger(object.cacheWrite1h, at(path, "cacheWrite1h"));
  }
  const cost = decodePlainObject(object.cost, at(path, "cost"));
  requireExactFields(cost, ["input", "output", "cacheRead", "cacheWrite", "total"], [], at(path, "cost"));
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    decodeNonNegativeFiniteNumber(cost[key], at(at(path, "cost"), key));
  }
  const usage: PiNativeUsage = {
    inputTokens: decodeNonNegativeSafeInteger(object.input, at(path, "input")),
    outputTokens: decodeNonNegativeSafeInteger(object.output, at(path, "output")),
    cacheReadTokens: decodeNonNegativeSafeInteger(object.cacheRead, at(path, "cacheRead")),
    cacheWriteTokens: decodeNonNegativeSafeInteger(object.cacheWrite, at(path, "cacheWrite")),
    totalTokens: decodeNonNegativeSafeInteger(object.totalTokens, at(path, "totalTokens")),
  };
  return object.reasoning === undefined
    ? usage
    : {
        ...usage,
        reasoningTokens: decodeNonNegativeSafeInteger(object.reasoning, at(path, "reasoning")),
      };
}

function validateFinalContent(
  finalContent: readonly NativeContent[],
  streams: ReadonlyMap<number, OpenContent>,
): void {
  if (finalContent.length !== streams.size) {
    throw new Error("Pi native final content cardinality disagreed with its event stream");
  }
  for (const [index, stream] of streams) {
    const content = finalContent[index];
    if (content === undefined || stream.final === undefined) {
      throw new Error("Pi native final content omitted a streamed content index");
    }
    const expectedType = stream.kind === "reasoning" ? "thinking" : stream.kind === "tool" ? "toolCall" : "text";
    if (content.type !== expectedType || !finalContentMatches(content, stream.final)) {
      throw new Error("Pi native final content disagreed with its stream end");
    }
  }
}

/** Pi 0.82 reports its bounded partial output directly when a provider fails. */
function validateErrorContent(
  finalContent: readonly NativeContent[],
  streams: ReadonlyMap<number, OpenContent>,
): void {
  if (finalContent.length !== streams.size) {
    throw new Error("Pi native error content cardinality disagreed with its event stream");
  }
  for (const [index, stream] of streams) {
    const content = finalContent[index];
    const expectedType = stream.kind === "reasoning"
      ? "thinking"
      : stream.kind === "tool"
        ? "toolCall"
        : "text";
    if (content === undefined || content.type !== expectedType) {
      throw new Error("Pi native error content omitted a streamed content index");
    }
    if (stream.state === "closed") {
      if (stream.final === undefined || !finalContentMatches(content, stream.final)) {
        throw new Error("Pi native error content disagreed with its stream end");
      }
      continue;
    }
    if (content.type === "text" && content.text !== stream.cumulative) {
      throw new Error("Pi native partial error text disagreed with its deltas");
    }
    if (content.type === "thinking" && content.thinking !== stream.cumulative) {
      throw new Error("Pi native partial error reasoning disagreed with its deltas");
    }
    if (content.type === "toolCall" && stream.cumulative.length > 0) {
      try {
        const completeArguments = decodeJsonObject(
          parseStrictPiNativeBridgeJson(stream.cumulative),
          PI_NATIVE_OUTPUT_JSON_BOUNDS,
        );
        if (
          digestDecodedPiNativeValue(completeArguments) !==
          digestDecodedPiNativeValue(content.arguments)
        ) {
          throw new Error("mismatch");
        }
      } catch {
        // Pi's partial JSON parser may expose an incomplete bounded object.
        // A complete-but-invalid or mismatched prefix still fails closed.
        if (!isCompleteJsonValue(stream.cumulative)) continue;
        throw new Error("Pi native partial error tool arguments disagreed with complete deltas");
      }
    }
  }
}

function isCompleteJsonValue(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

function finalContentMatches(left: NativeContent, right: NativeContent): boolean {
  if (left.type === "text" && right.type === "text") return left.text === right.text;
  if (left.type === "thinking" && right.type === "thinking") {
    return left.thinking === right.thinking;
  }
  return left.type === "toolCall" && right.type === "toolCall" &&
    digestDecodedPiNativeValue(left) === digestDecodedPiNativeValue(right);
}

function nativeContentKind(type: DecodedNativeEvent["type"]): "text" | "reasoning" | "tool" {
  if (type.startsWith("text_")) return "text";
  if (type.startsWith("thinking_")) return "reasoning";
  if (type.startsWith("toolcall_")) return "tool";
  throw new Error("terminal native event has no content kind");
}

function bridgeKind(type: string): PiNativeAdaptedEvent["kind"] {
  return type.replace("thinking", "reasoning").replace("toolcall", "tool").replaceAll("_", "-") as PiNativeAdaptedEvent["kind"];
}

function decodeContentIndex(input: unknown, path: CodecPath): number {
  const value = decodeNonNegativeSafeInteger(input, path);
  if (value >= PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks) {
    codecFail(path, "out-of-range", "native content index exceeds the bridge limit");
  }
  return value;
}

function decodeContentString(input: unknown, path: CodecPath, label: string): string {
  return decodeBoundedString(
    input,
    { maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters, label },
    path,
  );
}

function decodeReference(input: unknown, path: CodecPath, label: string): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: 128,
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u,
      label,
    },
    path,
  );
}

function decodeToolCallId(input: unknown, path: CodecPath): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumToolCallIdCharacters,
      pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?(?:\|[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?)?$/u,
      label: "native tool call ID",
    },
    path,
  );
}

function decodeNonNegativeFiniteNumber(input: unknown, path: CodecPath): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    codecFail(path, "invalid-format", "expected a non-negative finite native cost");
  }
  return input;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

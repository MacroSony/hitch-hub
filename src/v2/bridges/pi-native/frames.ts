/**
 * Closed JSONL frames for the reviewed Pi 0.82.0 native-library seam.
 *
 * These frames deliberately carry protocol-local correlation only.  They do
 * not carry a Hitch Turn, worker, lease, reservation, visibility, durability,
 * broker capability, credential, origin, header, command, environment, or
 * path.  A later trusted sidecar/broker binds this local transport to those
 * facts before it may invoke a native provider.
 */

import { TextDecoder, TextEncoder } from "node:util";

import type { IntegrityDigest, JsonObject } from "../../model/primitives.js";
import { codecFail, type CodecPath } from "../../codecs/errors.js";
import { decodeJsonObject, type JsonBounds } from "../../codecs/json.js";
import {
  decodeAgentImageMimeType,
  decodeBoundedArray,
  decodeBoundedString,
  decodeIntegrityDigest,
  decodeNonNegativeSafeInteger,
  decodePositiveSafeInteger,
} from "../../codecs/primitives.js";
import {
  at,
  decodeBoolean,
  decodeEnum,
  decodeLiteral,
  decodePlainObject,
  requireExactFields,
} from "../../codecs/structure.js";

export const PI_NATIVE_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const PI_NATIVE_BRIDGE_ID = "pi-native-sidecar-v1" as const;
export const PI_NATIVE_BRIDGE_COMPATIBILITY = Object.freeze({
  piCodingAgentVersion: "0.82.0",
  piAiVersion: "0.82.0",
});

export const PI_NATIVE_BRIDGE_LIMITS = Object.freeze({
  maximumFrameBytes: 16 * 1024 * 1024,
  maximumContextBytes: 15 * 1024 * 1024,
  /** First-slice policy ceiling; the native catalog's 128k value is provider capacity. */
  maximumOutputTokens: 16_384,
  maximumMessages: 256,
  maximumContentBlocks: 128,
  maximumTools: 64,
  maximumTextCharacters: 2_097_152,
  maximumImageBytes: 10_485_760,
  maximumTotalImageBytes: 10_485_760,
  maximumToolArgumentsBytes: 2_097_152,
  maximumToolCallIdCharacters: 257,
  maximumErrorCharacters: 4_096,
  maximumActiveCorrelations: 256,
} as const);

/** The A1 codec may only be configured with stricter concrete limits. */
export interface PiNativeBridgeFrameLimits {
  readonly maximumFrameBytes?: number;
  readonly maximumContextBytes?: number;
}

export interface PiNativeBridgeCompatibility {
  readonly piCodingAgentVersion: "0.82.0";
  readonly piAiVersion: "0.82.0";
}

/**
 * Secret-free binding identity repeated in every frame.  It is not a Hitch
 * durable identifier: the sidecar maps it to the already-authorized
 * connection outside this protocol.
 */
export interface PiNativeBridgeBinding {
  readonly bridgeId: "pi-native-sidecar-v1";
  readonly nativeStackDigest: IntegrityDigest;
  readonly nativeCatalogDigest: IntegrityDigest;
}

export interface PiNativeBridgeBaseFrame {
  readonly protocolVersion: 1;
  readonly correlationId: string;
  readonly compatibility: PiNativeBridgeCompatibility;
  readonly binding: PiNativeBridgeBinding;
}

export type PiNativeReasoning = "none" | "low" | "medium" | "high";
export type PiNativeStopReason = "stop" | "length" | "toolUse";

export interface PiNativeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
}

export type PiNativeInputContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      /** Canonical padded base64. The source bytes are never a filesystem path. */
      readonly data: string;
    };

export type PiNativeAssistantContent =
  | { readonly type: "text"; readonly text: string; readonly textSignature?: string }
  | {
      readonly type: "thinking";
      readonly thinking: string;
      readonly thinkingSignature?: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonObject;
      readonly thoughtSignature?: string;
    };

export type PiNativeContextMessage =
  | {
      readonly role: "user";
      readonly content: string | readonly PiNativeInputContent[];
      readonly timestamp: number;
    }
  | {
      readonly role: "assistant";
      readonly content: readonly PiNativeAssistantContent[];
      readonly api: string;
      readonly provider: string;
      readonly model: string;
      readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
      readonly timestamp: number;
      readonly responseModel?: string;
      readonly responseId?: string;
      readonly errorMessage?: string;
      readonly usage?: PiNativeUsage;
    }
  | {
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: readonly PiNativeInputContent[];
      readonly isError: boolean;
      readonly timestamp: number;
      readonly addedToolNames?: readonly string[];
      readonly usage?: PiNativeUsage;
    };

/** A deliberately small, provider-neutral subset of Pi's native Context. */
export interface PiNativeContext {
  readonly messages: readonly PiNativeContextMessage[];
  readonly systemPrompt?: string;
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    /** Bounded JSON Schema data; it cannot configure a provider transport. */
    readonly parameters: JsonObject;
  }[];
}

export interface PiNativeInvokeFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "invoke";
  readonly context: PiNativeContext;
  readonly options: {
    readonly maximumOutputTokens?: number;
    readonly reasoning?: PiNativeReasoning;
  };
  /** Literals, not caller-selected retry/transport options. */
  readonly nativeSeam: {
    readonly maxRetries: 0;
    readonly transport: "sse";
  };
}

export interface PiNativeCancelFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "cancel";
}

export interface PiNativeStartedFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "started";
}

export interface PiNativeTextStartFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "text-start";
  readonly contentIndex: number;
}

export interface PiNativeTextDeltaFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "text-delta";
  readonly contentIndex: number;
  readonly delta: string;
}

export interface PiNativeTextEndFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "text-end";
  readonly contentIndex: number;
  readonly content: string;
}

export interface PiNativeReasoningStartFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "reasoning-start";
  readonly contentIndex: number;
}

export interface PiNativeReasoningDeltaFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "reasoning-delta";
  readonly contentIndex: number;
  readonly delta: string;
}

export interface PiNativeReasoningEndFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "reasoning-end";
  readonly contentIndex: number;
  readonly content: string;
}

export interface PiNativeToolStartFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "tool-start";
  readonly contentIndex: number;
}

export interface PiNativeToolDeltaFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "tool-delta";
  readonly contentIndex: number;
  readonly delta: string;
}

export interface PiNativeToolEndFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "tool-end";
  readonly contentIndex: number;
  readonly toolCall: Extract<PiNativeAssistantContent, { readonly type: "toolCall" }>;
}

export interface PiNativeUsageFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "usage";
  readonly usage: PiNativeUsage;
}

export interface PiNativeErrorFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "error";
  readonly code:
    | "provider-error"
    | "credential-unavailable"
    | "protocol-error"
    | "policy-denied";
  /** Sanitized provider status only; never an upstream response body. */
  readonly message: string;
}

export interface PiNativeTerminalFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "terminal";
  readonly reason: PiNativeStopReason;
  readonly usage: PiNativeUsage;
}

export interface PiNativeCancelledFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "cancelled";
}

/** OAuth progress is observable without exposing any token, URL, or credential metadata. */
export interface PiNativeOAuthStatusFrame extends PiNativeBridgeBaseFrame {
  readonly kind: "oauth-status";
  readonly state: "refresh-started" | "refresh-succeeded" | "refresh-failed";
}

export type PiNativeBridgeFrame =
  | PiNativeInvokeFrame
  | PiNativeCancelFrame
  | PiNativeStartedFrame
  | PiNativeTextStartFrame
  | PiNativeTextDeltaFrame
  | PiNativeTextEndFrame
  | PiNativeReasoningStartFrame
  | PiNativeReasoningDeltaFrame
  | PiNativeReasoningEndFrame
  | PiNativeToolStartFrame
  | PiNativeToolDeltaFrame
  | PiNativeToolEndFrame
  | PiNativeUsageFrame
  | PiNativeErrorFrame
  | PiNativeTerminalFrame
  | PiNativeCancelledFrame
  | PiNativeOAuthStatusFrame;

export type PiNativeBridgeClientFrame = Extract<
  PiNativeBridgeFrame,
  { readonly kind: "invoke" | "cancel" }
>;
export type PiNativeBridgeSidecarFrame = Exclude<
  PiNativeBridgeFrame,
  PiNativeBridgeClientFrame
>;

export interface PiNativeBridgeFrameExpectation {
  readonly correlationId?: string;
  readonly binding: PiNativeBridgeBinding;
}

const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_NATIVE_REFERENCE = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;
const SAFE_NATIVE_TOOL_CALL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?(?:\|[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?)?$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const NATIVE_JSON_BOUNDS: JsonBounds = Object.freeze({
  maximumDepth: 20,
  maximumNodes: 4_096,
  maximumStringLength: 65_536,
  maximumArrayItems: 512,
  maximumObjectFields: 256,
});

function resolveLimits(input: PiNativeBridgeFrameLimits | undefined): Required<PiNativeBridgeFrameLimits> {
  const maximumFrameBytes = input?.maximumFrameBytes ?? PI_NATIVE_BRIDGE_LIMITS.maximumFrameBytes;
  const maximumContextBytes = input?.maximumContextBytes ?? PI_NATIVE_BRIDGE_LIMITS.maximumContextBytes;
  for (const [name, value, ceiling] of [
    ["maximumFrameBytes", maximumFrameBytes, PI_NATIVE_BRIDGE_LIMITS.maximumFrameBytes],
    ["maximumContextBytes", maximumContextBytes, PI_NATIVE_BRIDGE_LIMITS.maximumContextBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) {
      codecFail(["limits", name], "out-of-range", "bridge limits may only narrow the concrete safety ceiling");
    }
  }
  return { maximumFrameBytes, maximumContextBytes };
}

function decodeReference(input: unknown, path: CodecPath, label: string): string {
  return decodeBoundedString(
    input,
    { minimumLength: 1, maximumLength: 128, pattern: SAFE_NATIVE_REFERENCE, label },
    path,
  );
}

function decodeToolCallId(input: unknown, path: CodecPath): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumToolCallIdCharacters,
      pattern: SAFE_NATIVE_TOOL_CALL_ID,
      label: "Pi tool call ID",
    },
    path,
  );
}

function decodeCorrelationId(input: unknown, path: CodecPath): string {
  return decodeBoundedString(
    input,
    { minimumLength: 36, maximumLength: 36, pattern: CORRELATION_ID, label: "bridge correlation ID" },
    path,
  );
}

function decodeContentString(input: unknown, path: CodecPath, label: string): string {
  return decodeBoundedString(
    input,
    { maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters, label },
    path,
  );
}

function decodeTimestamp(input: unknown, path: CodecPath): number {
  return decodeNonNegativeSafeInteger(input, path);
}

function decodeUsage(input: unknown, path: CodecPath): PiNativeUsage {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"],
    ["reasoningTokens"],
    path,
  );
  const output: PiNativeUsage = {
    inputTokens: decodeNonNegativeSafeInteger(object.inputTokens, at(path, "inputTokens")),
    outputTokens: decodeNonNegativeSafeInteger(object.outputTokens, at(path, "outputTokens")),
    cacheReadTokens: decodeNonNegativeSafeInteger(object.cacheReadTokens, at(path, "cacheReadTokens")),
    cacheWriteTokens: decodeNonNegativeSafeInteger(object.cacheWriteTokens, at(path, "cacheWriteTokens")),
    totalTokens: decodeNonNegativeSafeInteger(object.totalTokens, at(path, "totalTokens")),
  };
  if (object.reasoningTokens !== undefined) {
    return { ...output, reasoningTokens: decodeNonNegativeSafeInteger(object.reasoningTokens, at(path, "reasoningTokens")) };
  }
  return output;
}

function decodeTextContent(input: unknown, path: CodecPath): Extract<PiNativeInputContent, { readonly type: "text" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["type", "text"], [], path);
  return { type: decodeLiteral(object.type, "text", at(path, "type")), text: decodeContentString(object.text, at(path, "text"), "text content") };
}

function decodeImageContent(input: unknown, path: CodecPath): Extract<PiNativeInputContent, { readonly type: "image" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["type", "mimeType", "data"], [], path);
  const data = decodeBoundedString(
    object.data,
    { minimumLength: 4, maximumLength: Math.ceil(PI_NATIVE_BRIDGE_LIMITS.maximumImageBytes / 3) * 4, pattern: BASE64, label: "image base64" },
    at(path, "data"),
  );
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    codecFail(at(path, "data"), "invalid-format", "image data must be canonical base64");
  }
  if (bytes.length === 0 || bytes.length > PI_NATIVE_BRIDGE_LIMITS.maximumImageBytes || bytes.toString("base64") !== data) {
    codecFail(at(path, "data"), "out-of-range", "image data exceeds the canonical bridge image limit");
  }
  return {
    type: decodeLiteral(object.type, "image", at(path, "type")),
    mimeType: decodeAgentImageMimeType(object.mimeType, at(path, "mimeType")),
    data,
  };
}

function decodeInputContent(input: unknown, path: CodecPath): PiNativeInputContent {
  const object = decodePlainObject(input, path);
  if (object.type === "text") return decodeTextContent(object, path);
  if (object.type === "image") return decodeImageContent(object, path);
  codecFail(at(path, "type"), "unsupported-discriminant", "unsupported Pi input content type");
}

function decodeToolCall(input: unknown, path: CodecPath): Extract<PiNativeAssistantContent, { readonly type: "toolCall" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["type", "id", "name", "arguments"], ["thoughtSignature"], path);
  const output = {
    type: decodeLiteral(object.type, "toolCall", at(path, "type")),
    id: decodeToolCallId(object.id, at(path, "id")),
    name: decodeReference(object.name, at(path, "name"), "tool name"),
    arguments: decodeJsonObject(object.arguments, NATIVE_JSON_BOUNDS),
  };
  if (Buffer.byteLength(JSON.stringify(output.arguments), "utf8") > PI_NATIVE_BRIDGE_LIMITS.maximumToolArgumentsBytes) {
    codecFail(at(path, "arguments"), "too-long", "tool arguments exceed the bridge limit");
  }
  return object.thoughtSignature === undefined
    ? output
    : { ...output, thoughtSignature: decodeContentString(object.thoughtSignature, at(path, "thoughtSignature"), "tool thought signature") };
}

function decodeAssistantContent(input: unknown, path: CodecPath): PiNativeAssistantContent {
  const object = decodePlainObject(input, path);
  if (object.type === "text") {
    requireExactFields(object, ["type", "text"], ["textSignature"], path);
    const output = { type: decodeLiteral(object.type, "text", at(path, "type")), text: decodeContentString(object.text, at(path, "text"), "assistant text") } as const;
    return object.textSignature === undefined ? output : { ...output, textSignature: decodeContentString(object.textSignature, at(path, "textSignature"), "text signature") };
  }
  if (object.type === "thinking") {
    requireExactFields(object, ["type", "thinking"], ["thinkingSignature", "redacted"], path);
    const output = { type: decodeLiteral(object.type, "thinking", at(path, "type")), thinking: decodeContentString(object.thinking, at(path, "thinking"), "assistant reasoning") } as const;
    return {
      ...output,
      ...(object.thinkingSignature === undefined ? {} : { thinkingSignature: decodeContentString(object.thinkingSignature, at(path, "thinkingSignature"), "thinking signature") }),
      ...(object.redacted === undefined ? {} : { redacted: decodeBoolean(object.redacted, at(path, "redacted")) }),
    };
  }
  if (object.type === "toolCall") return decodeToolCall(object, path);
  codecFail(at(path, "type"), "unsupported-discriminant", "unsupported Pi assistant content type");
}

function decodeContextMessage(input: unknown, path: CodecPath): PiNativeContextMessage {
  const object = decodePlainObject(input, path);
  if (object.role === "user") {
    requireExactFields(object, ["role", "content", "timestamp"], [], path);
    const content = typeof object.content === "string"
      ? decodeContentString(object.content, at(path, "content"), "user content")
      : decodeBoundedArray(object.content, decodeInputContent, { minimumItems: 1, maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks }, at(path, "content"));
    return { role: decodeLiteral(object.role, "user", at(path, "role")), content, timestamp: decodeTimestamp(object.timestamp, at(path, "timestamp")) };
  }
  if (object.role === "assistant") {
    requireExactFields(object, ["role", "content", "api", "provider", "model", "stopReason", "timestamp"], ["responseModel", "responseId", "errorMessage", "usage"], path);
    const output = {
      role: decodeLiteral(object.role, "assistant", at(path, "role")),
      content: decodeBoundedArray(object.content, decodeAssistantContent, { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks }, at(path, "content")),
      api: decodeReference(object.api, at(path, "api"), "Pi API"),
      provider: decodeReference(object.provider, at(path, "provider"), "Pi provider"),
      model: decodeReference(object.model, at(path, "model"), "Pi model"),
      stopReason: decodeEnum(object.stopReason, ["stop", "length", "toolUse", "error", "aborted"] as const, at(path, "stopReason")),
      timestamp: decodeTimestamp(object.timestamp, at(path, "timestamp")),
    };
    return {
      ...output,
      ...(object.responseModel === undefined ? {} : { responseModel: decodeReference(object.responseModel, at(path, "responseModel"), "response model") }),
      ...(object.responseId === undefined ? {} : { responseId: decodeReference(object.responseId, at(path, "responseId"), "response ID") }),
      ...(object.errorMessage === undefined ? {} : { errorMessage: decodeContentString(object.errorMessage, at(path, "errorMessage"), "assistant error") }),
      ...(object.usage === undefined ? {} : { usage: decodeUsage(object.usage, at(path, "usage")) }),
    };
  }
  if (object.role === "toolResult") {
    requireExactFields(object, ["role", "toolCallId", "toolName", "content", "isError", "timestamp"], ["addedToolNames", "usage"], path);
    const output = {
      role: decodeLiteral(object.role, "toolResult", at(path, "role")),
      toolCallId: decodeToolCallId(object.toolCallId, at(path, "toolCallId")),
      toolName: decodeReference(object.toolName, at(path, "toolName"), "tool name"),
      content: decodeBoundedArray(object.content, decodeInputContent, { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks }, at(path, "content")),
      isError: decodeBoolean(object.isError, at(path, "isError")),
      timestamp: decodeTimestamp(object.timestamp, at(path, "timestamp")),
    };
    return {
      ...output,
      ...(object.addedToolNames === undefined ? {} : { addedToolNames: decodeBoundedArray(object.addedToolNames, (value, itemPath) => decodeReference(value, itemPath, "added tool name"), { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumTools, uniqueBy: String }, at(path, "addedToolNames")) }),
      ...(object.usage === undefined ? {} : { usage: decodeUsage(object.usage, at(path, "usage")) }),
    };
  }
  codecFail(at(path, "role"), "unsupported-discriminant", "unsupported Pi context role");
}

function decodeContext(input: unknown, path: CodecPath, limits: Required<PiNativeBridgeFrameLimits>): PiNativeContext {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["messages"], ["systemPrompt", "tools"], path);
  const output = {
    messages: decodeBoundedArray(object.messages, decodeContextMessage, { minimumItems: 1, maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumMessages }, at(path, "messages")),
  };
  const context: PiNativeContext = {
    ...output,
    ...(object.systemPrompt === undefined ? {} : { systemPrompt: decodeContentString(object.systemPrompt, at(path, "systemPrompt"), "system prompt") }),
    ...(object.tools === undefined ? {} : {
      tools: decodeBoundedArray(object.tools, (tool, toolPath) => {
        const toolObject = decodePlainObject(tool, toolPath);
        requireExactFields(toolObject, ["name", "description", "parameters"], [], toolPath);
        return {
          name: decodeReference(toolObject.name, at(toolPath, "name"), "tool name"),
          description: decodeContentString(toolObject.description, at(toolPath, "description"), "tool description"),
          parameters: decodeJsonObject(toolObject.parameters, NATIVE_JSON_BOUNDS),
        };
      }, { maximumItems: PI_NATIVE_BRIDGE_LIMITS.maximumTools, uniqueBy: (tool) => tool.name }, at(path, "tools")),
    }),
  };
  const bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
  if (bytes > limits.maximumContextBytes) {
    codecFail(path, "too-long", "native context exceeds the bridge byte limit");
  }
  let imageBytes = 0;
  for (const message of context.messages) {
    const content = message.role === "user" || message.role === "toolResult" ? message.content : [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "image") imageBytes += Buffer.byteLength(block.data, "base64");
      }
    }
  }
  if (imageBytes > PI_NATIVE_BRIDGE_LIMITS.maximumTotalImageBytes) {
    codecFail(path, "out-of-range", "native context exceeds the total image-byte limit");
  }
  return context;
}

function decodeCompatibility(input: unknown, path: CodecPath): PiNativeBridgeCompatibility {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["piCodingAgentVersion", "piAiVersion"], [], path);
  return {
    piCodingAgentVersion: decodeLiteral(object.piCodingAgentVersion, PI_NATIVE_BRIDGE_COMPATIBILITY.piCodingAgentVersion, at(path, "piCodingAgentVersion")),
    piAiVersion: decodeLiteral(object.piAiVersion, PI_NATIVE_BRIDGE_COMPATIBILITY.piAiVersion, at(path, "piAiVersion")),
  };
}

function decodeBinding(input: unknown, path: CodecPath): PiNativeBridgeBinding {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["bridgeId", "nativeStackDigest", "nativeCatalogDigest"], [], path);
  return {
    bridgeId: decodeLiteral(object.bridgeId, PI_NATIVE_BRIDGE_ID, at(path, "bridgeId")),
    nativeStackDigest: decodeIntegrityDigest(object.nativeStackDigest, at(path, "nativeStackDigest")),
    nativeCatalogDigest: decodeIntegrityDigest(object.nativeCatalogDigest, at(path, "nativeCatalogDigest")),
  };
}

function decodeBase(object: Record<string, unknown>, path: CodecPath): PiNativeBridgeBaseFrame {
  if (object.protocolVersion !== PI_NATIVE_BRIDGE_PROTOCOL_VERSION) {
    codecFail(at(path, "protocolVersion"), "invalid-format", "expected Pi native bridge protocol version 1");
  }
  return {
    protocolVersion: PI_NATIVE_BRIDGE_PROTOCOL_VERSION,
    correlationId: decodeCorrelationId(object.correlationId, at(path, "correlationId")),
    compatibility: decodeCompatibility(object.compatibility, at(path, "compatibility")),
    binding: decodeBinding(object.binding, at(path, "binding")),
  };
}

function decodeContentIndex(input: unknown, path: CodecPath): number {
  const value = decodeNonNegativeSafeInteger(input, path);
  if (value >= PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks) {
    codecFail(path, "out-of-range", "stream content index exceeds the bridge content limit");
  }
  return value;
}

function decodeInvoke(object: Record<string, unknown>, limits: Required<PiNativeBridgeFrameLimits>): PiNativeInvokeFrame {
  requireExactFields(object, ["protocolVersion", "kind", "correlationId", "compatibility", "binding", "context", "options", "nativeSeam"], [], []);
  const base = decodeBase(object, []);
  const options = decodePlainObject(object.options, ["options"]);
  requireExactFields(options, [], ["maximumOutputTokens", "reasoning"], ["options"]);
  const nativeSeam = decodePlainObject(object.nativeSeam, ["nativeSeam"]);
  requireExactFields(nativeSeam, ["maxRetries", "transport"], [], ["nativeSeam"]);
  if (nativeSeam.maxRetries !== 0) {
    codecFail(["nativeSeam", "maxRetries"], "invalid-format", "the native seam must force maxRetries to zero");
  }
  const maximumOutputTokens = options.maximumOutputTokens === undefined
    ? undefined
    : decodePositiveSafeInteger(options.maximumOutputTokens, ["options", "maximumOutputTokens"]);
  if (
    maximumOutputTokens !== undefined &&
    maximumOutputTokens > PI_NATIVE_BRIDGE_LIMITS.maximumOutputTokens
  ) {
    codecFail(
      ["options", "maximumOutputTokens"],
      "out-of-range",
      "maximum output tokens exceed the bridge execution ceiling",
    );
  }
  return {
    ...base,
    kind: decodeLiteral(object.kind, "invoke", ["kind"]),
    context: decodeContext(object.context, ["context"], limits),
    options: {
      ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
      ...(options.reasoning === undefined ? {} : { reasoning: decodeEnum(options.reasoning, ["none", "low", "medium", "high"] as const, ["options", "reasoning"]) }),
    },
    nativeSeam: {
      maxRetries: 0,
      transport: decodeLiteral(nativeSeam.transport, "sse", ["nativeSeam", "transport"]),
    },
  };
}

function decodeFrameByKind(object: Record<string, unknown>, limits: Required<PiNativeBridgeFrameLimits>): PiNativeBridgeFrame {
  const rawKind = object.kind;
  if (typeof rawKind !== "string") codecFail(["kind"], "invalid-type", "bridge frame kind must be a string");
  if (rawKind === "invoke") return decodeInvoke(object, limits);
  const baseFields = ["protocolVersion", "kind", "correlationId", "compatibility", "binding"] as const;
  const base = (): PiNativeBridgeBaseFrame => decodeBase(object, []);
  const simple = <Kind extends "cancel" | "started" | "cancelled">(kind: Kind): PiNativeBridgeBaseFrame & { readonly kind: Kind } => {
    requireExactFields(object, baseFields, [], []);
    return { ...base(), kind: decodeLiteral(object.kind, kind, ["kind"]) };
  };
  switch (rawKind) {
    case "cancel": return simple("cancel");
    case "started": return simple("started");
    case "cancelled": return simple("cancelled");
    case "text-start":
    case "reasoning-start":
    case "tool-start": {
      requireExactFields(object, [...baseFields, "contentIndex"], [], []);
      return { ...base(), kind: rawKind, contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]) } as PiNativeTextStartFrame | PiNativeReasoningStartFrame | PiNativeToolStartFrame;
    }
    case "text-delta":
    case "reasoning-delta":
    case "tool-delta": {
      requireExactFields(object, [...baseFields, "contentIndex", "delta"], [], []);
      return { ...base(), kind: rawKind, contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]), delta: decodeContentString(object.delta, ["delta"], "stream delta") } as PiNativeTextDeltaFrame | PiNativeReasoningDeltaFrame | PiNativeToolDeltaFrame;
    }
    case "text-end":
    case "reasoning-end": {
      requireExactFields(object, [...baseFields, "contentIndex", "content"], [], []);
      return { ...base(), kind: rawKind, contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]), content: decodeContentString(object.content, ["content"], "stream content") } as PiNativeTextEndFrame | PiNativeReasoningEndFrame;
    }
    case "tool-end": {
      requireExactFields(object, [...baseFields, "contentIndex", "toolCall"], [], []);
      return { ...base(), kind: "tool-end", contentIndex: decodeContentIndex(object.contentIndex, ["contentIndex"]), toolCall: decodeToolCall(object.toolCall, ["toolCall"]) };
    }
    case "usage": {
      requireExactFields(object, [...baseFields, "usage"], [], []);
      return { ...base(), kind: "usage", usage: decodeUsage(object.usage, ["usage"]) };
    }
    case "error": {
      requireExactFields(object, [...baseFields, "code", "message"], [], []);
      return {
        ...base(),
        kind: "error",
        code: decodeEnum(object.code, ["provider-error", "credential-unavailable", "protocol-error", "policy-denied"] as const, ["code"]),
        message: decodeBoundedString(object.message, { maximumLength: PI_NATIVE_BRIDGE_LIMITS.maximumErrorCharacters, label: "sanitized bridge error" }, ["message"]),
      };
    }
    case "terminal": {
      requireExactFields(object, [...baseFields, "reason", "usage"], [], []);
      return { ...base(), kind: "terminal", reason: decodeEnum(object.reason, ["stop", "length", "toolUse"] as const, ["reason"]), usage: decodeUsage(object.usage, ["usage"]) };
    }
    case "oauth-status": {
      requireExactFields(object, [...baseFields, "state"], [], []);
      return { ...base(), kind: "oauth-status", state: decodeEnum(object.state, ["refresh-started", "refresh-succeeded", "refresh-failed"] as const, ["state"]) };
    }
    default:
      codecFail(["kind"], "unsupported-discriminant", "unsupported Pi native bridge frame kind");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function decodeDetachedPiNativeBridgeFrame(
  input: unknown,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeFrame {
  return deepFreeze(
    decodeFrameByKind(decodePlainObject(input), resolveLimits(limits)),
  );
}

/** Decode one already-parsed frame against an explicit pinned binding. */
export function decodePiNativeBridgeFrame(
  input: unknown,
  expectation: PiNativeBridgeFrameExpectation,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeFrame {
  const decoded = decodeDetachedPiNativeBridgeFrame(input, limits);
  assertPiNativeBridgeFrameMatches(decoded, expectation);
  return decoded;
}

export function decodePiNativeBridgeClientFrame(
  input: unknown,
  expectation: PiNativeBridgeFrameExpectation,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeClientFrame {
  const frame = decodePiNativeBridgeFrame(input, expectation, limits);
  if (frame.kind !== "invoke" && frame.kind !== "cancel") {
    codecFail(["kind"], "unsupported-discriminant", "expected a worker-to-sidecar bridge frame");
  }
  return frame;
}

export function decodePiNativeBridgeSidecarFrame(
  input: unknown,
  expectation: PiNativeBridgeFrameExpectation,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeSidecarFrame {
  const frame = decodePiNativeBridgeFrame(input, expectation, limits);
  if (frame.kind === "invoke" || frame.kind === "cancel") {
    codecFail(["kind"], "unsupported-discriminant", "expected a sidecar-to-worker bridge frame");
  }
  return frame;
}

export function assertPiNativeBridgeFrameMatches(
  frame: PiNativeBridgeFrame,
  expectation: PiNativeBridgeFrameExpectation,
): void {
  if (
    expectation === undefined ||
    expectation.binding === undefined
  ) {
    codecFail(
      [],
      "invalid-type",
      "a pinned bridge binding expectation is required",
    );
  }
  if (expectation.correlationId !== undefined && frame.correlationId !== expectation.correlationId) {
    codecFail(["correlationId"], "invalid-format", "bridge correlation ID does not match the active request");
  }
  const expected = expectation.binding;
  if (
    frame.binding.bridgeId !== expected.bridgeId ||
    frame.binding.nativeStackDigest !== expected.nativeStackDigest ||
    frame.binding.nativeCatalogDigest !== expected.nativeCatalogDigest
  ) {
    codecFail(["binding"], "invalid-format", "bridge binding does not match the pinned native stack/catalog");
  }
}

/** Encode one canonical single-line UTF-8 JSONL frame. The returned bytes are new on every call. */
export function encodePiNativeBridgeFrame(
  input: unknown,
  limits?: PiNativeBridgeFrameLimits,
): Uint8Array {
  const resolved = resolveLimits(limits);
  const frame = decodeDetachedPiNativeBridgeFrame(input, resolved);
  const bytes = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
  if (bytes.length > resolved.maximumFrameBytes) {
    codecFail([], "too-long", "encoded bridge frame exceeds the byte limit");
  }
  return bytes;
}

/**
 * Strict JSON parser used only at the JSONL boundary. JSON.parse cannot report
 * duplicate properties, which would otherwise make authorization-relevant
 * fields ambiguous before the structural codecs see them.
 */
export function parseStrictPiNativeBridgeJson(input: string): unknown {
  let index = 0;
  let nodes = 0;
  const maximumDepth = 64;
  const maximumNodes = 20_000;
  const maximumContainerItems = 1_024;
  // An image is allowed to consume most of a valid frame. UTF-8 frame-byte
  // validation still supplies the stricter actual allocation ceiling.
  const maximumStringCharacters = PI_NATIVE_BRIDGE_LIMITS.maximumFrameBytes;
  const whitespace = (): void => {
    while (input[index] === " " || input[index] === "\t" || input[index] === "\r" || input[index] === "\n") index += 1;
  };
  const fail = (message: string): never => codecFail([], "invalid-format", `invalid bridge JSON: ${message}`);
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
          if (decoded.length > maximumStringCharacters) return fail("string exceeds parser limit");
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
    if (nodes > maximumNodes) return fail("node limit exceeded");
    if (depth > maximumDepth) return fail("nesting limit exceeded");
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
        if (seen.size >= maximumContainerItems) return fail("object field limit exceeded");
        whitespace();
        const key = string();
        if (seen.has(key)) codecFail([key], "duplicate-item", "duplicate JSON object field");
        seen.add(key);
        whitespace();
        if (input[index] !== ":") return fail("expected colon");
        index += 1;
        const child = value(depth + 1);
        Object.defineProperty(output, key, { value: child, enumerable: true, configurable: true, writable: true });
        whitespace();
        if (input[index] === "}") {
          index += 1;
          return output;
        }
        if (input[index] !== ",") return fail("expected comma or object end");
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
        if (output.length >= maximumContainerItems) return fail("array item limit exceeded");
        output.push(value(depth + 1));
        whitespace();
        if (input[index] === "]") {
          index += 1;
          return output;
        }
        if (input[index] !== ",") return fail("expected comma or array end");
        index += 1;
      }
    }
    if (input.startsWith("true", index)) { index += 4; return true; }
    if (input.startsWith("false", index)) { index += 5; return false; }
    if (input.startsWith("null", index)) { index += 4; return null; }
    const number = input.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
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

/** Decode exactly one non-blank, non-CR, non-multiline UTF-8 JSONL frame. */
export function decodePiNativeBridgeJsonlFrame(
  bytes: Uint8Array,
  expectation: PiNativeBridgeFrameExpectation,
  limits?: PiNativeBridgeFrameLimits,
): PiNativeBridgeFrame {
  const resolved = resolveLimits(limits);
  if (bytes.length === 0 || bytes.length > resolved.maximumFrameBytes) {
    codecFail([], "too-long", "bridge JSONL frame violates the byte limit");
  }
  if (bytes[bytes.length - 1] !== 0x0a || bytes.length === 1) {
    codecFail([], "invalid-format", "bridge JSONL requires one non-blank LF-terminated frame");
  }
  for (let byteIndex = 0; byteIndex < bytes.length - 1; byteIndex += 1) {
    const byte = bytes[byteIndex]!;
    if (byte === 0x0a || byte === 0x0d) codecFail([], "invalid-format", "bridge JSONL forbids embedded or CR line breaks");
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    codecFail([], "invalid-format", "bridge JSONL forbids a UTF-8 byte-order mark");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
  } catch {
    codecFail([], "invalid-format", "bridge JSONL is not valid UTF-8");
  }
  return decodePiNativeBridgeFrame(
    parseStrictPiNativeBridgeJson(text),
    expectation,
    resolved,
  );
}

type CorrelationState = "invoked" | "started";
type ContentStreamKind = "text" | "reasoning" | "tool";

interface CorrelationRecord {
  state: CorrelationState;
  cancelRequested: boolean;
  readonly binding: PiNativeBridgeBinding;
  readonly content: Map<number, { readonly kind: ContentStreamKind; state: "open" | "closed" }>;
}

/**
 * Small in-memory protocol guard. It is not durable replay prevention; V2-011's
 * forwarding authorization remains the durable once-only boundary. It does
 * reject duplicate invocation/start/terminal frames and bad direction/order.
 */
export class PiNativeBridgeCorrelationGuard {
  readonly #states = new Map<string, CorrelationRecord>();

  acceptClient(frame: PiNativeBridgeClientFrame): void {
    const prior = this.#states.get(frame.correlationId);
    if (frame.kind === "invoke") {
      if (prior !== undefined) codecFail(["correlationId"], "duplicate-item", "duplicate bridge invocation correlation");
      if (
        this.#states.size >=
        PI_NATIVE_BRIDGE_LIMITS.maximumActiveCorrelations
      ) {
        codecFail(
          ["correlationId"],
          "out-of-range",
          "too many active bridge correlations",
        );
      }
      this.#states.set(frame.correlationId, {
        state: "invoked",
        cancelRequested: false,
        binding: frame.binding,
        content: new Map(),
      });
      return;
    }
    if (prior === undefined || prior.cancelRequested) {
      codecFail(["correlationId"], "invalid-format", "bridge cancellation is not correlated to one live invocation");
    }
    assertSameCorrelationBinding(prior.binding, frame.binding);
    prior.cancelRequested = true;
  }

  acceptSidecar(frame: PiNativeBridgeSidecarFrame): void {
    const prior = this.#states.get(frame.correlationId);
    if (prior === undefined) codecFail(["correlationId"], "invalid-format", "sidecar frame has no active invocation correlation");
    assertSameCorrelationBinding(prior.binding, frame.binding);
    if (frame.kind === "cancelled" || frame.kind === "error") {
      // Connection or provider setup can fail before a started frame. V2-011
      // owns durable replay denial after this in-memory record is released.
      this.#states.delete(frame.correlationId);
      return;
    }
    if (frame.kind === "started") {
      if (prior.state !== "invoked") codecFail(["kind"], "duplicate-item", "bridge invocation may start once");
      prior.state = "started";
      return;
    }
    if (prior.state !== "started") {
      codecFail(["kind"], "invalid-format", "sidecar stream frame arrived before start or after terminal");
    }
    if (frame.kind === "terminal") {
      if ([...prior.content.values()].some((content) => content.state === "open")) {
        codecFail(["kind"], "invalid-format", "terminal bridge frame cannot leave content streams open");
      }
      this.#states.delete(frame.correlationId);
      return;
    }
    const start = streamStart(frame);
    if (start !== undefined) {
      const { contentIndex } = start;
      if (prior.content.has(contentIndex)) {
        codecFail(["contentIndex"], "duplicate-item", "stream content index may start once with one content kind");
      }
      prior.content.set(contentIndex, { kind: start.kind, state: "open" });
      return;
    }
    const continuation = streamContinuation(frame);
    if (continuation !== undefined) {
      const existing = prior.content.get(continuation.contentIndex);
      if (existing === undefined || existing.kind !== continuation.kind || existing.state !== "open") {
        codecFail(["contentIndex"], "invalid-format", "stream delta/end does not match one open content stream");
      }
      if (continuation.end) existing.state = "closed";
    }
  }

  /** Trusted transport cleanup for a consumer that closes before a terminal frame. */
  release(correlationId: string): void {
    this.#states.delete(correlationId);
  }
}

function assertSameCorrelationBinding(
  expected: PiNativeBridgeBinding,
  actual: PiNativeBridgeBinding,
): void {
  if (
    expected.bridgeId !== actual.bridgeId ||
    expected.nativeStackDigest !== actual.nativeStackDigest ||
    expected.nativeCatalogDigest !== actual.nativeCatalogDigest
  ) {
    codecFail(
      ["binding"],
      "invalid-format",
      "bridge correlation changed its pinned native stack/catalog binding",
    );
  }
}

function streamStart(frame: PiNativeBridgeSidecarFrame): { readonly contentIndex: number; readonly kind: ContentStreamKind } | undefined {
  switch (frame.kind) {
    case "text-start": return { contentIndex: frame.contentIndex, kind: "text" };
    case "reasoning-start": return { contentIndex: frame.contentIndex, kind: "reasoning" };
    case "tool-start": return { contentIndex: frame.contentIndex, kind: "tool" };
    default: return undefined;
  }
}

function streamContinuation(frame: PiNativeBridgeSidecarFrame): { readonly contentIndex: number; readonly kind: ContentStreamKind; readonly end: boolean } | undefined {
  switch (frame.kind) {
    case "text-delta": return { contentIndex: frame.contentIndex, kind: "text", end: false };
    case "text-end": return { contentIndex: frame.contentIndex, kind: "text", end: true };
    case "reasoning-delta": return { contentIndex: frame.contentIndex, kind: "reasoning", end: false };
    case "reasoning-end": return { contentIndex: frame.contentIndex, kind: "reasoning", end: true };
    case "tool-delta": return { contentIndex: frame.contentIndex, kind: "tool", end: false };
    case "tool-end": return { contentIndex: frame.contentIndex, kind: "tool", end: true };
    default: return undefined;
  }
}

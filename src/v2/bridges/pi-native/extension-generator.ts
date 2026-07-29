/** Deterministic source generator for the one reviewed Pi 0.82.0 extension. */

import { createHash } from "node:crypto";

import { digestCanonicalJson, encodeCanonicalJson } from "../../codecs/json.js";
import { decodeSecretFreeJsonValue } from "../../codecs/projections.js";
import { codecFail, type CodecPath } from "../../codecs/errors.js";
import {
  decodeBoundedArray,
  decodeBoundedString,
  decodeIntegrityDigest,
  decodePositiveSafeInteger,
} from "../../codecs/primitives.js";
import { decodeBoolean, decodeEnum, decodeLiteral, decodePlainObject, requireExactFields } from "../../codecs/structure.js";
import type { IntegrityDigest } from "../../model/primitives.js";
import {
  PI_NATIVE_BRIDGE_COMPATIBILITY,
  PI_NATIVE_BRIDGE_ID,
  PI_NATIVE_BRIDGE_LIMITS,
  PI_NATIVE_BRIDGE_PROTOCOL_VERSION,
  type PiNativeBridgeBinding,
} from "./frames.js";

export const PI_NATIVE_EXTENSION_MANIFEST_VERSION = 1 as const;
export const PI_NATIVE_EXTENSION_SOCKET_PATH = "/hitch/pi-native.sock" as const;

export interface PiNativeExtensionSemanticManifest {
  readonly manifestVersion: 1;
  readonly bridgeId: "pi-native-sidecar-v1";
  readonly compatibility: {
    readonly piCodingAgentVersion: "0.82.0";
    readonly piAiVersion: "0.82.0";
    readonly nativeStackDigest: IntegrityDigest;
  };
  readonly nativeCatalogDigest: IntegrityDigest;
  /** One exact provider projection; no discovery, base URL, or origin exists here. */
  readonly provider: {
    readonly id: string;
    readonly displayName: string;
    readonly model: {
      readonly id: string;
      readonly displayName: string;
      readonly api: string;
      readonly reasoning: boolean;
      readonly input: readonly ("text" | "image")[];
      readonly contextWindowTokens: number;
      readonly maximumOutputTokens: number;
    };
  };
}

export interface GeneratedPiNativeBridgeExtension {
  readonly fileName: "hitch-pi-native-bridge-0.82.0.mjs";
  readonly semanticManifest: PiNativeExtensionSemanticManifest;
  readonly semanticManifestDigest: IntegrityDigest;
  readonly source: string;
  readonly artifactDigest: IntegrityDigest;
  /** Always returns a fresh copy; callers cannot mutate the retained artifact. */
  sourceUtf8(): Uint8Array;
}

const SAFE_REFERENCE = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;

function decodeReference(input: unknown, path: CodecPath, label: string): string {
  return decodeBoundedString(input, { minimumLength: 1, maximumLength: 128, pattern: SAFE_REFERENCE, label }, path);
}

function decodeDisplayName(input: unknown, path: CodecPath, label: string): string {
  const value = decodeBoundedString(input, { minimumLength: 1, maximumLength: 120, label }, path);
  if (/[/\\\u0000-\u001f\u007f]/u.test(value)) {
    codecFail(path, "invalid-format", `${label} cannot contain a path separator or control character`);
  }
  decodeSecretFreeJsonValue(value, { forbiddenPaths: "all" }, path);
  return value;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Decodes only semantic, secret-free facts embedded in the reviewed source.
 * Any source, command, argument, environment, loader, path, origin, header,
 * auth, or credential field is an unknown field and fails closed.
 */
export function decodePiNativeExtensionSemanticManifest(input: unknown): PiNativeExtensionSemanticManifest {
  const object = decodePlainObject(input);
  requireExactFields(object, ["manifestVersion", "bridgeId", "compatibility", "nativeCatalogDigest", "provider"], [], []);
  const compatibility = decodePlainObject(object.compatibility, ["compatibility"]);
  requireExactFields(compatibility, ["piCodingAgentVersion", "piAiVersion", "nativeStackDigest"], [], ["compatibility"]);
  const provider = decodePlainObject(object.provider, ["provider"]);
  requireExactFields(provider, ["id", "displayName", "model"], [], ["provider"]);
  const model = decodePlainObject(provider.model, ["provider", "model"]);
  requireExactFields(model, ["id", "displayName", "api", "reasoning", "input", "contextWindowTokens", "maximumOutputTokens"], [], ["provider", "model"]);
  const contextWindowTokens = decodePositiveSafeInteger(model.contextWindowTokens, ["provider", "model", "contextWindowTokens"]);
  const maximumOutputTokens = decodePositiveSafeInteger(model.maximumOutputTokens, ["provider", "model", "maximumOutputTokens"]);
  if (maximumOutputTokens > contextWindowTokens) {
    codecFail(["provider", "model", "maximumOutputTokens"], "out-of-range", "maximum output tokens cannot exceed the context window");
  }
  if (object.manifestVersion !== PI_NATIVE_EXTENSION_MANIFEST_VERSION) {
    codecFail(["manifestVersion"], "invalid-format", "expected Pi native extension manifest version 1");
  }
  const decoded: PiNativeExtensionSemanticManifest = {
    manifestVersion: PI_NATIVE_EXTENSION_MANIFEST_VERSION,
    bridgeId: decodeLiteral(object.bridgeId, PI_NATIVE_BRIDGE_ID, ["bridgeId"]),
    compatibility: {
      piCodingAgentVersion: decodeLiteral(compatibility.piCodingAgentVersion, PI_NATIVE_BRIDGE_COMPATIBILITY.piCodingAgentVersion, ["compatibility", "piCodingAgentVersion"]),
      piAiVersion: decodeLiteral(compatibility.piAiVersion, PI_NATIVE_BRIDGE_COMPATIBILITY.piAiVersion, ["compatibility", "piAiVersion"]),
      nativeStackDigest: decodeIntegrityDigest(compatibility.nativeStackDigest, ["compatibility", "nativeStackDigest"]),
    },
    nativeCatalogDigest: decodeIntegrityDigest(object.nativeCatalogDigest, ["nativeCatalogDigest"]),
    provider: {
      id: decodeReference(provider.id, ["provider", "id"], "provider ID"),
      displayName: decodeDisplayName(provider.displayName, ["provider", "displayName"], "provider display name"),
      model: {
        id: decodeReference(model.id, ["provider", "model", "id"], "model ID"),
        displayName: decodeDisplayName(model.displayName, ["provider", "model", "displayName"], "model display name"),
        api: decodeReference(model.api, ["provider", "model", "api"], "Pi API"),
        reasoning: decodeBoolean(model.reasoning, ["provider", "model", "reasoning"]),
        input: decodeBoundedArray(
          model.input,
          (value, path) => decodeEnum(value, ["text", "image"] as const, path),
          { minimumItems: 1, maximumItems: 2, uniqueBy: String },
          ["provider", "model", "input"],
        ),
        contextWindowTokens,
        maximumOutputTokens,
      },
    },
  };
  if (!decoded.provider.model.input.includes("text")) {
    codecFail(["provider", "model", "input"], "invalid-format", "the reviewed Pi bridge always requires text input");
  }
  return freeze(decoded);
}

function artifactDigest(source: string): IntegrityDigest {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}` as IntegrityDigest;
}

function reviewedSource(manifest: PiNativeExtensionSemanticManifest): string {
  // encodeCanonicalJson both normalizes property order and prevents interpolation
  // from turning an unusual display name into executable source.
  const manifestJson = encodeCanonicalJson(manifest);
  return `// Generated by Hitch V2-006A1. Do not edit; verify its sha256 digest before loading.
import net from "node:net";
import { randomUUID } from "node:crypto";

const MANIFEST = Object.freeze(${manifestJson});
const SOCKET_PATH = ${JSON.stringify(PI_NATIVE_EXTENSION_SOCKET_PATH)};
const PROTOCOL_VERSION = ${PI_NATIVE_BRIDGE_PROTOCOL_VERSION};
const MAX_FRAME_BYTES = ${PI_NATIVE_BRIDGE_LIMITS.maximumFrameBytes};
const MAX_CONTEXT_BYTES = ${PI_NATIVE_BRIDGE_LIMITS.maximumContextBytes};
const MAX_TEXT = ${PI_NATIVE_BRIDGE_LIMITS.maximumTextCharacters};
const MAX_IMAGE_BYTES = ${PI_NATIVE_BRIDGE_LIMITS.maximumImageBytes};
const MAX_TOOL_ARGUMENT_BYTES = ${PI_NATIVE_BRIDGE_LIMITS.maximumToolArgumentsBytes};
const MAX_CONTENT = ${PI_NATIVE_BRIDGE_LIMITS.maximumContentBlocks};
const MAX_MESSAGES = ${PI_NATIVE_BRIDGE_LIMITS.maximumMessages};
const MAX_TOOLS = ${PI_NATIVE_BRIDGE_LIMITS.maximumTools};
const MAX_QUEUED_EVENTS = 256;
const MAX_STREAM_EVENTS = 4096;
const NATIVE_SEAM = Object.freeze({ maxRetries: 0, transport: "sse" });
const BINDING = Object.freeze({ bridgeId: MANIFEST.bridgeId, nativeStackDigest: MANIFEST.compatibility.nativeStackDigest, nativeCatalogDigest: MANIFEST.nativeCatalogDigest });
const COMPATIBILITY = Object.freeze({ piCodingAgentVersion: MANIFEST.compatibility.piCodingAgentVersion, piAiVersion: MANIFEST.compatibility.piAiVersion });
const REF = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;
const CORRELATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function fail(message) { throw new Error("Hitch native bridge protocol error: " + message); }
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) fail(label + " must be a plain object");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === "__proto__" || key === "constructor" || key === "prototype" || !descriptor.enumerable || !("value" in descriptor)) fail(label + " contains an unsafe field");
  }
  return value;
}
function exact(value, required, optional, label) {
  const object = record(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(label + " has an unknown field");
  for (const key of required) if (!Object.hasOwn(object, key)) fail(label + " is missing a required field");
  return object;
}
function text(value, maximum, label) {
  if (typeof value !== "string" || value.length > maximum || /[\\ud800-\\udfff]/u.test(value)) fail(label + " is not a bounded Unicode string");
  return value;
}
function reference(value, label) {
  const result = text(value, 128, label);
  if (!REF.test(result)) fail(label + " is not a safe reference");
  return result;
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(label + " is not a safe bounded integer");
  return value;
}
function boolean(value, label) {
  if (typeof value !== "boolean") fail(label + " is not a boolean");
  return value;
}
function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0) fail(label + " is not a bounded plain array");
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) fail(label + " is sparse");
  return value;
}
function json(value, state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 4096 || depth > 20) fail("JSON value exceeds structural bounds");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, 65_536, "JSON string");
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("JSON number is not finite"); return Object.is(value, -0) ? 0 : value; }
  if (Array.isArray(value)) return boundedArray(value, 512, "JSON array").map((item) => json(item, state, depth + 1));
  const object = record(value, "JSON object");
  const keys = Object.keys(object);
  if (keys.length > 256) fail("JSON object has too many fields");
  const output = {};
  for (const key of keys) { text(key, 65_536, "JSON key"); Object.defineProperty(output, key, { value: json(object[key], state, depth + 1), enumerable: true, writable: true, configurable: true }); }
  return output;
}
function jsonObject(value, label) { return json(record(value, label)); }
function image(value, label) {
  const object = exact(value, ["type", "mimeType", "data"], [], label);
  if (object.type !== "image" || !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(object.mimeType)) fail(label + " is not a supported image");
  const data = text(object.data, Math.ceil(MAX_IMAGE_BYTES / 3) * 4, label + " data");
  if (!BASE64.test(data)) fail(label + " is not canonical base64");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) fail(label + " exceeds image bounds");
  return { type: "image", mimeType: object.mimeType, data };
}
function inputContent(value, label) {
  const object = record(value, label);
  if (object.type === "image") return image(object, label);
  exact(object, ["type", "text"], ["textSignature"], label);
  if (object.type !== "text") fail(label + " has an unsupported type");
  return { type: "text", text: text(object.text, MAX_TEXT, label + " text") };
}
function usage(value, label) {
  const object = exact(value, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"], ["reasoningTokens"], label);
  const output = { inputTokens: integer(object.inputTokens, 0, Number.MAX_SAFE_INTEGER, label + " input"), outputTokens: integer(object.outputTokens, 0, Number.MAX_SAFE_INTEGER, label + " output"), cacheReadTokens: integer(object.cacheReadTokens, 0, Number.MAX_SAFE_INTEGER, label + " cache read"), cacheWriteTokens: integer(object.cacheWriteTokens, 0, Number.MAX_SAFE_INTEGER, label + " cache write"), totalTokens: integer(object.totalTokens, 0, Number.MAX_SAFE_INTEGER, label + " total") };
  return object.reasoningTokens === undefined ? output : { ...output, reasoningTokens: integer(object.reasoningTokens, 0, Number.MAX_SAFE_INTEGER, label + " reasoning") };
}
function normalizedUsage(value, label) {
  const object = record(value, label);
  return usage({ inputTokens: object.input, outputTokens: object.output, cacheReadTokens: object.cacheRead, cacheWriteTokens: object.cacheWrite, totalTokens: object.totalTokens, ...(object.reasoning === undefined ? {} : { reasoningTokens: object.reasoning }) }, label);
}
function toolCall(value, label) {
  const object = exact(value, ["type", "id", "name", "arguments"], ["thoughtSignature"], label);
  if (object.type !== "toolCall") fail(label + " has an unsupported type");
  const argumentsValue = jsonObject(object.arguments, label + " arguments");
  if (Buffer.byteLength(JSON.stringify(argumentsValue), "utf8") > MAX_TOOL_ARGUMENT_BYTES) fail(label + " arguments exceed the bridge byte bound");
  return { type: "toolCall", id: reference(object.id, label + " ID"), name: reference(object.name, label + " name"), arguments: argumentsValue, ...(object.thoughtSignature === undefined ? {} : { thoughtSignature: text(object.thoughtSignature, MAX_TEXT, label + " signature") }) };
}
function assistantContent(value, label) {
  const object = record(value, label);
  if (object.type === "text") { exact(object, ["type", "text"], ["textSignature"], label); return { type: "text", text: text(object.text, MAX_TEXT, label + " text"), ...(object.textSignature === undefined ? {} : { textSignature: text(object.textSignature, MAX_TEXT, label + " signature") }) }; }
  if (object.type === "thinking") { exact(object, ["type", "thinking"], ["thinkingSignature", "redacted"], label); return { type: "thinking", thinking: text(object.thinking, MAX_TEXT, label + " reasoning"), ...(object.thinkingSignature === undefined ? {} : { thinkingSignature: text(object.thinkingSignature, MAX_TEXT, label + " signature") }), ...(object.redacted === undefined ? {} : { redacted: boolean(object.redacted, label + " redacted") }) }; }
  return toolCall(object, label);
}
function contextMessage(value, label) {
  const object = record(value, label);
  if (object.role === "user") {
    exact(object, ["role", "content", "timestamp"], [], label);
    const content = typeof object.content === "string" ? text(object.content, MAX_TEXT, label + " content") : boundedArray(object.content, MAX_CONTENT, label + " content").map((entry, index) => inputContent(entry, label + " content " + index));
    return { role: "user", content, timestamp: integer(object.timestamp, 0, Number.MAX_SAFE_INTEGER, label + " timestamp") };
  }
  if (object.role === "assistant") {
    exact(object, ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"], ["responseModel", "responseId", "errorMessage", "diagnostics"], label);
    if (!["stop", "length", "toolUse", "error", "aborted"].includes(object.stopReason)) fail(label + " has an invalid stop reason");
    return { role: "assistant", content: boundedArray(object.content, MAX_CONTENT, label + " content").map((entry, index) => assistantContent(entry, label + " content " + index)), api: reference(object.api, label + " API"), provider: reference(object.provider, label + " provider"), model: reference(object.model, label + " model"), stopReason: object.stopReason, timestamp: integer(object.timestamp, 0, Number.MAX_SAFE_INTEGER, label + " timestamp"), usage: normalizedUsage(object.usage, label + " usage"), ...(object.responseModel === undefined ? {} : { responseModel: reference(object.responseModel, label + " response model") }), ...(object.responseId === undefined ? {} : { responseId: reference(object.responseId, label + " response ID") }), ...(object.errorMessage === undefined ? {} : { errorMessage: text(object.errorMessage, MAX_TEXT, label + " error") }) };
  }
  exact(object, ["role", "toolCallId", "toolName", "content", "isError", "timestamp"], ["details", "usage", "addedToolNames"], label);
  if (object.role !== "toolResult" || typeof object.isError !== "boolean") fail(label + " has an invalid role or error flag");
  return { role: "toolResult", toolCallId: reference(object.toolCallId, label + " tool call ID"), toolName: reference(object.toolName, label + " tool name"), content: boundedArray(object.content, MAX_CONTENT, label + " content").map((entry, index) => inputContent(entry, label + " content " + index)), isError: object.isError, timestamp: integer(object.timestamp, 0, Number.MAX_SAFE_INTEGER, label + " timestamp"), ...(object.addedToolNames === undefined ? {} : { addedToolNames: boundedArray(object.addedToolNames, MAX_TOOLS, label + " added tools").map((entry) => reference(entry, label + " added tool")) }), ...(object.usage === undefined ? {} : { usage: normalizedUsage(object.usage, label + " usage") }) };
}
function normalizeContext(value) {
  const object = exact(value, ["messages"], ["systemPrompt", "tools"], "Pi context");
  const output = { messages: boundedArray(object.messages, MAX_MESSAGES, "Pi messages").map((message, index) => contextMessage(message, "Pi message " + index)), ...(object.systemPrompt === undefined ? {} : { systemPrompt: text(object.systemPrompt, MAX_TEXT, "Pi system prompt") }), ...(object.tools === undefined ? {} : { tools: boundedArray(object.tools, MAX_TOOLS, "Pi tools").map((tool, index) => { const item = exact(tool, ["name", "description", "parameters"], ["constrainedSampling"], "Pi tool " + index); return { name: reference(item.name, "Pi tool name"), description: text(item.description, MAX_TEXT, "Pi tool description"), parameters: jsonObject(item.parameters, "Pi tool parameters") }; }) }) };
  let imageBytes = 0;
  for (const message of output.messages) if (Array.isArray(message.content)) for (const content of message.content) if (content.type === "image") imageBytes += Buffer.byteLength(content.data, "base64");
  if (imageBytes > MAX_IMAGE_BYTES || Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_CONTEXT_BYTES) fail("Pi context exceeds bridge byte bounds");
  return output;
}
function frame(kind, correlationId, extra = {}) { return { protocolVersion: PROTOCOL_VERSION, kind, correlationId, compatibility: COMPATIBILITY, binding: BINDING, ...extra }; }
function encodeFrame(value) { const encoded = JSON.stringify(value) + "\\n"; if (Buffer.byteLength(encoded, "utf8") > MAX_FRAME_BYTES) fail("outbound frame exceeds byte bound"); return encoded; }

function parseStrictJson(input) {
  let index = 0; let nodes = 0;
  const white = () => { while ([" ", "\\t", "\\n", "\\r"].includes(input[index])) index += 1; };
  const string = () => { if (input[index] !== '"') fail("JSON expected string"); const start = index; index += 1; let escaped = false; while (index < input.length) { const code = input.charCodeAt(index); if (code < 0x20) fail("JSON control character"); if (!escaped && input[index] === '"') { index += 1; const result = JSON.parse(input.slice(start, index)); if (result.length > MAX_FRAME_BYTES) fail("JSON string too long"); return result; } if (!escaped && input[index] === "\\\\") escaped = true; else escaped = false; index += 1; } fail("JSON unterminated string"); };
  const value = (depth) => { nodes += 1; if (nodes > 20_000 || depth > 64) fail("JSON structural limit"); white(); const token = input[index]; if (token === '"') return string(); if (token === "{") { index += 1; white(); const output = {}; const seen = new Set(); if (input[index] === "}") { index += 1; return output; } while (true) { if (seen.size >= 1024) fail("JSON object field limit"); white(); const key = string(); if (seen.has(key)) fail("duplicate JSON key"); seen.add(key); white(); if (input[index] !== ":") fail("JSON missing colon"); index += 1; Object.defineProperty(output, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true }); white(); if (input[index] === "}") { index += 1; return output; } if (input[index] !== ",") fail("JSON missing comma"); index += 1; } } if (token === "[") { index += 1; white(); const output = []; if (input[index] === "]") { index += 1; return output; } while (true) { if (output.length >= 1024) fail("JSON array item limit"); output.push(value(depth + 1)); white(); if (input[index] === "]") { index += 1; return output; } if (input[index] !== ",") fail("JSON missing comma"); index += 1; } } if (input.startsWith("true", index)) { index += 4; return true; } if (input.startsWith("false", index)) { index += 5; return false; } if (input.startsWith("null", index)) { index += 4; return null; } const number = input.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0]; if (number !== undefined) { index += number.length; const result = Number(number); if (!Number.isFinite(result)) fail("JSON non-finite number"); return result; } fail("JSON unexpected token"); };
  const result = value(0); white(); if (index !== input.length) fail("JSON trailing data"); return result;
}
function base(value, correlationId, allowed) {
  const object = exact(value, allowed, [], "sidecar frame");
  if (object.protocolVersion !== PROTOCOL_VERSION || object.correlationId !== correlationId || !CORRELATION.test(object.correlationId)) fail("uncorrelated sidecar frame");
  const compatibility = exact(object.compatibility, ["piCodingAgentVersion", "piAiVersion"], [], "sidecar compatibility");
  const binding = exact(object.binding, ["bridgeId", "nativeStackDigest", "nativeCatalogDigest"], [], "sidecar binding");
  if (compatibility.piCodingAgentVersion !== COMPATIBILITY.piCodingAgentVersion || compatibility.piAiVersion !== COMPATIBILITY.piAiVersion || binding.bridgeId !== BINDING.bridgeId || binding.nativeStackDigest !== BINDING.nativeStackDigest || binding.nativeCatalogDigest !== BINDING.nativeCatalogDigest) fail("sidecar binding mismatch");
  return object;
}
function streamIndex(value) { return integer(value, 0, MAX_CONTENT - 1, "stream content index"); }
function sidecarFrame(value, correlationId) {
  const common = ["protocolVersion", "kind", "correlationId", "compatibility", "binding"];
  const kind = record(value, "sidecar frame").kind;
  if (kind === "started" || kind === "cancelled") { base(value, correlationId, [...common]); return { kind }; }
  if (kind === "text-start" || kind === "reasoning-start" || kind === "tool-start") { const frame = base(value, correlationId, [...common, "contentIndex"]); return { kind, contentIndex: streamIndex(frame.contentIndex) }; }
  if (kind === "text-delta" || kind === "reasoning-delta" || kind === "tool-delta") { const frame = base(value, correlationId, [...common, "contentIndex", "delta"]); return { kind, contentIndex: streamIndex(frame.contentIndex), delta: text(frame.delta, MAX_TEXT, "stream delta") }; }
  if (kind === "text-end" || kind === "reasoning-end") { const frame = base(value, correlationId, [...common, "contentIndex", "content"]); return { kind, contentIndex: streamIndex(frame.contentIndex), content: text(frame.content, MAX_TEXT, "stream content") }; }
  if (kind === "tool-end") { const frame = base(value, correlationId, [...common, "contentIndex", "toolCall"]); return { kind, contentIndex: streamIndex(frame.contentIndex), toolCall: toolCall(frame.toolCall, "stream tool call") }; }
  if (kind === "usage") { const frame = base(value, correlationId, [...common, "usage"]); return { kind, usage: usage(frame.usage, "stream usage") }; }
  if (kind === "oauth-status") { const frame = base(value, correlationId, [...common, "state"]); if (!["refresh-started", "refresh-succeeded", "refresh-failed"].includes(frame.state)) fail("invalid OAuth status"); return { kind, state: frame.state }; }
  if (kind === "terminal") { const frame = base(value, correlationId, [...common, "reason", "usage"]); if (!["stop", "length", "toolUse"].includes(frame.reason)) fail("invalid terminal reason"); return { kind, reason: frame.reason, usage: usage(frame.usage, "terminal usage") }; }
  if (kind === "error") { const frame = base(value, correlationId, [...common, "code", "message"]); if (!["provider-error", "credential-unavailable", "protocol-error", "policy-denied"].includes(frame.code)) fail("invalid bridge error code"); return { kind, code: frame.code, message: text(frame.message, 4096, "bridge error") }; }
  fail("unsupported sidecar frame kind");
}

class BridgeEventStream {
  #events = []; #waiters = []; #done = false; #result; #resolveResult;
  constructor() { this.#result = new Promise((resolve) => { this.#resolveResult = resolve; }); }
  push(event) { if (this.#done) return; const waiter = this.#waiters.shift(); if (waiter) waiter({ value: event, done: false }); else { if (this.#events.length >= MAX_QUEUED_EVENTS) fail("worker event consumer is not draining the bounded bridge queue"); this.#events.push(event); } }
  end(result) { if (this.#done) return; this.#done = true; this.#resolveResult(result); for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true }); }
  result() { return this.#result; }
  [Symbol.asyncIterator]() { return { next: () => { const event = this.#events.shift(); if (event !== undefined) return Promise.resolve({ value: event, done: false }); if (this.#done) return Promise.resolve({ value: undefined, done: true }); return new Promise((resolve) => this.#waiters.push(resolve)); } }; }
}
function zeroUsage() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function assistant(model) { return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "error", timestamp: Date.now() }; }
function assignUsage(target, value) { target.usage = { input: value.inputTokens, output: value.outputTokens, cacheRead: value.cacheReadTokens, cacheWrite: value.cacheWriteTokens, totalTokens: value.totalTokens, ...(value.reasoningTokens === undefined ? {} : { reasoning: value.reasoningTokens }), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }

function bridgeStream(model, context, options = {}) {
  const stream = new BridgeEventStream(); const correlationId = randomUUID(); const partial = assistant(model); const socket = net.createConnection({ path: SOCKET_PATH });
  const decoder = new TextDecoder("utf-8", { fatal: true }); const content = new Map(); let buffer = ""; let phase = "invoked"; let complete = false; let cancelSent = false; let decodeFinished = false; let streamEvents = 0;
  const emit = (event) => { try { stream.push(event); } catch (error) { finishError("The Hitch native bridge event queue was not drained."); } };
  const finishError = (message, aborted = false) => { if (complete) return; complete = true; phase = "terminal"; partial.stopReason = aborted ? "aborted" : "error"; partial.errorMessage = message; try { stream.push({ type: "error", reason: partial.stopReason, error: partial }); } catch {} stream.end(partial); socket.destroy(); };
  const write = (value) => { try { socket.write(encodeFrame(value)); } catch { finishError("The Hitch native bridge could not encode a bounded frame."); } };
  const cancel = () => { if (cancelSent || socket.destroyed || complete) return; cancelSent = true; write(frame("cancel", correlationId)); };
  const expectStart = (kind, index) => { if (phase !== "started" || content.has(index)) fail("invalid stream content start"); content.set(index, { kind, open: true }); };
  const expectPart = (kind, index, end) => { const existing = content.get(index); if (phase !== "started" || !existing || !existing.open || existing.kind !== kind) fail("invalid stream content continuation"); if (end) existing.open = false; };
  const handle = (inbound) => {
    streamEvents += 1; if (streamEvents > MAX_STREAM_EVENTS) fail("sidecar stream exceeds the event bound");
    if (inbound.kind === "error") return finishError(inbound.message);
    if (inbound.kind === "cancelled") return finishError("The Hitch native bridge request was cancelled.", true);
    if (inbound.kind === "started") { if (phase !== "invoked") fail("duplicate bridge start"); phase = "started"; emit({ type: "start", partial }); return; }
    if (phase !== "started") fail("bridge stream frame before start or after terminal");
    if (inbound.kind === "text-start") { expectStart("text", inbound.contentIndex); partial.content[inbound.contentIndex] = { type: "text", text: "" }; emit({ type: "text_start", contentIndex: inbound.contentIndex, partial }); return; }
    if (inbound.kind === "text-delta") { expectPart("text", inbound.contentIndex, false); const combined = partial.content[inbound.contentIndex].text + inbound.delta; if (combined.length > MAX_TEXT) fail("text stream exceeds the cumulative bound"); partial.content[inbound.contentIndex].text = combined; emit({ type: "text_delta", contentIndex: inbound.contentIndex, delta: inbound.delta, partial }); return; }
    if (inbound.kind === "text-end") { expectPart("text", inbound.contentIndex, true); partial.content[inbound.contentIndex] = { type: "text", text: inbound.content }; emit({ type: "text_end", contentIndex: inbound.contentIndex, content: inbound.content, partial }); return; }
    if (inbound.kind === "reasoning-start") { expectStart("reasoning", inbound.contentIndex); partial.content[inbound.contentIndex] = { type: "thinking", thinking: "" }; emit({ type: "thinking_start", contentIndex: inbound.contentIndex, partial }); return; }
    if (inbound.kind === "reasoning-delta") { expectPart("reasoning", inbound.contentIndex, false); const combined = partial.content[inbound.contentIndex].thinking + inbound.delta; if (combined.length > MAX_TEXT) fail("reasoning stream exceeds the cumulative bound"); partial.content[inbound.contentIndex].thinking = combined; emit({ type: "thinking_delta", contentIndex: inbound.contentIndex, delta: inbound.delta, partial }); return; }
    if (inbound.kind === "reasoning-end") { expectPart("reasoning", inbound.contentIndex, true); partial.content[inbound.contentIndex] = { type: "thinking", thinking: inbound.content }; emit({ type: "thinking_end", contentIndex: inbound.contentIndex, content: inbound.content, partial }); return; }
    if (inbound.kind === "tool-start") { expectStart("tool", inbound.contentIndex); partial.content[inbound.contentIndex] = { type: "toolCall", id: "", name: "", arguments: {} }; emit({ type: "toolcall_start", contentIndex: inbound.contentIndex, partial }); return; }
    if (inbound.kind === "tool-delta") { expectPart("tool", inbound.contentIndex, false); emit({ type: "toolcall_delta", contentIndex: inbound.contentIndex, delta: inbound.delta, partial }); return; }
    if (inbound.kind === "tool-end") { expectPart("tool", inbound.contentIndex, true); partial.content[inbound.contentIndex] = inbound.toolCall; emit({ type: "toolcall_end", contentIndex: inbound.contentIndex, toolCall: inbound.toolCall, partial }); return; }
    if (inbound.kind === "usage") { assignUsage(partial, inbound.usage); return; }
    if (inbound.kind === "oauth-status") return;
    if (inbound.kind === "terminal") { if ([...content.values()].some((entry) => entry.open)) fail("terminal has open stream content"); complete = true; phase = "terminal"; assignUsage(partial, inbound.usage); partial.stopReason = inbound.reason; emit({ type: "done", reason: inbound.reason, message: partial }); stream.end(partial); socket.end(); return; }
    fail("unsupported decoded frame");
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  socket.once("connect", () => { try { const requestOptions = {}; if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 && options.maxTokens <= MANIFEST.provider.model.maximumOutputTokens) requestOptions.maximumOutputTokens = options.maxTokens; if (["none", "low", "medium", "high"].includes(options.reasoning)) requestOptions.reasoning = options.reasoning; write(frame("invoke", correlationId, { context: normalizeContext(context), options: requestOptions, nativeSeam: NATIVE_SEAM })); if (options.signal?.aborted) cancel(); } catch { finishError("The Pi native request did not satisfy the reviewed bridge contract."); } });
  socket.on("data", (chunk) => { if (complete) return; try { buffer += decoder.decode(chunk, { stream: true }); if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) fail("sidecar line exceeds byte bound"); while (true) { const end = buffer.indexOf("\\n"); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.length === 0 || line.includes("\\r")) fail("invalid sidecar JSONL line"); handle(sidecarFrame(parseStrictJson(line), correlationId)); } } catch { finishError("The Hitch native bridge returned an invalid bounded frame."); } });
  socket.once("end", () => { try { decoder.decode(); decodeFinished = true; if (!complete && buffer.length > 0) fail("unterminated sidecar JSONL line"); } catch { finishError("The Hitch native bridge returned invalid UTF-8."); } });
  socket.once("error", () => finishError("The Hitch native bridge connection failed."));
  socket.once("close", () => { if (!complete) finishError(decodeFinished ? "The Hitch native bridge closed before completion." : "The Hitch native bridge closed with incomplete UTF-8."); });
  return stream;
}

export default function registerHitchPiNativeBridge(pi) {
  // Exactly one static registration. No auth store, ambient provider discovery,
  // command/tool/prompt hooks, background work, source loader, or runtime config exists here.
  pi.registerProvider(MANIFEST.provider.id, {
    name: MANIFEST.provider.displayName,
    baseUrl: "http://hitch-native-sidecar.invalid",
    apiKey: "hitch-local-bridge-only",
    api: MANIFEST.provider.model.api,
    models: [{
      id: MANIFEST.provider.model.id,
      name: MANIFEST.provider.model.displayName,
      provider: MANIFEST.provider.id,
      reasoning: MANIFEST.provider.model.reasoning,
      input: [...MANIFEST.provider.model.input],
      contextWindow: MANIFEST.provider.model.contextWindowTokens,
      maxTokens: MANIFEST.provider.model.maximumOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple: bridgeStream,
  });
}
`;
}

export function generatePiNativeBridgeExtension(input: unknown): GeneratedPiNativeBridgeExtension {
  const semanticManifest = decodePiNativeExtensionSemanticManifest(input);
  const source = reviewedSource(semanticManifest);
  const generated: GeneratedPiNativeBridgeExtension = {
    fileName: "hitch-pi-native-bridge-0.82.0.mjs",
    semanticManifest,
    semanticManifestDigest: digestCanonicalJson(semanticManifest),
    source,
    artifactDigest: artifactDigest(source),
    sourceUtf8: () => new TextEncoder().encode(source),
  };
  return freeze(generated);
}

/** The bridge frame binding that the generated source embeds. */
export function piNativeBridgeBindingFromManifest(
  input: unknown,
): PiNativeBridgeBinding {
  const manifest = decodePiNativeExtensionSemanticManifest(input);
  return freeze({
    bridgeId: manifest.bridgeId,
    nativeStackDigest: manifest.compatibility.nativeStackDigest,
    nativeCatalogDigest: manifest.nativeCatalogDigest,
  });
}

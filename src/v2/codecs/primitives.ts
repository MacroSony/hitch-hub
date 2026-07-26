import { posix } from "node:path";

import type {
  AgentImageMimeType,
  Id,
  InferenceRequestFingerprint,
  IntegrityDigest,
  IsoTimestamp,
  SandboxPath,
  TrustedUpstreamOrigin,
} from "../model/primitives.js";
import { codecFail, type CodecPath } from "./errors.js";
import { at, decodeString } from "./structure.js";

export const SERVICE_ID_KINDS = [
  "Installation",
  "Principal",
  "IdentityBinding",
  "IdentityInvitation",
  "AuthenticationRequest",
  "ConnectorAccount",
  "LocalHost",
  "AccessGrant",
  "Session",
  "SessionSpec",
  "SessionEndpointBinding",
  "Endpoint",
  "Turn",
  "TurnPolicy",
  "TurnPolicySnapshot",
  "TurnInputSnapshot",
  "TurnEvent",
  "TurnMessage",
  "TurnInteraction",
  "TurnInteractionOption",
  "TurnInteractionResponse",
  "InferenceRequestReservation",
  "ToolInvocation",
  "Attachment",
  "PrivateBlob",
  "WorkerLease",
  "CredentialLease",
  "AgentResumeHandle",
  "AgentDispatchAttempt",
  "TurnTerminalResponse",
  "TurnResponseDelivery",
  "TurnResponseDeliveryAttempt",
  "AuditEnvelope",
  "InferenceForwardingAttempt",
  "AgentDriver",
  "AgentDriverLaunchProfile",
  "AgentDriverPermissionMediation",
  "AgentProfile",
  "AgentProfileRevision",
  "AgentResourceSnapshot",
  "Provider",
  "ProviderConnection",
  "Model",
  "ProviderCredentialBinding",
  "Workspace",
  "WorkspaceRevision",
  "WorkspaceResource",
  "ExecutionPolicy",
  "ExecutionPolicySnapshot",
  "ToolCapability",
  "Extension",
  "ExtensionRevision",
  "ExtensionGrantSnapshot",
  "ExtensionCapability",
] as const;

export type ServiceIdKind = (typeof SERVICE_ID_KINDS)[number];

const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;
const CANONICAL_TIMESTAMP =
  /^(?!0000)(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function decodeServiceId<Kind extends ServiceIdKind>(
  kind: Kind,
  input: unknown,
  path: CodecPath = [],
): Id<Kind> {
  const value = decodeString(input, path);
  if (!SAFE_ID.test(value) || value.includes("..")) {
    codecFail(
      path,
      "invalid-format",
      `${kind} ID must be a 1-128 character safe opaque identifier`,
    );
  }
  return value as Id<Kind>;
}

export interface BoundedStringOptions {
  readonly minimumLength?: number;
  readonly maximumLength: number;
  readonly pattern?: RegExp;
  readonly label?: string;
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function decodeOptionObject(
  input: unknown,
  allowedFields: readonly string[],
  path: CodecPath,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    codecFail(path, "invalid-type", "codec bounds must be an object");
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    codecFail(path, "non-plain-object", "codec bounds must be a plain object");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    codecFail(path, "non-json-value", "codec bounds cannot contain symbol fields");
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!allowedFields.includes(key)) {
      codecFail(at(path, key), "unknown-field", `unknown codec bound ${key}`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      codecFail(at(path, key), "non-json-value", "codec bounds cannot use accessors");
    }
  }
  return input as Record<string, unknown>;
}

function decodeBounds(
  options: BoundedStringOptions,
  path: CodecPath,
): {
  readonly minimumLength: number;
  readonly maximumLength: number;
  readonly pattern: RegExp | undefined;
  readonly label: string | undefined;
} {
  const object = decodeOptionObject(
    options,
    ["minimumLength", "maximumLength", "pattern", "label"],
    path,
  );
  if (!Object.hasOwn(object, "maximumLength")) {
    codecFail(at(path, "maximumLength"), "invalid-type", "missing maximum string length");
  }
  const minimumLength = decodeNonNegativeSafeInteger(
    object.minimumLength ?? 0,
    at(path, "minimumLength"),
  );
  const maximumLength = decodeNonNegativeSafeInteger(
    object.maximumLength,
    at(path, "maximumLength"),
  );
  if (minimumLength > maximumLength) {
    codecFail(path, "out-of-range", "minimum length cannot exceed maximum length");
  }
  if (object.pattern !== undefined && !(object.pattern instanceof RegExp)) {
    codecFail(at(path, "pattern"), "invalid-type", "string pattern must be a RegExp");
  }
  if (object.label !== undefined && typeof object.label !== "string") {
    codecFail(at(path, "label"), "invalid-type", "string bound label must be a string");
  }
  return {
    minimumLength,
    maximumLength,
    pattern: object.pattern as RegExp | undefined,
    label: object.label as string | undefined,
  };
}

export function decodeBoundedString(
  input: unknown,
  options: BoundedStringOptions,
  path: CodecPath = [],
): string {
  const value = decodeString(input, path);
  const { minimumLength, maximumLength, pattern, label } = decodeBounds(options, path);
  if (value.length < minimumLength) {
    codecFail(path, "out-of-range", `${label ?? "string"} is too short`);
  }
  if (value.length > maximumLength) {
    codecFail(path, "too-long", `${label ?? "string"} is too long`);
  }
  if (hasUnpairedSurrogate(value)) {
    codecFail(path, "invalid-format", `${label ?? "string"} contains an unpaired surrogate`);
  }
  if (pattern !== undefined) {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) {
      codecFail(path, "invalid-format", `${label ?? "string"} has invalid format`);
    }
  }
  return value;
}

export function decodeBoundedArray<Item>(
  input: unknown,
  decodeItem: (item: unknown, path: CodecPath) => Item,
  options: {
    readonly maximumItems: number;
    readonly minimumItems?: number;
    readonly uniqueBy?: (item: Item) => string;
  },
  path: CodecPath = [],
): readonly Item[] {
  const optionObject = decodeOptionObject(
    options,
    ["maximumItems", "minimumItems", "uniqueBy"],
    path,
  );
  if (!Object.hasOwn(optionObject, "maximumItems")) {
    codecFail(at(path, "maximumItems"), "invalid-type", "missing maximum array items");
  }
  const minimumItems = decodeNonNegativeSafeInteger(
    optionObject.minimumItems ?? 0,
    at(path, "minimumItems"),
  );
  const maximumItems = decodeNonNegativeSafeInteger(
    optionObject.maximumItems,
    at(path, "maximumItems"),
  );
  if (minimumItems > maximumItems) {
    codecFail(path, "out-of-range", "minimum items cannot exceed maximum items");
  }
  if (!Array.isArray(input)) {
    codecFail(path, "invalid-type", "expected an array");
  }
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    codecFail(path, "non-plain-object", "array subclasses and custom prototypes are forbidden");
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    codecFail(path, "non-json-value", "symbol properties are not JSON");
  }
  if (input.length > maximumItems) {
    codecFail(path, "too-many-items", "array item limit exceeded");
  }
  if (input.length < minimumItems) {
    codecFail(path, "out-of-range", "array has too few items");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") {
      if (!("value" in descriptor) || descriptor.value !== input.length) {
        codecFail(path, "non-json-value", "array length must be a data property");
      }
      continue;
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= input.length) {
      codecFail(at(path, key), "non-json-value", "extra array properties are forbidden");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      codecFail(at(path, key), "non-json-value", "array accessors are forbidden");
    }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      codecFail(at(path, index), "non-json-value", "sparse arrays are forbidden");
    }
  }
  const decoded = input.map((item, index) => decodeItem(item, at(path, index)));
  if (optionObject.uniqueBy !== undefined && typeof optionObject.uniqueBy !== "function") {
    codecFail(at(path, "uniqueBy"), "invalid-type", "array uniqueness selector must be a function");
  }
  const uniqueBy = optionObject.uniqueBy as ((item: Item) => string) | undefined;
  if (uniqueBy !== undefined) {
    const seen = new Set<string>();
    for (let index = 0; index < decoded.length; index += 1) {
      const key = uniqueBy(decoded[index]!);
      if (typeof key !== "string") {
        codecFail(at(path, index), "invalid-type", "array uniqueness key must be a string");
      }
      if (seen.has(key)) {
        codecFail(at(path, index), "duplicate-item", "array contains a duplicate item");
      }
      seen.add(key);
    }
  }
  return decoded;
}

/**
 * A sandbox path names a location in the already-authorized sandbox namespace.
 * It is deliberately POSIX absolute and normalized: it can never be a host
 * drive/UNC path or escape its sandbox root with `.` or `..` segments.
 */
export function decodeSandboxPath(
  input: unknown,
  path: CodecPath = [],
): SandboxPath {
  const value = decodeBoundedString(
    input,
    { minimumLength: 1, maximumLength: 4_096, label: "sandbox path" },
    path,
  );
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value === "/" ||
    (value.length > 1 && value.endsWith("/")) ||
    posix.normalize(value) !== value ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    codecFail(path, "invalid-format", "expected a normalized absolute sandbox path");
  }
  return value as SandboxPath;
}

const MIME_TYPE =
  /^[a-z0-9!#$%&'+.^_`|~-]+\/[a-z0-9!#$%&'+.^_`|~-]+$/u;

/** Canonical lower-case media type without parameters. */
export function decodeMimeType(
  input: unknown,
  path: CodecPath = [],
): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 3,
      maximumLength: 255,
      pattern: MIME_TYPE,
      label: "MIME type",
    },
    path,
  );
}

export function decodePositiveSafeInteger(
  input: unknown,
  path: CodecPath = [],
): number {
  if (typeof input !== "number") {
    codecFail(path, "invalid-type", "expected a number");
  }
  if (!Number.isFinite(input)) {
    codecFail(path, "non-finite-number", "number must be finite");
  }
  if (!Number.isSafeInteger(input) || input <= 0 || Object.is(input, -0)) {
    codecFail(path, "out-of-range", "expected a positive safe integer");
  }
  return input;
}

export function decodeNonNegativeSafeInteger(
  input: unknown,
  path: CodecPath = [],
): number {
  if (typeof input !== "number") {
    codecFail(path, "invalid-type", "expected a number");
  }
  if (!Number.isFinite(input)) {
    codecFail(path, "non-finite-number", "number must be finite");
  }
  if (!Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) {
    codecFail(path, "out-of-range", "expected a non-negative safe integer");
  }
  return input;
}

export function decodeIsoTimestamp(
  input: unknown,
  path: CodecPath = [],
): IsoTimestamp {
  const value = decodeString(input, path);
  if (
    !CANONICAL_TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    codecFail(
      path,
      "invalid-format",
      "expected canonical RFC3339 UTC with millisecond precision",
    );
  }
  return value as IsoTimestamp;
}

export function decodeIntegrityDigest(
  input: unknown,
  path: CodecPath = [],
): IntegrityDigest {
  const value = decodeString(input, path);
  if (!SHA256.test(value)) {
    codecFail(path, "invalid-format", "expected sha256:<64 lowercase hex digits>");
  }
  return value as IntegrityDigest;
}

export function decodeInferenceRequestFingerprint(
  input: unknown,
  path: CodecPath = [],
): InferenceRequestFingerprint {
  const value = decodeString(input, path);
  if (!SHA256.test(value)) {
    codecFail(
      path,
      "invalid-format",
      "expected an inference request fingerprint as sha256:<64 lowercase hex digits>",
    );
  }
  return value as InferenceRequestFingerprint;
}

export function decodeTrustedUpstreamOrigin(
  input: unknown,
  path: CodecPath = [],
): TrustedUpstreamOrigin {
  const value = decodeString(input, path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    codecFail(path, "invalid-format", "expected a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.hostname === "" ||
    parsed.origin !== value
  ) {
    codecFail(
      path,
      "invalid-format",
      "expected a canonical HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return value as TrustedUpstreamOrigin;
}

const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const satisfies readonly AgentImageMimeType[];

export function decodeAgentImageMimeType(
  input: unknown,
  path: CodecPath = [],
): AgentImageMimeType {
  if (
    typeof input !== "string" ||
    !IMAGE_MIME_TYPES.includes(input as AgentImageMimeType)
  ) {
    codecFail(path, "invalid-format", "unsupported image MIME type");
  }
  return input as AgentImageMimeType;
}

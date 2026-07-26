import { createHash } from "node:crypto";
import type {
  IntegrityDigest,
  InferenceRequestFingerprint,
  JsonObject,
  JsonValue,
} from "../model/primitives.js";
import { codecFail, type CodecPath } from "./errors.js";
import { at, decodePlainObject, requireExactFields } from "./structure.js";
import {
  decodeNonNegativeSafeInteger,
  decodePositiveSafeInteger,
  hasUnpairedSurrogate,
} from "./primitives.js";

export interface JsonBounds {
  readonly maximumDepth: number;
  readonly maximumNodes: number;
  readonly maximumStringLength: number;
  readonly maximumArrayItems: number;
  readonly maximumObjectFields: number;
}

export const DEFAULT_JSON_BOUNDS: JsonBounds = Object.freeze({
  maximumDepth: 32,
  maximumNodes: 10_000,
  maximumStringLength: 65_536,
  maximumArrayItems: 1_000,
  maximumObjectFields: 1_000,
});

/**
 * JSON limits are boundary safety limits, not installation policy.  They must
 * be concrete safe integers so an accidental `Infinity`, negative number, or
 * fractional value cannot quietly turn off a resource guard.
 */
function decodeJsonBounds(input: JsonBounds): JsonBounds {
  const object = decodePlainObject(input, ["bounds"]);
  const fields = [
    "maximumDepth",
    "maximumNodes",
    "maximumStringLength",
    "maximumArrayItems",
    "maximumObjectFields",
  ] as const;
  requireExactFields(object, fields, [], ["bounds"]);
  const maximumDepth = decodeNonNegativeSafeInteger(
    object.maximumDepth,
    ["bounds", "maximumDepth"],
  );
  const maximumNodes = decodePositiveSafeInteger(
    object.maximumNodes,
    ["bounds", "maximumNodes"],
  );
  const maximumStringLength = decodeNonNegativeSafeInteger(
    object.maximumStringLength,
    ["bounds", "maximumStringLength"],
  );
  const maximumArrayItems = decodeNonNegativeSafeInteger(
    object.maximumArrayItems,
    ["bounds", "maximumArrayItems"],
  );
  const maximumObjectFields = decodeNonNegativeSafeInteger(
    object.maximumObjectFields,
    ["bounds", "maximumObjectFields"],
  );
  const validated = {
    maximumDepth,
    maximumNodes,
    maximumStringLength,
    maximumArrayItems,
    maximumObjectFields,
  };
  for (const field of fields) {
    if (validated[field] > DEFAULT_JSON_BOUNDS[field]) {
      codecFail(
        at(["bounds"], field),
        "out-of-range",
        "custom JSON bounds may only narrow the structural safety ceiling",
      );
    }
  }
  return validated;
}

function assertCanonicalArrayShape(value: unknown[], path: CodecPath): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    codecFail(path, "non-plain-object", "array subclasses and custom prototypes are forbidden");
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    codecFail(path, "non-json-value", "symbol properties are not JSON");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length") {
      if (!("value" in descriptor) || descriptor.value !== value.length) {
        codecFail(path, "non-json-value", "array length must be a data property");
      }
      continue;
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      codecFail(at(path, key), "non-json-value", "extra array properties are forbidden");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      codecFail(at(path, key), "non-json-value", "array accessors are forbidden");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      codecFail(at(path, index), "non-json-value", "sparse arrays are forbidden");
    }
  }
}

export function decodeJsonValue(
  input: unknown,
  bounds: JsonBounds = DEFAULT_JSON_BOUNDS,
): JsonValue {
  const validatedBounds = decodeJsonBounds(bounds);
  let nodes = 0;

  function visit(value: unknown, path: CodecPath, depth: number): JsonValue {
    nodes += 1;
    if (nodes > validatedBounds.maximumNodes) {
      codecFail(path, "too-many-items", "JSON node limit exceeded");
    }
    if (depth > validatedBounds.maximumDepth) {
      codecFail(path, "out-of-range", "JSON nesting limit exceeded");
    }

    if (
      value === null ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "string") {
      if (value.length > validatedBounds.maximumStringLength) {
        codecFail(path, "too-long", "JSON string limit exceeded");
      }
      if (hasUnpairedSurrogate(value)) {
        codecFail(path, "invalid-format", "string contains an unpaired surrogate");
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        codecFail(path, "non-finite-number", "JSON numbers must be finite");
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
      if (value.length > validatedBounds.maximumArrayItems) {
        codecFail(path, "too-many-items", "JSON array limit exceeded");
      }
      assertCanonicalArrayShape(value, path);
      return value.map((item, index) => visit(item, at(path, index), depth + 1));
    }
    if (typeof value !== "object" || value === null) {
      codecFail(path, "non-json-value", "value is not representable as JSON");
    }

    const object = decodePlainObject(value, path);
    const keys = Object.keys(object);
    if (keys.length > validatedBounds.maximumObjectFields) {
      codecFail(path, "too-many-items", "JSON object field limit exceeded");
    }
    const decoded: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (key.length > validatedBounds.maximumStringLength) {
        codecFail(at(path, key), "too-long", "JSON field name limit exceeded");
      }
      if (hasUnpairedSurrogate(key)) {
        codecFail(at(path, key), "invalid-format", "field name has an unpaired surrogate");
      }
      decoded[key] = visit(object[key], at(path, key), depth + 1);
    }
    return decoded;
  }

  return visit(input, [], 0);
}

export function decodeJsonObject(
  input: unknown,
  bounds: JsonBounds = DEFAULT_JSON_BOUNDS,
): JsonObject {
  const value = decodeJsonValue(input, bounds);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    codecFail([], "invalid-type", "expected a JSON object");
  }
  return value as JsonObject;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const object = value as JsonObject;
  const keys = Object.keys(object).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key]!)}`)
    .join(",")}}`;
}

export function encodeCanonicalJson(input: unknown): string {
  return canonicalize(decodeJsonValue(input));
}

export function digestCanonicalJson(input: unknown): IntegrityDigest {
  const digest = createHash("sha256")
    .update(encodeCanonicalJson(input), "utf8")
    .digest("hex");
  return `sha256:${digest}` as IntegrityDigest;
}

/**
 * Domain-separated digest of a validated normalized inference request. The
 * caller still owns semantic request validation; this function supplies the
 * canonical, brand-correct identity used by reservations and forwarding.
 */
export function fingerprintCanonicalInferenceRequest(
  input: unknown,
): InferenceRequestFingerprint {
  const digest = createHash("sha256")
    .update("hitch:v2:inference-request\u0000", "utf8")
    .update(encodeCanonicalJson(input), "utf8")
    .digest("hex");
  return `sha256:${digest}` as InferenceRequestFingerprint;
}

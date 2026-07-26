import {
  codecFail,
  type CodecPath,
  type CodecPathSegment,
} from "./errors.js";

export const DANGEROUS_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function at(path: CodecPath, segment: CodecPathSegment): CodecPath {
  return [...path, segment];
}

export function decodePlainObject(
  input: unknown,
  path: CodecPath = [],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    codecFail(path, "invalid-type", "expected an object");
  }
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    codecFail(path, "non-plain-object", "object prototypes are not accepted");
  }

  const symbols = Object.getOwnPropertySymbols(input);
  if (symbols.length > 0) {
    codecFail(path, "non-json-value", "symbol properties are not JSON");
  }

  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (DANGEROUS_OBJECT_KEYS.has(key)) {
      codecFail(at(path, key), "dangerous-key", `field ${key} is forbidden`);
    }
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) {
      codecFail(
        at(path, key),
        "non-json-value",
        "accessor and non-enumerable properties are not JSON",
      );
    }
  }

  return input as Record<string, unknown>;
}

export function requireExactFields(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  path: CodecPath = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      codecFail(at(path, key), "unknown-field", `unknown field ${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      codecFail(at(path, key), "invalid-type", `missing required field ${key}`);
    }
  }
}

export function decodeString(
  input: unknown,
  path: CodecPath = [],
): string {
  if (typeof input !== "string") {
    codecFail(path, "invalid-type", "expected a string");
  }
  return input;
}

export function decodeBoolean(
  input: unknown,
  path: CodecPath = [],
): boolean {
  if (typeof input !== "boolean") {
    codecFail(path, "invalid-type", "expected a boolean");
  }
  return input;
}

export function decodeLiteral<const Value extends string>(
  input: unknown,
  value: Value,
  path: CodecPath = [],
): Value {
  if (input !== value) {
    codecFail(path, "invalid-format", `expected ${JSON.stringify(value)}`);
  }
  return value;
}

export function decodeEnum<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
  path: CodecPath = [],
): Values[number] {
  if (
    typeof input !== "string" ||
    !values.includes(input as Values[number])
  ) {
    codecFail(
      path,
      "invalid-format",
      `expected one of ${values.map((value) => JSON.stringify(value)).join(", ")}`,
    );
  }
  return input as Values[number];
}

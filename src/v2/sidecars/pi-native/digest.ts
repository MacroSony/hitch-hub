import { createHash, type Hash } from "node:crypto";

import type { IntegrityDigest } from "../../model/primitives.js";

/** Canonically hashes values already detached and validated by an A1/A3 codec. */
export function digestDecodedPiNativeValue(input: unknown): IntegrityDigest {
  const hash = createHash("sha256");
  updateCanonical(hash, input);
  return `sha256:${hash.digest("hex")}` as IntegrityDigest;
}

function updateCanonical(hash: Hash, value: unknown): void {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    hash.update(JSON.stringify(value), "utf8");
    return;
  }
  if (Array.isArray(value)) {
    hash.update("[", "utf8");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) hash.update(",", "utf8");
      updateCanonical(hash, value[index]);
    }
    hash.update("]", "utf8");
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new Error("decoded Pi native digest received a non-JSON value");
  }
  hash.update("{", "utf8");
  const object = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(object).sort();
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) hash.update(",", "utf8");
    const key = keys[index]!;
    hash.update(JSON.stringify(key), "utf8");
    hash.update(":", "utf8");
    updateCanonical(hash, object[key]);
  }
  hash.update("}", "utf8");
}

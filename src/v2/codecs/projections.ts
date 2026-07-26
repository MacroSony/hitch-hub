import type { JsonObject, JsonValue } from "../model/primitives.js";
import { codecFail, type CodecPath } from "./errors.js";
import { decodeJsonObject, decodeJsonValue } from "./json.js";
import {
  at,
  decodePlainObject,
  decodeString,
  requireExactFields,
} from "./structure.js";

export interface SecretFreeProjectionOptions {
  /**
   * `host-only` rejects explicit host filesystem fields while allowing
   * sandbox-relative model fields. `all` rejects any field named as a path.
   */
  readonly forbiddenPaths?: "none" | "host-only" | "all";
}

type ForbiddenPathPolicy = NonNullable<
  SecretFreeProjectionOptions["forbiddenPaths"]
>;

function decodeProjectionOptions(
  input: SecretFreeProjectionOptions,
  path: CodecPath,
): ForbiddenPathPolicy {
  const optionPath = at(path, "options");
  const object = decodePlainObject(input, optionPath);
  requireExactFields(object, [], ["forbiddenPaths"], optionPath);
  if (!Object.hasOwn(object, "forbiddenPaths")) return "host-only";
  const policy = decodeString(
    object.forbiddenPaths,
    at(optionPath, "forbiddenPaths"),
  );
  if (policy !== "none" && policy !== "host-only" && policy !== "all") {
    codecFail(
      at(optionPath, "forbiddenPaths"),
      "invalid-format",
      "unsupported path projection policy",
    );
  }
  return policy;
}

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "apitoken",
  "accesstoken",
  "authorization",
  "authheader",
  "authtoken",
  "bearer",
  "clientsecret",
  "cookie",
  "credential",
  "credentiallocator",
  "credentialstorelocator",
  "credentials",
  "idtoken",
  "identitytoken",
  "password",
  "passphrase",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "secretlocator",
  "secretstorelocator",
  "sessiontoken",
  "setcookie",
  "token",
  "vaultlocator",
  "vaultpath",
  "xapikey",
  "xauthtoken",
]);

const HOST_PATH_FIELD_NAMES = new Set([
  "canonicalhostpath",
  "absolutepath",
  "dataroot",
  "filesystempath",
  "homedirectory",
  "hostpath",
  "hostroot",
  "cwd",
  "realpath",
  "sourcepath",
  "sourcehostpath",
  "workingdirectory",
]);

function normalizeFieldName(field: string): string {
  return field.replaceAll(/[-_.\s]/gu, "").toLowerCase();
}

function looksLikeSecret(value: string): boolean {
  return (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u.test(value) ||
    webUrlContainsUserInfo(value) ||
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+\S+/iu.test(
      value,
    ) ||
    /^(?:bearer|basic)\s+\S+$/iu.test(value) ||
    /\bsk-[A-Za-z0-9_-]{16,}\b/u.test(value) ||
    /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u.test(
      value,
    ) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(
      value,
    )
  );
}

function webUrlContainsUserInfo(value: string): boolean {
  // Scan the authority independently from the more presentation-oriented URL
  // tokenization below. Punctuation such as `;`, `,`, and parentheses is valid
  // inside userinfo, so it must not terminate this credential check.
  return /\bhttps?:\/\/[^\s/?#]*@/iu.test(value);
}

function looksLikeAbsolutePath(value: string): boolean {
  // Web URLs are not filesystem paths. Remove them before treating `:` and
  // other punctuation as token boundaries for embedded host paths.
  const withoutWebUrls = value.replace(
    /\bhttps?:\/\/[^\s"'`()\[\]{}<>,;]+/giu,
    "",
  );
  return (
    /(?:^|[\s"'`()\[\]{}=;,:])\//u.test(withoutWebUrls) ||
    /(?:^|[\s"'`()\[\]{}=;,:])[A-Za-z]:[\\/]/u.test(withoutWebUrls) ||
    /(?:^|[\s"'`()\[\]{}=;,:])\\/u.test(withoutWebUrls) ||
    /(?:^|[\s"'`()\[\]{}=;,:])~[\\/]/u.test(withoutWebUrls) ||
    /(?:^|[\s"'`()\[\]{}=;,:])file:/iu.test(withoutWebUrls)
  );
}

function assertSecretFreeJsonValueWithPolicy(
  value: JsonValue,
  pathPolicy: ForbiddenPathPolicy,
  path: CodecPath,
  allowSandboxPathValue = false,
): void {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) {
      codecFail(path, "forbidden-secret", "secret-like value is forbidden");
    }
    if (
      pathPolicy !== "none" &&
      !allowSandboxPathValue &&
      looksLikeAbsolutePath(value)
    ) {
      codecFail(path, "forbidden-path", "absolute path value is forbidden");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSecretFreeJsonValueWithPolicy(item, pathPolicy, at(path, index)),
    );
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (SECRET_FIELD_NAMES.has(normalized)) {
      codecFail(at(path, key), "forbidden-secret", `secret field ${key} is forbidden`);
    }
    if (
      (pathPolicy === "host-only" && HOST_PATH_FIELD_NAMES.has(normalized)) ||
      (pathPolicy === "all" &&
        (HOST_PATH_FIELD_NAMES.has(normalized) ||
          normalized === "path" ||
          normalized.endsWith("path")))
    ) {
      codecFail(at(path, key), "forbidden-path", `path field ${key} is forbidden`);
    }
    assertSecretFreeJsonValueWithPolicy(
      item,
      pathPolicy,
      at(path, key),
      pathPolicy === "host-only" && normalized === "sandboxpath",
    );
  }
}

export function assertSecretFreeJsonValue(
  value: JsonValue,
  options: SecretFreeProjectionOptions = {},
  path: CodecPath = [],
): void {
  assertSecretFreeJsonValueWithPolicy(
    value,
    decodeProjectionOptions(options, path),
    path,
  );
}

export function decodeSecretFreeJsonValue(
  input: unknown,
  options: SecretFreeProjectionOptions = {},
  path: CodecPath = [],
): JsonValue {
  const decoded = decodeJsonValue(input);
  assertSecretFreeJsonValue(decoded, options, path);
  return decoded;
}

export function decodeSecretFreeJsonObject(
  input: unknown,
  options: SecretFreeProjectionOptions = {},
  path: CodecPath = [],
): JsonObject {
  const decoded = decodeJsonObject(input);
  assertSecretFreeJsonValue(decoded, options, path);
  return decoded;
}

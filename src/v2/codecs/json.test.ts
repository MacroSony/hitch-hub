import assert from "node:assert/strict";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import {
  CodecDecodeError,
  decodeJsonValue,
  decodeSecretFreeJsonObject,
  encodeCanonicalJson,
} from "./index.js";

function issue(
  operation: () => unknown,
  code: CodecDecodeError["issues"][number]["code"],
  path: readonly (string | number)[] = [],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CodecDecodeError);
    assert.equal(error.issues[0]?.code, code);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  });
}

test("JSON boundary rejects non-JSON values and object behavior", () => {
  issue(() => decodeJsonValue(undefined), "non-json-value");
  issue(() => decodeJsonValue(1n), "non-json-value");
  issue(() => decodeJsonValue(Symbol("x")), "non-json-value");
  issue(() => decodeJsonValue(() => undefined), "non-json-value");
  issue(() => decodeJsonValue(Number.NaN), "non-finite-number");
  issue(() => decodeJsonValue(Infinity), "non-finite-number");
  issue(() => decodeJsonValue(new Date()), "non-plain-object");
  issue(() => decodeJsonValue(Object.create(null)), "non-plain-object");

  const sparse = new Array(2);
  sparse[1] = "value";
  issue(() => decodeJsonValue(sparse), "non-json-value", [0]);

  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => "surprise",
  });
  issue(() => decodeJsonValue(accessor), "non-json-value", ["value"]);

  const symbolProperty = { value: true, [Symbol("hidden")]: "secret" };
  issue(() => decodeJsonValue(symbolProperty), "non-json-value");

  const nonEnumerableArrayProperty = ["safe"] as string[] & { hidden?: string };
  Object.defineProperty(nonEnumerableArrayProperty, "hidden", {
    enumerable: false,
    value: "not JSON",
  });
  issue(() => decodeJsonValue(nonEnumerableArrayProperty), "non-json-value", ["hidden"]);
});

test("JSON boundary rejects dangerous keys at every depth", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const input = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`) as unknown;
    issue(() => decodeJsonValue(input), "dangerous-key", ["safe", key]);
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("JSON boundary enforces resource bounds and valid Unicode", () => {
  issue(
    () =>
      decodeJsonValue(["one", "two"], {
        maximumDepth: 2,
        maximumNodes: 10,
        maximumStringLength: 10,
        maximumArrayItems: 1,
        maximumObjectFields: 2,
      }),
    "too-many-items",
  );
  issue(() => encodeCanonicalJson("\ud800"), "invalid-format");
  for (const bounds of [
    { ...{ maximumDepth: 1, maximumNodes: 1, maximumStringLength: 1, maximumArrayItems: 1, maximumObjectFields: 1 }, maximumNodes: Infinity },
    { maximumDepth: 1, maximumNodes: 1, maximumStringLength: -1, maximumArrayItems: 1, maximumObjectFields: 1 },
    { maximumDepth: 1.5, maximumNodes: 1, maximumStringLength: 1, maximumArrayItems: 1, maximumObjectFields: 1 },
  ]) {
    issue(() => decodeJsonValue(null, bounds), bounds.maximumNodes === Infinity ? "non-finite-number" : "out-of-range", ["bounds", bounds.maximumNodes === Infinity ? "maximumNodes" : bounds.maximumStringLength === -1 ? "maximumStringLength" : "maximumDepth"]);
  }
  issue(
    () =>
      decodeJsonValue(null, {
        ...{
          maximumDepth: 1,
          maximumNodes: 1,
          maximumStringLength: 1,
          maximumArrayItems: 1,
          maximumObjectFields: 1,
        },
        unexpected: 1,
      } as never),
    "unknown-field",
    ["bounds", "unexpected"],
  );
  issue(
    () =>
      decodeJsonValue(null, {
        ...{
          maximumDepth: 32,
          maximumNodes: 10_000,
          maximumStringLength: 65_536,
          maximumArrayItems: 1_000,
          maximumObjectFields: 1_000,
        },
        maximumDepth: 33,
      }),
    "out-of-range",
    ["bounds", "maximumDepth"],
  );

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => decodeJsonValue(cyclic), (error: unknown) => {
    assert.ok(error instanceof CodecDecodeError);
    assert.equal(error.issues[0]?.code, "out-of-range");
    assert.ok(error.issues[0]!.path.length > 0);
    return true;
  });
});

test("secret-free projection does not confuse identifiers or token limits with secrets", () => {
  assert.deepEqual(
    decodeSecretFreeJsonObject({
      providerTokenEstimatorId: "openai-compatible",
      maximumTotalTokens: 40_000,
      credentialBindingId: "binding:0001",
      sandboxPath: "/workspace/project",
    }),
    {
      providerTokenEstimatorId: "openai-compatible",
      maximumTotalTokens: 40_000,
      credentialBindingId: "binding:0001",
      sandboxPath: "/workspace/project",
    },
  );
});

scenarioCase({
  scenarioId: "V2-S09",
  caseId: "codec-adversarial-json-corpus",
  title: "untrusted projections reject prototypes, dangerous keys, and non-JSON values",
  run: () => {
    issue(
      () => decodeSecretFreeJsonObject({ nested: { authorization: "Bearer abc" } }),
      "forbidden-secret",
      ["nested", "authorization"],
    );
    issue(
      () => decodeSecretFreeJsonObject({ nested: { value: Number.NaN } }),
      "non-finite-number",
      ["nested", "value"],
    );
    issue(
      () => decodeSecretFreeJsonObject({ nested: Object.create(null) }),
      "non-plain-object",
      ["nested"],
    );
  },
});

scenarioCase({
  scenarioId: "V2-S14",
  caseId: "codec-secret-and-host-path-projection",
  title: "operational projections reject credentials, tokens, cookies, and host paths",
  run: () => {
    const forbidden = [
      { apiKey: "value" },
      { nested: { refresh_token: "value" } },
      { headers: { cookie: "session=value" } },
      { message: "Authorization: Bearer abcdefghijklmnop" },
      { canonicalHostPath: "/home/user/.config/pi/auth.json" },
      { source_host_path: "/etc/shadow" },
      { credentialStoreLocator: "keychain://pi" },
      { vault_path: "/private/vault" },
      { apiToken: "abc" },
    ];
    for (const projection of forbidden) {
      assert.throws(
        () => decodeSecretFreeJsonObject(projection),
        CodecDecodeError,
      );
    }
    issue(
      () =>
        decodeSecretFreeJsonObject(
          { sandboxPath: "/workspace/project" },
          { forbiddenPaths: "all" },
        ),
      "forbidden-path",
      ["sandboxPath"],
    );
    for (const value of [
      "/etc/shadow",
      "C:\\Users\\test",
      "\\\\server\\share",
      "file:///etc/shadow",
      "cwd:/home/user/project",
      "cwd:C:\\Users\\user",
      "see;/etc/shadow",
      "//server/share",
      "\\Windows\\System32",
      "uri:file:///etc/shadow",
      "Bearer abc",
      "Basic abc",
      "https://user:pass@example.com/docs",
      "See https://user:pass@example.com/docs",
      "https://user:pa;ss@example.com/docs",
      "https://user:pa,ss@example.com/docs",
      "https://user:pa(ss@example.com/docs",
    ]) {
      issue(
        () => decodeSecretFreeJsonObject({ harmless: value }, { forbiddenPaths: "all" }),
        value.startsWith("Bearer") ||
          value.startsWith("Basic") ||
          value.includes("user:pass@") ||
          value.includes("user:pa")
          ? "forbidden-secret"
          : "forbidden-path",
        ["harmless"],
      );
    }
    assert.deepEqual(
      decodeSecretFreeJsonObject(
        { documentation: "See https://platform.openai.com/docs/api-reference" },
        { forbiddenPaths: "all" },
      ),
      { documentation: "See https://platform.openai.com/docs/api-reference" },
    );
    issue(
      () =>
        decodeSecretFreeJsonObject(
          { safe: true },
          { forbiddenPaths: "future-policy" } as never,
        ),
      "invalid-format",
      ["options", "forbiddenPaths"],
    );
  },
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import {
  CodecDecodeError,
  decodeAgentImageMimeType,
  decodeBoundedArray,
  decodeBoundedString,
  decodeIntegrityDigest,
  decodeInferenceRequestFingerprint,
  decodeIsoTimestamp,
  decodeMimeType,
  decodePositiveSafeInteger,
  decodeSandboxPath,
  decodeServiceId,
  decodeTrustedUpstreamOrigin,
  digestCanonicalJson,
  encodeCanonicalJson,
  fingerprintCanonicalInferenceRequest,
} from "./index.js";

function assertCodecError(
  operation: () => unknown,
  code: CodecDecodeError["issues"][number]["code"],
  path = "$",
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CodecDecodeError);
    assert.equal(error.issues[0]?.code, code);
    assert.ok(error.message.includes(`at ${path}:`), error.message);
    return true;
  });
}

test("service IDs are safe bounded opaque identifiers", () => {
  assert.equal(decodeServiceId("Turn", "fixture:Turn:0001"), "fixture:Turn:0001");
  assert.equal(
    decodeServiceId("Turn", "01955cb1-3ec7-7000-a413-1511bc7d3310"),
    "01955cb1-3ec7-7000-a413-1511bc7d3310",
  );

  for (const invalid of ["", " two", "two ", "../two", "a/b", "a".repeat(129)]) {
    assertCodecError(() => decodeServiceId("Turn", invalid), "invalid-format");
  }
});

test("timestamps accept only canonical RFC3339 UTC values", () => {
  assert.equal(
    decodeIsoTimestamp("2026-07-25T14:01:02.003Z"),
    "2026-07-25T14:01:02.003Z",
  );
  for (const invalid of [
    "2026-07-25T14:01:02Z",
    "2026-07-25T10:01:02.003-04:00",
    "2026-02-30T14:01:02.003Z",
    "2026-07-25 14:01:02.003Z",
  ]) {
    assertCodecError(() => decodeIsoTimestamp(invalid), "invalid-format");
  }
});

test("canonical JSON is stable, normalized, and hashed with labelled SHA-256", () => {
  assert.equal(
    encodeCanonicalJson({ z: [3, -0], a: { y: true, x: null } }),
    '{"a":{"x":null,"y":true},"z":[3,0]}',
  );
  assert.equal(
    encodeCanonicalJson({ b: 2, a: 1 }),
    encodeCanonicalJson({ a: 1, b: 2 }),
  );
  assert.equal(
    digestCanonicalJson({ b: 2, a: 1 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
});

test("bounded primitives reject unsafe limits without normalization", () => {
  assert.equal(
    decodeBoundedString(" exact ", { minimumLength: 1, maximumLength: 7 }),
    " exact ",
  );
  assert.deepEqual(
    decodeBoundedArray(
      ["one", "two"],
      (value, path) =>
        decodeBoundedString(value, { maximumLength: 3 }, path),
      { maximumItems: 2, uniqueBy: (value) => value },
    ),
    ["one", "two"],
  );
  assertCodecError(
    () =>
      decodeBoundedArray(
        ["same", "same"],
        (value, path) =>
          decodeBoundedString(value, { maximumLength: 8 }, path),
        { maximumItems: 2, uniqueBy: (value) => value },
      ),
    "duplicate-item",
    "$[1]",
  );
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertCodecError(() => decodePositiveSafeInteger(invalid), "out-of-range");
  }
  assertCodecError(
    () => decodePositiveSafeInteger(Infinity),
    "non-finite-number",
  );
  assertCodecError(
    () => decodeBoundedString("x", { minimumLength: 2, maximumLength: 1 }),
    "out-of-range",
  );
  assertCodecError(
    () => decodeBoundedArray([], () => "x", { minimumItems: 2, maximumItems: 1 }),
    "out-of-range",
  );
  const accessorBounds = { maximumLength: 1 } as { readonly maximumLength: number };
  Object.defineProperty(accessorBounds, "minimumLength", {
    enumerable: true,
    get: () => 0,
  });
  assertCodecError(
    () => decodeBoundedString("x", accessorBounds),
    "non-json-value",
    "$.minimumLength",
  );
  assertCodecError(
    () => decodeBoundedArray([], () => "x", { maximumItems: Number.POSITIVE_INFINITY }),
    "non-finite-number",
    "$.maximumItems",
  );

  const nonEnumerableArrayProperty = ["safe"] as string[] & { hidden?: string };
  Object.defineProperty(nonEnumerableArrayProperty, "hidden", {
    enumerable: false,
    value: "not JSON",
  });
  assertCodecError(
    () => decodeBoundedArray(nonEnumerableArrayProperty, (value) => String(value), { maximumItems: 1 }),
    "non-json-value",
    "$.hidden",
  );
  assert.equal(decodeSandboxPath("/workspace/project"), "/workspace/project");
  for (const invalid of [
    "/",
    "workspace/project",
    "/workspace//project",
    "/workspace/",
    "/workspace/../secret",
    "C:\\workspace",
    "//host/path",
  ]) {
    assertCodecError(() => decodeSandboxPath(invalid), "invalid-format");
  }
  assert.equal(decodeMimeType("application/vnd.api+json"), "application/vnd.api+json");
  for (const invalid of [
    "*/*",
    "text/*",
    "text/pl*ain",
    "IMAGE/PNG",
    "image/png; charset=utf-8",
    "image",
    "\ud800/plain",
  ]) {
    assertCodecError(() => decodeMimeType(invalid), "invalid-format");
  }
});

scenarioCase({
  scenarioId: "V2-S12",
  caseId: "primitive-image-mime-and-digest",
  title: "image MIME and integrity digest primitives are exact",
  run: () => {
    for (const mediaType of [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ]) {
      assert.equal(decodeAgentImageMimeType(mediaType), mediaType);
    }
    for (const invalid of ["image/jpg", "IMAGE/PNG", "image/svg+xml", "image/png;v=1"]) {
      assertCodecError(() => decodeAgentImageMimeType(invalid), "invalid-format");
    }
    const digest = `sha256:${"ab".repeat(32)}`;
    assert.equal(decodeIntegrityDigest(digest), digest);
    for (const invalid of ["ab".repeat(32), `sha256:${"AB".repeat(32)}`, "sha512:00"]) {
      assertCodecError(() => decodeIntegrityDigest(invalid), "invalid-format");
      assertCodecError(
        () => decodeInferenceRequestFingerprint(invalid),
        "invalid-format",
      );
    }
    const fingerprint = fingerprintCanonicalInferenceRequest({
      model: "gpt-5",
      messages: [],
    });
    assert.equal(decodeInferenceRequestFingerprint(fingerprint), fingerprint);
    assert.notEqual(fingerprint, digestCanonicalJson({ model: "gpt-5", messages: [] }));
  },
});

scenarioCase({
  scenarioId: "V2-S15",
  caseId: "primitive-budget-and-origin-validation",
  title: "budget limits and registered upstream origins use strict primitives",
  run: () => {
    assert.equal(decodePositiveSafeInteger(1), 1);
    assert.equal(
      decodeTrustedUpstreamOrigin("https://api.openai.com"),
      "https://api.openai.com",
    );
    for (const invalid of [
      "http://api.openai.com",
      "https://user:pass@api.openai.com",
      "https://api.openai.com/",
      "https://api.openai.com/v1",
      "https://API.OPENAI.COM",
      "https://api.openai.com:443",
      "https://api.openai.com?x=1",
    ]) {
      assertCodecError(() => decodeTrustedUpstreamOrigin(invalid), "invalid-format");
    }
  },
});

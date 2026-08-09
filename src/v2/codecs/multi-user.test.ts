import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodecDecodeError,
  decodeMvpAuthenticationSource,
  decodeMvpAuthenticationSubject,
  decodeMvpEndpointAddress,
  decodeMvpEndpointAudience,
  decodeMvpInstallationRole,
  decodeMvpPrincipalKind,
} from "./index.js";

function assertCodecError(
  operation: () => unknown,
  code: CodecDecodeError["issues"][number]["code"],
  path: string,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CodecDecodeError);
    assert.equal(error.issues[0]?.code, code);
    assert.ok(error.message.includes(`at ${path}:`), error.message);
    return true;
  });
}

test("MVP authentication codecs bind exact certificate evidence", () => {
  const source = decodeMvpAuthenticationSource({
    kind: "mtls-client",
    trustRootId: "private-alpha-client-ca-v1",
  });
  assert.deepEqual(source, {
    kind: "mtls-client",
    trustRootId: "private-alpha-client-ca-v1",
  });
  assert.equal(
    decodeMvpAuthenticationSubject(source, `sha256:${"ab".repeat(32)}`),
    `sha256:${"ab".repeat(32)}`,
  );

  assertCodecError(
    () =>
      decodeMvpAuthenticationSubject(
        source,
        `sha256:${"AB".repeat(32)}`,
      ),
    "invalid-format",
    "$",
  );
  assertCodecError(
    () =>
      decodeMvpAuthenticationSource({
        kind: "mtls-client",
        trustRootId: "client-ca",
        principalId: "caller-selected",
      }),
    "unknown-field",
    "$.principalId",
  );
  assertCodecError(
    () =>
      decodeMvpAuthenticationSource({
        kind: "connector",
        connectorAccountId: "future",
      }),
    "unsupported-discriminant",
    "$.kind",
  );
  for (const forgedSource of [
    { kind: "connector", connectorAccountId: "future" },
    { kind: "bogus" },
  ]) {
    assertCodecError(
      () =>
        decodeMvpAuthenticationSubject(
          forgedSource as never,
          "forged-subject",
        ),
      "unsupported-discriminant",
      "$.kind",
    );
  }
});

test("MVP endpoint codecs allow only private local or certificate-bound clients", () => {
  assert.deepEqual(
    decodeMvpEndpointAddress({
      kind: "remote-client",
      identityBindingId: "identity-binding-1",
    }),
    {
      kind: "remote-client",
      identityBindingId: "identity-binding-1",
    },
  );
  assert.deepEqual(
    decodeMvpEndpointAudience({ kind: "private", principalId: "principal-1" }),
    { kind: "private", principalId: "principal-1" },
  );
  assertCodecError(
    () => decodeMvpEndpointAudience({ kind: "shared" }),
    "unsupported-discriminant",
    "$.kind",
  );
  assertCodecError(
    () =>
      decodeMvpEndpointAddress({
        kind: "connector",
        connectorAccountId: "future",
        externalEndpointId: "future",
      }),
    "unsupported-discriminant",
    "$.kind",
  );
});

test("MVP executable identity surface rejects service principals and broad roles", () => {
  assert.equal(decodeMvpPrincipalKind("human"), "human");
  assert.equal(decodeMvpInstallationRole("admin"), "admin");
  assert.equal(decodeMvpInstallationRole("member"), "member");
  assertCodecError(
    () => decodeMvpPrincipalKind("service"),
    "unsupported-discriminant",
    "$",
  );
  assertCodecError(
    () => decodeMvpInstallationRole("owner"),
    "invalid-format",
    "$",
  );
});

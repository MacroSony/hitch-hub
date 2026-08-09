import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";

import {
  decodeIsoTimestamp,
  fingerprintClientCertificateDer,
} from "../../codecs/primitives.js";
import type { Clock } from "../../model/application.js";
import {
  ClientCertificatePolicyError,
  ClientCertificateTrustError,
  MAXIMUM_CLIENT_CERTIFICATE_DER_BYTES,
  createClientCertificateTrust,
  inspectMvpClientCertificate,
} from "./certificate-verification.js";
import {
  TEST_CA_CERTIFICATE_PEM,
  TEST_CLIENT_CERTIFICATE_PEM,
  TEST_NO_EKU_CLIENT_CERTIFICATE_PEM,
  TEST_SERVER_CERTIFICATE_PEM,
  TEST_WEAK_CLIENT_CERTIFICATE_PEM,
} from "./test-certificates.js";

const CURRENT_CLOCK: Clock = Object.freeze({
  now: () => decodeIsoTimestamp("2026-08-09T12:00:00.000Z"),
});

function der(pem: string): Buffer {
  return new X509Certificate(pem).raw;
}

test("verified client certificate evidence binds exact trust root and complete DER fingerprint once", () => {
  const certificateDer = der(TEST_CLIENT_CERTIFICATE_PEM);
  const trust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CURRENT_CLOCK,
  });
  const result = trust.verifier.verify({
    authorized: true,
    protocol: "TLSv1.3",
    completeDer: certificateDer,
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  assert.deepEqual(trust.evidenceConsumer.consume(result.evidence), {
    trustRootId: "private-alpha-client-ca-v1",
    fingerprint: fingerprintClientCertificateDer(certificateDer),
  });
  assert.throws(
    () => trust.evidenceConsumer.consume(result.evidence),
    ClientCertificateTrustError,
  );
  assert.throws(
    () => trust.evidenceConsumer.consume({} as never),
    ClientCertificateTrustError,
  );
});

test("live verifier rejects untrusted TLS and wrong protocol before leaf policy", () => {
  const trust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CURRENT_CLOCK,
  });
  assert.deepEqual(
    trust.verifier.verify({
      authorized: false,
      authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      protocol: "TLSv1.3",
      completeDer: new Uint8Array(),
    }),
    { status: "rejected", reason: "tls-peer-unauthorized" },
  );
  assert.deepEqual(
    trust.verifier.verify({
      authorized: true,
      protocol: "TLSv1.2",
      completeDer: der(TEST_CLIENT_CERTIFICATE_PEM),
    }),
    { status: "rejected", reason: "tls-version-unsupported" },
  );
});

test("leaf policy rejects invalid DER, time, CA, purpose, and weak public keys", () => {
  const cases = [
    {
      input: new Uint8Array(),
      clock: CURRENT_CLOCK,
      reason: "certificate-der-invalid",
    },
    {
      input: new Uint8Array(MAXIMUM_CLIENT_CERTIFICATE_DER_BYTES + 1),
      clock: CURRENT_CLOCK,
      reason: "certificate-der-invalid",
    },
    {
      input: Buffer.concat([der(TEST_CLIENT_CERTIFICATE_PEM), Buffer.from([0])]),
      clock: CURRENT_CLOCK,
      reason: "certificate-der-invalid",
    },
    {
      input: der(TEST_CLIENT_CERTIFICATE_PEM),
      clock: {
        now: () => decodeIsoTimestamp("2040-01-01T00:00:00.000Z"),
      } satisfies Clock,
      reason: "certificate-not-currently-valid",
    },
    {
      input: der(TEST_CA_CERTIFICATE_PEM),
      clock: CURRENT_CLOCK,
      reason: "certificate-is-ca",
    },
    {
      input: der(TEST_SERVER_CERTIFICATE_PEM),
      clock: CURRENT_CLOCK,
      reason: "client-auth-purpose-missing",
    },
    {
      input: der(TEST_NO_EKU_CLIENT_CERTIFICATE_PEM),
      clock: CURRENT_CLOCK,
      reason: "client-auth-purpose-missing",
    },
    {
      input: der(TEST_WEAK_CLIENT_CERTIFICATE_PEM),
      clock: CURRENT_CLOCK,
      reason: "public-key-policy-denied",
    },
  ] as const;

  for (const candidate of cases) {
    assert.throws(
      () =>
        inspectMvpClientCertificate({
          completeDer: candidate.input,
          clock: candidate.clock,
        }),
      (error: unknown) =>
        error instanceof ClientCertificatePolicyError &&
        error.reason === candidate.reason,
    );
  }
});

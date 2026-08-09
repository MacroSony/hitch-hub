import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import test from "node:test";

import { mvpScenarioCase } from "../acceptance/runner.js";
import {
  createClientCertificateTrust,
  ClientCertificateTrustError,
} from "../connectors/remote/certificate-verification.js";
import { TEST_CLIENT_CERTIFICATE_PEM } from "../connectors/remote/test-certificates.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import type { V2Database } from "../persistence/database.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  createRemoteConnectorAuthentication,
  RemoteAuthenticationStateError,
} from "./remote-authentication.js";

const CLOCK = new DeterministicClock("2026-08-09T12:00:00.000Z");
const TRUST_ROOT = "private-alpha-client-ca-v1";
const CERTIFICATE_DER = new X509Certificate(TEST_CLIENT_CERTIFICATE_PEM).raw;

async function publish(database: V2Database): Promise<void> {
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(createBootstrapPublicationRecords());
}

function enroll(
  database: V2Database,
  fingerprint: string,
  options: { readonly endpoint?: boolean } = {},
): void {
  database.transaction((transaction) => {
    transaction.run(
      `INSERT INTO principals (
        id, installation_id, kind, display_name, state, created_at
      ) VALUES (?, ?, 'human', ?, 'active', ?)`,
      ["remote-principal-v1", "installation-v1", "Remote User", CLOCK.now()],
    );
    transaction.run(
      `INSERT INTO identity_bindings (
        id, installation_id, principal_id, source_kind,
        client_trust_root_id, subject_id, state, created_at
      ) VALUES (?, ?, ?, 'mtls-client', ?, ?, 'active', ?)`,
      [
        "remote-binding-v1",
        "installation-v1",
        "remote-principal-v1",
        TRUST_ROOT,
        fingerprint,
        CLOCK.now(),
      ],
    );
    if (options.endpoint !== false) {
      transaction.run(
        `INSERT INTO endpoints (
          id, installation_id, address_kind, identity_binding_id,
          identity_binding_source_kind, audience_kind,
          audience_principal_id, created_at
        ) VALUES (?, ?, 'remote-client', ?, 'mtls-client', 'private', ?, ?)`,
        [
          "remote-endpoint-v1",
          "installation-v1",
          "remote-binding-v1",
          "remote-principal-v1",
          CLOCK.now(),
        ],
      );
    }
  });
}

function createTrust(database: V2Database, idPrefix: string) {
  const certificate = createClientCertificateTrust({
    trustRootId: TRUST_ROOT,
    clock: CLOCK,
  });
  const remote = createRemoteConnectorAuthentication({
    database,
    clock: CLOCK,
    ids: new DeterministicIdSource(idPrefix),
    evidenceConsumer: certificate.evidenceConsumer,
  });
  return { certificate, remote };
}

function verifiedEvidence(
  certificate: ReturnType<typeof createClientCertificateTrust>,
) {
  const result = certificate.verifier.verify({
    authorized: true,
    protocol: "TLSv1.3",
    completeDer: CERTIFICATE_DER,
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("test certificate rejected");
  return result.evidence;
}

async function exactMtlsBindingResolution(): Promise<void> {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      const trust = createTrust(database, "remote-auth");
      const evidence = verifiedEvidence(trust.certificate);
      const material = createClientCertificateTrust({
        trustRootId: TRUST_ROOT,
        clock: CLOCK,
      });
      const independentEvidence = verifiedEvidence(material);
      const independentMaterial = material.evidenceConsumer.consume(
        independentEvidence,
      );
      enroll(database, independentMaterial.fingerprint);

      const result = await trust.remote.authentication.authenticate(evidence);
      assert.equal(result.status, "authenticated");
      if (result.status !== "authenticated") return;
      assert.deepEqual(result.context, {
        actor: {
          kind: "authenticated-principal",
          principalId: "remote-principal-v1",
          identityBindingId: "remote-binding-v1",
          method: "mtls-client",
          assurance: "normal",
          requestId: "remote-auth:AuthenticationRequest:0001",
          authenticatedAt: "2026-08-09T12:00:00.000Z",
        },
        endpointId: "remote-endpoint-v1",
      });
      assert.equal(
        trust.remote.contextVerifier.isAuthentic(result.context),
        true,
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT evidence_kind, socket_security, client_trust_root_id,
              client_certificate_fingerprint, binding_source_kind,
              outcome_status, principal_id, identity_binding_id, assurance,
              rejection_reason
            FROM authentication_requests`,
          ),
        ),
        {
          evidence_kind: "mtls-client-certificate",
          socket_security: null,
          client_trust_root_id: TRUST_ROOT,
          client_certificate_fingerprint: independentMaterial.fingerprint,
          binding_source_kind: "mtls-client",
          outcome_status: "authenticated",
          principal_id: "remote-principal-v1",
          identity_binding_id: "remote-binding-v1",
          assurance: "normal",
          rejection_reason: null,
        },
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT actor_kind, system_component, outcome, action
            FROM audit_envelopes
            WHERE action = 'authentication-recorded'`,
          ),
        ),
        {
          actor_kind: "system",
          system_component: "remote-ingress",
          outcome: "succeeded",
          action: "authentication-recorded",
        },
      );
      await assert.rejects(
        trust.remote.authentication.authenticate(evidence),
        ClientCertificateTrustError,
      );
    } finally {
      database.close();
    }
  });
}

mvpScenarioCase({
  scenarioId: "V2-MVP-S01",
  caseId: "exact-mtls-binding-resolution",
  title: "exact mTLS evidence resolves one immutable same-owner endpoint",
  run: exactMtlsBindingResolution,
});

test("remote authentication records unknown, revoked, and disabled denials from live state", async () => {
  const cases = [
    {
      reason: "unknown-binding",
      mutate(_database: V2Database, _fingerprint: string): void {},
    },
    {
      reason: "binding-revoked",
      mutate(database: V2Database, fingerprint: string): void {
        enroll(database, fingerprint);
        database.transaction((transaction) =>
          transaction.run(
            `UPDATE identity_bindings SET state = 'revoked', revoked_at = ?,
              revoked_actor_kind = 'system',
              revoked_actor_system_component = 'authorization'
            WHERE id = 'remote-binding-v1'`,
            [CLOCK.now()],
          ),
        );
      },
    },
    {
      reason: "principal-disabled",
      mutate(database: V2Database, fingerprint: string): void {
        enroll(database, fingerprint);
        database.transaction((transaction) =>
          transaction.run(
            `UPDATE principals SET state = 'disabled', disabled_at = ?,
              disabled_actor_kind = 'system',
              disabled_actor_system_component = 'authorization'
            WHERE id = 'remote-principal-v1'`,
            [CLOCK.now()],
          ),
        );
      },
    },
  ] as const;

  for (const scenario of cases) {
    await withDisposableDataRoot(async (root) => {
      const database = openCanonicalHitchV2Database({
        dataRoot: root.resolve(scenario.reason),
      });
      try {
        await publish(database);
        const trust = createTrust(database, scenario.reason);
        const evidence = verifiedEvidence(trust.certificate);
        const fingerprint = createClientCertificateTrust({
          trustRootId: TRUST_ROOT,
          clock: CLOCK,
        });
        const fingerprintEvidence = verifiedEvidence(fingerprint);
        const material = fingerprint.evidenceConsumer.consume(fingerprintEvidence);
        scenario.mutate(database, material.fingerprint);
        const result = await trust.remote.authentication.authenticate(evidence);
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") {
          assert.equal(result.reason, scenario.reason);
        }
        assert.deepEqual(
          database.transaction((transaction) =>
            transaction.get(
              `SELECT outcome_status, rejection_reason, principal_id,
                identity_binding_id, client_trust_root_id,
                client_certificate_fingerprint
              FROM authentication_requests`,
            ),
          ),
          {
            outcome_status: "rejected",
            rejection_reason: scenario.reason,
            principal_id: null,
            identity_binding_id: null,
            client_trust_root_id: TRUST_ROOT,
            client_certificate_fingerprint: material.fingerprint,
          },
        );
      } finally {
        database.close();
      }
    });
  }
});

test("remote authentication rolls back rather than minting a context for a missing endpoint", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      const trust = createTrust(database, "missing-endpoint");
      const evidence = verifiedEvidence(trust.certificate);
      const fingerprintTrust = createClientCertificateTrust({
        trustRootId: TRUST_ROOT,
        clock: CLOCK,
      });
      const fingerprint = fingerprintTrust.evidenceConsumer.consume(
        verifiedEvidence(fingerprintTrust),
      ).fingerprint;
      enroll(database, fingerprint, { endpoint: false });
      await assert.rejects(
        trust.remote.authentication.authenticate(evidence),
        RemoteAuthenticationStateError,
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get("SELECT COUNT(*) AS count FROM authentication_requests")
            ?.count,
        ),
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("remote authentication rejects a relational graph whose installation provenance is missing", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      const trust = createTrust(database, "missing-provenance");
      const evidence = verifiedEvidence(trust.certificate);
      const fingerprintTrust = createClientCertificateTrust({
        trustRootId: TRUST_ROOT,
        clock: CLOCK,
      });
      const fingerprint = fingerprintTrust.evidenceConsumer.consume(
        verifiedEvidence(fingerprintTrust),
      ).fingerprint;
      enroll(database, fingerprint);
      database.transaction((transaction) =>
        transaction.run(
          `DELETE FROM bootstrap_publication_rows
          WHERE table_name = 'installations'`,
        ),
      );
      await assert.rejects(
        trust.remote.authentication.authenticate(evidence),
        RemoteAuthenticationStateError,
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get("SELECT COUNT(*) AS count FROM authentication_requests")
            ?.count,
        ),
        0,
      );
    } finally {
      database.close();
    }
  });
});

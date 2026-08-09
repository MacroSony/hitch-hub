import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { test } from "node:test";

import { fingerprintClientCertificateDer } from "../codecs/primitives.js";
import { TEST_CLIENT_CERTIFICATE_PEM } from "../connectors/remote/test-certificates.js";
import type {
  BackgroundServiceAuthorizationComponent,
  TrustedServiceAuthorizationContext,
} from "../model/application.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { SQLiteFoundationalAuthorizationReads } from "../persistence/foundational-authorization.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  createFirstSliceAuthorizationTrust,
  createMultiUserAuthorizationTrust,
  ServiceAuthorizationTrustError,
} from "./authorization-contexts.js";

const COMPONENTS = [
  "turn-coordinator",
  "supervisor",
  "broker",
  "delivery",
  "recovery",
] as const satisfies readonly BackgroundServiceAuthorizationComponent[];

test("service authority issuer mints only frozen first-slice background contexts", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const trust = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock(),
        ids: new DeterministicIdSource("authority"),
      });
      for (const component of COMPONENTS) {
        const context =
          await trust.serviceContextIssuer.forComponent(component);
        assert.ok(Object.isFrozen(context));
        assert.ok(Object.isFrozen(context.actor));
        assert.deepEqual(context, {
          actor: { kind: "system", component },
        });
        assert.deepEqual(trust.contextVerifier.classify(context), {
          kind: "service",
          component,
          context,
        });
      }
      await assert.rejects(
        trust.serviceContextIssuer.forComponent(
          "authorization" as BackgroundServiceAuthorizationComponent,
        ),
        ServiceAuthorizationTrustError,
      );
    } finally {
      database.close();
    }
  });
});

test("authorization context verifier rejects casts, clones, and foreign trust domains", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await new SQLiteBootstrapPublicationUnitOfWork({
        database,
        clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
        ids: new DeterministicIdSource("bootstrap"),
      }).publishBootstrap(createBootstrapPublicationRecords());
      const first = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("first"),
      });
      const second = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock("2026-07-29T12:04:00.000Z"),
        ids: new DeterministicIdSource("second"),
      });
      const authentication = await first.localAuthentication.authenticate(
        first.localConnectionIssuer.issueAcceptedConnection(),
      );
      assert.equal(authentication.status, "authenticated");
      if (authentication.status !== "authenticated") return;
      assert.deepEqual(
        first.contextVerifier.classify(authentication.context),
        {
          kind: "connector",
          context: authentication.context,
        },
      );
      assert.equal(
        second.contextVerifier.classify(authentication.context),
        undefined,
      );
      assert.equal(
        first.contextVerifier.classify(
          structuredClone(authentication.context),
        ),
        undefined,
      );

      const service =
        await first.serviceContextIssuer.forComponent("broker");
      const forged = {
        actor: { kind: "system", component: "broker" },
      } as TrustedServiceAuthorizationContext<"broker">;
      assert.equal(first.contextVerifier.classify(forged), undefined);
      assert.equal(
        first.contextVerifier.classify(structuredClone(service)),
        undefined,
      );
      assert.equal(second.contextVerifier.classify(service), undefined);
      assert.equal(first.contextVerifier.classify(null), undefined);
      assert.equal(first.contextVerifier.classify("broker"), undefined);
    } finally {
      database.close();
    }
  });
});

test("multi-user authorization trust classifies local and exact mTLS contexts in one process domain", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await new SQLiteBootstrapPublicationUnitOfWork({
        database,
        clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
        ids: new DeterministicIdSource("bootstrap"),
      }).publishBootstrap(createBootstrapPublicationRecords());
      const certificateDer = new X509Certificate(
        TEST_CLIENT_CERTIFICATE_PEM,
      ).raw;
      database.transaction((transaction) => {
        transaction.run(
          `INSERT INTO principals (
            id, installation_id, kind, display_name, state, created_at
          ) VALUES (?, ?, 'human', ?, 'active', ?)`,
          [
            "remote-principal-v1",
            "installation-v1",
            "Remote User",
            "2026-08-09T12:00:00.000Z",
          ],
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
            "private-alpha-client-ca-v1",
            fingerprintClientCertificateDer(certificateDer),
            "2026-08-09T12:00:00.000Z",
          ],
        );
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
            "2026-08-09T12:00:00.000Z",
          ],
        );
      });
      const trust = createMultiUserAuthorizationTrust({
        database,
        clock: new DeterministicClock("2026-08-09T12:00:00.000Z"),
        ids: new DeterministicIdSource("combined"),
        clientCertificateTrustRootId: "private-alpha-client-ca-v1",
      });
      const local = await trust.localAuthentication.authenticate(
        trust.localConnectionIssuer.issueAcceptedConnection(),
      );
      assert.equal(local.status, "authenticated");
      if (local.status !== "authenticated") return;
      assert.equal(local.context.actor.assurance, "elevated");
      assert.equal(
        trust.contextVerifier.classify(local.context)?.kind,
        "connector",
      );

      const verification = trust.remoteCertificateVerifier.verify({
        authorized: true,
        protocol: "TLSv1.3",
        completeDer: certificateDer,
      });
      assert.equal(verification.status, "verified");
      if (verification.status !== "verified") return;
      const remote = await trust.remoteAuthentication.authenticate(
        verification.evidence,
      );
      assert.equal(remote.status, "authenticated");
      if (remote.status !== "authenticated") return;
      assert.equal(remote.context.actor.principalId, "remote-principal-v1");
      assert.equal(remote.context.actor.assurance, "normal");
      assert.equal(
        trust.contextVerifier.classify(remote.context)?.kind,
        "connector",
      );
      const authorization = new SQLiteFoundationalAuthorizationReads({
        contextVerifier: trust.contextVerifier,
      });
      assert.deepEqual(
        database.transaction((transaction) =>
          authorization.readLiveConnectorIdentity(
            transaction,
            remote.context,
          ),
        ),
        {
          status: "active",
          installationId: "installation-v1",
          principalId: "remote-principal-v1",
          identityBindingId: "remote-binding-v1",
          endpointId: "remote-endpoint-v1",
          authenticationRequestId: "combined:AuthenticationRequest:0002",
        },
      );
      assert.equal(
        trust.contextVerifier.classify(structuredClone(remote.context)),
        undefined,
      );
      const localOnly = createFirstSliceAuthorizationTrust({
        database,
        clock: new DeterministicClock("2026-08-09T12:01:00.000Z"),
        ids: new DeterministicIdSource("local-only"),
      });
      assert.equal(
        localOnly.contextVerifier.classify(remote.context),
        undefined,
      );
    } finally {
      database.close();
    }
  });
});

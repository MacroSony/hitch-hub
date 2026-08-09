import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync } from "node:fs";
import test from "node:test";

import { mvpScenarioCase } from "../acceptance/runner.js";
import { createMultiUserAuthorizationTrust } from "../application/authorization-contexts.js";
import type { AuthenticatedConnectorContext } from "../model/application.js";
import { TEST_CLIENT_CERTIFICATE_PEM } from "../connectors/remote/test-certificates.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import { DeterministicTransactionFaults } from "./transaction.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "./bootstrap-publication.js";
import type { V2Database } from "./database.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import { SQLiteLocalAdministration } from "./local-administration.js";

const NOW = "2026-08-09T12:00:00.000Z";
const TRUST_ROOT = "private-alpha-client-ca-v1";
const CERTIFICATE_DER = new X509Certificate(TEST_CLIENT_CERTIFICATE_PEM).raw;

async function publish(database: V2Database): Promise<void> {
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(createBootstrapPublicationRecords());
}

async function setup(database: V2Database) {
  await publish(database);
  const trust = createMultiUserAuthorizationTrust({
    database,
    clock: new DeterministicClock(NOW),
    ids: new DeterministicIdSource("trust"),
    clientCertificateTrustRootId: TRUST_ROOT,
  });
  const authentication = await trust.localAuthentication.authenticate(
    trust.localConnectionIssuer.issueAcceptedConnection(),
  );
  assert.equal(authentication.status, "authenticated");
  if (authentication.status !== "authenticated") {
    throw new Error("local administrator authentication failed");
  }
  const administration = new SQLiteLocalAdministration({
    database,
    clock: new DeterministicClock(NOW),
    ids: new DeterministicIdSource("admin"),
    contextVerifier: trust.contextVerifier,
    clientCertificateTrustRootId: TRUST_ROOT,
  });
  return { trust, context: authentication.context, administration };
}

test("local administrator atomically creates a fixed principal workspace and shared-use grants", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const workspace = root.resolve("workspace-user-b");
      mkdirSync(workspace, { mode: 0o700 });
      const { context, administration } = await setup(database);
      const result = await administration.execute(
        context,
        {
          kind: "create-principal",
          principalReference: "user-b",
          displayName: "User B",
          role: "member",
          workspaceReference: "workspace-b",
          canonicalWorkspaceRoot: workspace,
        },
      );
      assert.equal(result.status, "succeeded");
      if (result.status !== "succeeded") return;
      assert.deepEqual(result.result, {
        kind: "principal-created",
        principalId: "admin:Principal:0001",
        workspaceId: "admin:Workspace:0001",
      });
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT principals.state, refs.reference, grants.role,
              capacity.next_admission_ordinal, capacity.active_turn_id,
              bindings.workspace_id
            FROM principals
            JOIN principal_reference_bindings AS refs
              ON refs.principal_id = principals.id
            JOIN access_grants AS grants
              ON grants.principal_id = principals.id
              AND grants.kind = 'installation-role'
              AND grants.state = 'active'
            JOIN principal_execution_capacity AS capacity
              ON capacity.principal_id = principals.id
            JOIN principal_workspace_bindings AS bindings
              ON bindings.principal_id = principals.id
            WHERE principals.id = ?`,
            ["admin:Principal:0001"],
          ),
        ),
        {
          state: "active",
          reference: "user-b",
          role: "member",
          next_admission_ordinal: 0,
          active_turn_id: null,
          workspace_id: "admin:Workspace:0001",
        },
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT resources.canonical_host_path, resources.sandbox_path,
              revisions.revision, revision_resources.role
            FROM workspace_resources AS resources
            JOIN workspace_revision_resources AS revision_resources
              ON revision_resources.workspace_resource_id = resources.id
            JOIN workspace_revisions AS revisions
              ON revisions.id = revision_resources.workspace_revision_id
            WHERE revisions.workspace_id = ?`,
            ["admin:Workspace:0001"],
          ),
        ),
        {
          canonical_host_path: workspace,
          sandbox_path: "/workspace",
          revision: 1,
          role: "root",
        },
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT COUNT(*) AS count FROM access_grants
            WHERE principal_id = 'admin:Principal:0001' AND state = 'active'`,
          )?.count,
        ),
        8,
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT COUNT(*) AS count
            FROM execution_policy_resource_grants`,
          )?.count,
        ),
        2,
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT action, actor_principal_id, subject_principal_id
            FROM audit_envelopes WHERE action = 'principal-created'`,
          ),
        ),
        {
          action: "principal-created",
          actor_principal_id: "owner-v1",
          subject_principal_id: "admin:Principal:0001",
        },
      );
    } finally {
      database.close();
    }
  });
});

async function certificateLifecycleDenial(): Promise<void> {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const workspace = root.resolve("workspace-user-b");
      mkdirSync(workspace, { mode: 0o700 });
      const { trust, context, administration } = await setup(database);
      const created = await administration.execute(context, {
        kind: "create-principal",
        principalReference: "user-b",
        displayName: "User B",
        role: "member",
        workspaceReference: "workspace-b",
        canonicalWorkspaceRoot: workspace,
      });
      assert.equal(created.status, "succeeded");
      const bound = await administration.execute(context, {
        kind: "bind-client-certificate",
        principalReference: "user-b",
        bindingReference: "user-b-cert-v1",
        completeDer: CERTIFICATE_DER,
      });
      assert.equal(bound.status, "succeeded");
      if (bound.status !== "succeeded" || bound.result.kind !== "client-certificate-bound") {
        return;
      }
      assert.equal(bound.result.principalId, "admin:Principal:0001");
      assert.match(bound.result.fingerprint, /^sha256:[0-9a-f]{64}$/u);
      const identityBindingId = bound.result.identityBindingId;
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT COUNT(*) AS count FROM endpoints
            WHERE address_kind = 'remote-client'
              AND audience_principal_id = 'admin:Principal:0001'
              AND identity_binding_id = ?`,
            [identityBindingId],
          )?.count,
        ),
        1,
      );

      const evidence = trust.remoteCertificateVerifier.verify({
        authorized: true,
        protocol: "TLSv1.3",
        completeDer: CERTIFICATE_DER,
      });
      assert.equal(evidence.status, "verified");
      if (evidence.status !== "verified") return;
      const authenticated = await trust.remoteAuthentication.authenticate(
        evidence.evidence,
      );
      assert.equal(authenticated.status, "authenticated");
      if (authenticated.status === "authenticated") {
        assert.equal(authenticated.context.actor.principalId, "admin:Principal:0001");
      }

      const disabled = await administration.execute(context, {
        kind: "disable-principal",
        principalReference: "user-b",
      });
      assert.deepEqual(disabled, {
        status: "succeeded",
        result: {
          kind: "principal-disabled",
          principalId: "admin:Principal:0001",
        },
      });
      assert.deepEqual(
        await administration.execute(context, {
          kind: "disable-principal",
          principalReference: "user-b",
        }),
        {
          status: "succeeded",
          result: {
            kind: "principal-already-disabled",
            principalId: "admin:Principal:0001",
          },
        },
      );
      const disabledEvidence = trust.remoteCertificateVerifier.verify({
        authorized: true,
        protocol: "TLSv1.3",
        completeDer: CERTIFICATE_DER,
      });
      assert.equal(disabledEvidence.status, "verified");
      if (disabledEvidence.status !== "verified") return;
      const disabledAuthentication = await trust.remoteAuthentication.authenticate(
        disabledEvidence.evidence,
      );
      assert.equal(disabledAuthentication.status, "rejected");
      if (disabledAuthentication.status === "rejected") {
        assert.equal(disabledAuthentication.reason, "principal-disabled");
      }

      const revoked = await administration.execute(context, {
        kind: "revoke-client-certificate",
        bindingReference: "user-b-cert-v1",
      });
      assert.equal(revoked.status, "succeeded");
      assert.deepEqual(
        await administration.execute(context, {
          kind: "revoke-client-certificate",
          bindingReference: "user-b-cert-v1",
        }),
        {
          status: "succeeded",
          result: {
            kind: "client-certificate-already-revoked",
            identityBindingId,
          },
        },
      );
      const revokedEvidence = trust.remoteCertificateVerifier.verify({
        authorized: true,
        protocol: "TLSv1.3",
        completeDer: CERTIFICATE_DER,
      });
      assert.equal(revokedEvidence.status, "verified");
      if (revokedEvidence.status !== "verified") return;
      const revokedAuthentication = await trust.remoteAuthentication.authenticate(
        revokedEvidence.evidence,
      );
      assert.equal(revokedAuthentication.status, "rejected");
      if (revokedAuthentication.status === "rejected") {
        assert.equal(revokedAuthentication.reason, "binding-revoked");
      }
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT COUNT(*) AS count FROM audit_envelopes
            WHERE action IN ('principal-created', 'principal-state-changed',
              'identity-binding-state-changed')`,
          )?.count,
        ),
        4,
      );
    } finally {
      database.close();
    }
  });
}

mvpScenarioCase({
  scenarioId: "V2-MVP-S04",
  caseId: "disable-and-revoke-deny-authentication",
  title: "disabled principals and revoked certificates deny fresh authentication",
  run: certificateLifecycleDenial,
});

test("local administration denies foreign authority and rolls back a faulted principal graph", async () => {
  await withDisposableDataRoot(async (root) => {
    const faults = new DeterministicTransactionFaults();
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
      transactionFaults: faults,
    });
    try {
      const workspace = root.resolve("workspace-user-b");
      mkdirSync(workspace, { mode: 0o700 });
      const { trust, context, administration } = await setup(database);
      const forged = structuredClone(context) as AuthenticatedConnectorContext;
      assert.deepEqual(
        await administration.execute(forged, {
          kind: "disable-principal",
          principalReference: "bootstrap-owner-v1",
        }),
        { status: "rejected", code: "not-authorized" },
      );
      assert.deepEqual(
        await administration.execute(context, {
          kind: "disable-principal",
          principalReference: "bootstrap-owner-v1",
        }),
        { status: "rejected", code: "conflict" },
      );
      assert.deepEqual(
        await administration.execute(context, {
          kind: "bind-client-certificate",
          principalReference: "missing-user",
          bindingReference: "missing-cert-v1",
          completeDer: CERTIFICATE_DER,
        }),
        { status: "rejected", code: "not-found" },
      );
      assert.deepEqual(
        await administration.execute(context, {
          kind: "bind-client-certificate",
          principalReference: "bootstrap-owner-v1",
          bindingReference: "bad-cert-v1",
          completeDer: new Uint8Array([1, 2, 3]),
        }),
        { status: "rejected", code: "invalid-request" },
      );

      faults.failNext("before-commit");
      await assert.rejects(
        administration.execute(context, {
          kind: "create-principal",
          principalReference: "user-b",
          displayName: "User B",
          role: "member",
          workspaceReference: "workspace-b",
          canonicalWorkspaceRoot: workspace,
        }),
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT COUNT(*) AS count FROM principals
            WHERE id != 'owner-v1'`,
          )?.count,
        ),
        0,
      );

      const remoteVerification = trust.remoteCertificateVerifier.verify({
        authorized: true,
        protocol: "TLSv1.3",
        completeDer: CERTIFICATE_DER,
      });
      assert.equal(remoteVerification.status, "verified");
      if (remoteVerification.status !== "verified") return;
      const remoteAuthentication = await trust.remoteAuthentication.authenticate(
        remoteVerification.evidence,
      );
      assert.equal(remoteAuthentication.status, "rejected");
    } finally {
      database.close();
    }
  });
});

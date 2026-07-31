import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFirstSliceAuthorizationTrust,
  type FirstSliceAuthorizationTrust,
} from "../application/authorization-contexts.js";
import type { AuthenticatedConnectorContext } from "../model/application.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "./bootstrap-publication.js";
import type { V2Database } from "./database.js";
import { UntrustedAuthorizationContextError } from "./foundational-authorization.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import {
  SessionCreationInputError,
  SessionCreationIntegrityError,
  SQLiteSessionCreationUnitOfWork,
} from "./session-creation.js";
import { DeterministicTransactionFaults } from "./transaction.js";
import { TransactionBoundaryFaultError } from "./errors.js";

const CLOCK_START = "2026-07-29T12:05:00.000Z";

async function publishAndAuthenticate(database: V2Database): Promise<{
  readonly trust: FirstSliceAuthorizationTrust;
  readonly context: AuthenticatedConnectorContext;
}> {
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(createBootstrapPublicationRecords());
  const trust = createFirstSliceAuthorizationTrust({
    database,
    clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
    ids: new DeterministicIdSource("authorization"),
  });
  const authentication = await trust.localAuthentication.authenticate(
    trust.localConnectionIssuer.issueAcceptedConnection(),
  );
  assert.equal(authentication.status, "authenticated");
  if (authentication.status !== "authenticated") {
    throw new Error("test authentication unexpectedly failed");
  }
  return Object.freeze({
    trust,
    context: authentication.context,
  });
}

function sessionCreation(
  database: V2Database,
  trust: FirstSliceAuthorizationTrust,
): SQLiteSessionCreationUnitOfWork {
  return new SQLiteSessionCreationUnitOfWork({
    database,
    clock: new DeterministicClock(CLOCK_START),
    ids: new DeterministicIdSource("session"),
    contextVerifier: trust.contextVerifier,
  });
}

function countRows(database: V2Database, table: string): number {
  return database.transaction((transaction) => {
    const row = transaction.get(
      `SELECT COUNT(*) AS count FROM "${table}"`,
      [],
    );
    assert.ok(row !== undefined && typeof row.count === "number");
    return row.count;
  });
}

test("[V2-S03/session-creation-pins-revisions] session creation pins exact revisions and atomically creates one private session", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const unitOfWork = sessionCreation(database, trust);

      const created = await unitOfWork.createPrivateSession({
        context,
        profileReference: records.agentProfile.reference,
        workspaceReference: records.workspace.reference,
        displayName: "First session",
      });
      assert.equal(created.status, "created");
      if (created.status !== "created") return;

      assert.deepEqual(created.session, {
        id: "session:Session:0001",
        ownerPrincipalId: records.owner.id,
        specId: "session:SessionSpec:0001",
        createdAt: CLOCK_START,
      });
      assert.deepEqual(created.spec, {
        id: "session:SessionSpec:0001",
        schemaVersion: 1,
        agentProfileRevisionId: records.agentProfileRevision.id,
        workspaceRevisionId: records.workspaceRevision.id,
        executionPolicySnapshotId: records.executionPolicySnapshot.id,
        turnPolicySnapshotId: records.turnPolicySnapshot.id,
        agentResourceSnapshotIds: [
          "profile-skill-v1",
          "profile-skill-v2",
        ],
        extensionGrantSnapshotIds: [
          "profile-extension-grant-v1",
          "profile-extension-grant-v2",
        ],
        providerBindings: [
          {
            providerId: "openai-codex",
            providerConnectionId: records.providerConnection.id,
            credentialBindingId: records.providerCredentialBinding.id,
          },
        ],
        createdAt: CLOCK_START,
      });
      assert.deepEqual(created.metadata, {
        sessionId: created.session.id,
        displayName: "First session",
        labels: [],
        updatedAt: CLOCK_START,
      });
      assert.deepEqual(created.lifecycle, {
        sessionId: created.session.id,
        status: "active",
        updatedAt: CLOCK_START,
      });
      assert.deepEqual(created.runtime, {
        sessionId: created.session.id,
        status: "idle",
        updatedAt: CLOCK_START,
      });
      assert.deepEqual(created.endpointBinding, {
        id: "session:SessionEndpointBinding:0001",
        kind: "private",
        sessionId: created.session.id,
        endpointId: records.localEndpoint.id,
        createdByPrincipalId: records.owner.id,
        state: { status: "active" },
        createdAt: CLOCK_START,
        updatedAt: CLOCK_START,
      });
      assert.equal(created.auditEvents.length, 1);
      assert.deepEqual(created.auditEvents[0], {
        id: "session:AuditEnvelope:0001",
        installationId: records.installation.id,
        actor: { kind: "principal", principalId: records.owner.id },
        outcome: "succeeded",
        action: "session-created",
        sessionId: created.session.id,
        sessionSpecId: created.spec.id,
        endpointBindingId: created.endpointBinding.id,
        occurredAt: CLOCK_START,
      });
      for (const value of [
        created,
        created.session,
        created.spec,
        created.spec.providerBindings,
        created.metadata,
        created.lifecycle,
        created.runtime,
        created.endpointBinding,
        created.endpointBinding.state,
        created.auditEvents,
      ]) {
        assert.ok(Object.isFrozen(value));
      }

      database.transaction((transaction) => {
        assert.deepEqual(
          transaction.get(
            `SELECT schema_version, agent_profile_revision_id,
              workspace_revision_id, execution_policy_snapshot_id,
              turn_policy_snapshot_id, created_at
            FROM session_specs
            WHERE id = ?`,
            [created.spec.id],
          ),
          {
            schema_version: 1,
            agent_profile_revision_id: records.agentProfileRevision.id,
            workspace_revision_id: records.workspaceRevision.id,
            execution_policy_snapshot_id:
              records.executionPolicySnapshot.id,
            turn_policy_snapshot_id: records.turnPolicySnapshot.id,
            created_at: CLOCK_START,
          },
        );
        assert.deepEqual(
          transaction.all(
            `SELECT agent_resource_snapshot_id AS snapshot, ordinal
            FROM session_spec_resource_snapshots
            WHERE session_spec_id = ?
            ORDER BY ordinal`,
            [created.spec.id],
          ),
          [
            { snapshot: "profile-skill-v1", ordinal: 0 },
            { snapshot: "profile-skill-v2", ordinal: 1 },
          ],
        );
        assert.deepEqual(
          transaction.all(
            `SELECT extension_grant_snapshot_id AS grant, ordinal
            FROM session_spec_extension_grants
            WHERE session_spec_id = ?
            ORDER BY ordinal`,
            [created.spec.id],
          ),
          [
            { grant: "profile-extension-grant-v1", ordinal: 0 },
            { grant: "profile-extension-grant-v2", ordinal: 1 },
          ],
        );
        assert.deepEqual(
          transaction.get(
            `SELECT provider_id, provider_connection_id,
              credential_binding_id
            FROM session_spec_provider_bindings
            WHERE session_spec_id = ?`,
            [created.spec.id],
          ),
          {
            provider_id: "openai-codex",
            provider_connection_id: records.providerConnection.id,
            credential_binding_id: records.providerCredentialBinding.id,
          },
        );
        assert.deepEqual(
          transaction.get(
            `SELECT owner_principal_id, spec_id, created_at
            FROM sessions
            WHERE id = ?`,
            [created.session.id],
          ),
          {
            owner_principal_id: records.owner.id,
            spec_id: created.spec.id,
            created_at: CLOCK_START,
          },
        );
        assert.deepEqual(
          transaction.get(
            `SELECT display_name, labels_json, updated_at
            FROM session_metadata
            WHERE session_id = ?`,
            [created.session.id],
          ),
          {
            display_name: "First session",
            labels_json: "[]",
            updated_at: CLOCK_START,
          },
        );
        assert.deepEqual(
          transaction.get(
            `SELECT status, blocked_reason, updated_at
            FROM session_lifecycle
            WHERE session_id = ?`,
            [created.session.id],
          ),
          {
            status: "active",
            blocked_reason: null,
            updated_at: CLOCK_START,
          },
        );
        assert.deepEqual(
          transaction.get(
            `SELECT status, active_turn_id, worker_lease_id,
              agent_resume_handle_id, last_activity_at, updated_at
            FROM session_runtime_state
            WHERE session_id = ?`,
            [created.session.id],
          ),
          {
            status: "idle",
            active_turn_id: null,
            worker_lease_id: null,
            agent_resume_handle_id: null,
            last_activity_at: null,
            updated_at: CLOCK_START,
          },
        );
        assert.deepEqual(
          transaction.get(
            `SELECT kind, endpoint_id, created_by_principal_id, state,
              suspended_at, revoked_at, created_at, updated_at
            FROM session_endpoint_bindings
            WHERE id = ?`,
            [created.endpointBinding.id],
          ),
          {
            kind: "private",
            endpoint_id: records.localEndpoint.id,
            created_by_principal_id: records.owner.id,
            state: "active",
            suspended_at: null,
            revoked_at: null,
            created_at: CLOCK_START,
            updated_at: CLOCK_START,
          },
        );
        assert.deepEqual(
          transaction.get(
            `SELECT actor_kind, actor_principal_id, outcome, action,
              session_id, session_spec_id, endpoint_binding_id,
              occurred_at
            FROM audit_envelopes
            WHERE id = ?`,
            [created.auditEvents[0]!.id],
          ),
          {
            actor_kind: "principal",
            actor_principal_id: records.owner.id,
            outcome: "succeeded",
            action: "session-created",
            session_id: created.session.id,
            session_spec_id: created.spec.id,
            endpoint_binding_id: created.endpointBinding.id,
            occurred_at: CLOCK_START,
          },
        );
      });

      const second = await unitOfWork.createPrivateSession({
        context,
        profileReference: records.agentProfile.reference,
        workspaceReference: records.workspace.reference,
      });
      assert.equal(second.status, "created");
      if (second.status !== "created") return;
      assert.notEqual(second.session.id, created.session.id);
      assert.equal(second.metadata.displayName, undefined);
      assert.equal(countRows(database, "sessions"), 2);
      assert.equal(countRows(database, "session_endpoint_bindings"), 2);
    } finally {
      database.close();
    }
  });
});

test("session creation reports missing profile and workspace references with denial audit", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const unitOfWork = sessionCreation(database, trust);

      const missingProfile = await unitOfWork.createPrivateSession({
        context,
        profileReference: "missing-profile",
        workspaceReference: records.workspace.reference,
      });
      assert.deepEqual(missingProfile, {
        status: "not-found",
        missing: "profile",
        auditEvents: [
          {
            id: "session:AuditEnvelope:0001",
            installationId: records.installation.id,
            actor: { kind: "principal", principalId: records.owner.id },
            outcome: "denied",
            action: "session-creation-denied",
            occurredAt: CLOCK_START,
          },
        ],
      });

      const missingWorkspace = await unitOfWork.createPrivateSession({
        context,
        profileReference: records.agentProfile.reference,
        workspaceReference: "missing-workspace",
      });
      assert.equal(missingWorkspace.status, "not-found");
      if (missingWorkspace.status !== "not-found") return;
      assert.equal(missingWorkspace.missing, "workspace");
      assert.equal(
        missingWorkspace.auditEvents[0]!.action,
        "session-creation-denied",
      );
      assert.equal(countRows(database, "sessions"), 0);
      assert.equal(
        database.transaction((transaction) => {
          const row = transaction.get(
            `SELECT COUNT(*) AS count
            FROM audit_envelopes
            WHERE action = 'session-creation-denied' AND outcome = 'denied'`,
            [],
          );
          assert.ok(row !== undefined && typeof row.count === "number");
          return row.count;
        }),
        2,
      );
    } finally {
      database.close();
    }
  });
});

test("session creation denies a disabled principal or revoked identity binding", async () => {
  const cases = [
    {
      name: "principal-disabled",
      mutate(database: V2Database): void {
        database.transaction((transaction) =>
          transaction.run(
            `UPDATE principals
              SET state = 'disabled',
                disabled_at = ?,
                disabled_actor_kind = 'system',
                disabled_actor_system_component = 'authorization'
              WHERE id = ?`,
            ["2026-07-29T12:04:00.000Z", "owner-v1"],
          ),
        );
      },
    },
    {
      name: "binding-inactive",
      mutate(database: V2Database): void {
        database.transaction((transaction) =>
          transaction.run(
            `UPDATE identity_bindings
              SET state = 'revoked',
                revoked_at = ?,
                revoked_actor_kind = 'system',
                revoked_actor_system_component = 'authorization'
              WHERE id = ?`,
            ["2026-07-29T12:04:00.000Z", "owner-binding-v1"],
          ),
        );
      },
    },
  ];
  for (const entry of cases) {
    await withDisposableDataRoot(async (root) => {
      const database = openCanonicalHitchV2Database({
        dataRoot: root.resolve("state"),
      });
      try {
        const records = createBootstrapPublicationRecords();
        const { trust, context } = await publishAndAuthenticate(database);
        entry.mutate(database);
        const denied = await sessionCreation(
          database,
          trust,
        ).createPrivateSession({
          context,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
        });
        assert.deepEqual(denied, {
          status: "denied",
          reason: entry.name,
          auditEvents: [
            {
              id: "session:AuditEnvelope:0001",
              installationId: records.installation.id,
              actor: { kind: "principal", principalId: records.owner.id },
              outcome: "denied",
              action: "session-creation-denied",
              occurredAt: CLOCK_START,
            },
          ],
        });
        assert.equal(countRows(database, "sessions"), 0);
      } finally {
        database.close();
      }
    });
  }
});

test("[V2-S03/session-creation-use-grant-enforcement] session creation rejects a revoked or absent configuration-use grant", async () => {
  const cases = [
    { grantId: "grant-profile-v1", resourceKind: "agent-profile" },
    { grantId: "grant-workspace-v1", resourceKind: "workspace" },
    { grantId: "grant-execution-v1", resourceKind: "execution-policy" },
    { grantId: "grant-turn-v1", resourceKind: "turn-policy" },
    { grantId: "grant-extension-v1", resourceKind: "extension" },
    {
      grantId: "grant-credential-v1",
      resourceKind: "provider-credential-binding",
    },
  ] as const;
  for (const entry of cases) {
    await withDisposableDataRoot(async (root) => {
      const database = openCanonicalHitchV2Database({
        dataRoot: root.resolve("state"),
      });
      try {
        const records = createBootstrapPublicationRecords();
        const { trust, context } = await publishAndAuthenticate(database);
        database.transaction((transaction) =>
          transaction.run(
            `UPDATE access_grants
              SET state = 'revoked',
                revoked_at = ?,
                revoked_actor_kind = 'system',
                revoked_actor_system_component = 'authorization'
              WHERE id = ?`,
            ["2026-07-29T12:04:00.000Z", entry.grantId],
          ),
        );
        const denied = await sessionCreation(
          database,
          trust,
        ).createPrivateSession({
          context,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
        });
        assert.equal(denied.status, "denied");
        if (denied.status !== "denied") return;
        assert.equal(denied.reason, "required-configuration-use-revoked");
        if (denied.reason !== "required-configuration-use-revoked") return;
        assert.equal(denied.resourceKind, entry.resourceKind);
        assert.equal(
          denied.auditEvents[0]!.action,
          "session-creation-denied",
        );
        assert.equal(countRows(database, "sessions"), 0);
      } finally {
        database.close();
      }
    });
  }

  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      database.transaction((transaction) =>
        transaction.run(
          "DELETE FROM access_grants WHERE id = ?",
          ["grant-profile-v1"],
        ),
      );
      const denied = await sessionCreation(
        database,
        trust,
      ).createPrivateSession({
        context,
        profileReference: records.agentProfile.reference,
        workspaceReference: records.workspace.reference,
      });
      assert.equal(denied.status, "denied");
      if (denied.status !== "denied") return;
      assert.equal(denied.reason, "required-configuration-use-revoked");
      if (denied.reason !== "required-configuration-use-revoked") return;
      assert.equal(denied.resourceKind, "agent-profile");
      assert.equal(countRows(database, "sessions"), 0);
    } finally {
      database.close();
    }
  });
});

test("[V2-S02/session-creation-authority-exclusion] session creation rejects forged, cloned, and service authority", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const unitOfWork = sessionCreation(database, trust);
      const service =
        await trust.serviceContextIssuer.forComponent("broker");

      await assert.rejects(
        unitOfWork.createPrivateSession({
          context: structuredClone(context),
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
        }),
        UntrustedAuthorizationContextError,
      );
      await assert.rejects(
        unitOfWork.createPrivateSession({
          context: service as unknown as AuthenticatedConnectorContext,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
        }),
        UntrustedAuthorizationContextError,
      );
      assert.equal(countRows(database, "sessions"), 0);
    } finally {
      database.close();
    }
  });
});

test("session creation rolls back every row across a commit fault", async () => {
  await withDisposableDataRoot(async (root) => {
    const faults = new DeterministicTransactionFaults();
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
      transactionFaults: faults,
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const unitOfWork = sessionCreation(database, trust);

      faults.failNext("before-commit");
      await assert.rejects(
        unitOfWork.createPrivateSession({
          context,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
        }),
        TransactionBoundaryFaultError,
      );
      for (const table of [
        "session_specs",
        "session_spec_resource_snapshots",
        "session_spec_extension_grants",
        "session_spec_provider_bindings",
        "sessions",
        "session_metadata",
        "session_lifecycle",
        "session_runtime_state",
        "session_endpoint_bindings",
      ]) {
        assert.equal(countRows(database, table), 0, table);
      }

      const created = await unitOfWork.createPrivateSession({
        context,
        profileReference: records.agentProfile.reference,
        workspaceReference: records.workspace.reference,
      });
      assert.equal(created.status, "created");
      assert.equal(countRows(database, "sessions"), 1);
    } finally {
      database.close();
    }
  });
});

test("session creation rejects ambiguous installation policy configuration", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      database.transaction((transaction) =>
        transaction.run(
          `INSERT INTO execution_policies (
            id, installation_id, reference, display_name, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            "execution-policy-v2",
            "installation-v1",
            "execution-policy-v2",
            "Second execution policy",
            "2026-07-29T12:04:00.000Z",
          ],
        ),
      );
      await assert.rejects(
        sessionCreation(database, trust).createPrivateSession({
          context,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
        }),
        SessionCreationIntegrityError,
      );
      assert.equal(countRows(database, "sessions"), 0);
    } finally {
      database.close();
    }
  });
});

test("session creation rejects an unbounded display name", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const unitOfWork = sessionCreation(database, trust);
      await assert.rejects(
        unitOfWork.createPrivateSession({
          context,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
          displayName: "",
        }),
        SessionCreationInputError,
      );
      await assert.rejects(
        unitOfWork.createPrivateSession({
          context,
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
          displayName: "bad\u0007name",
        }),
        SessionCreationInputError,
      );
      assert.equal(countRows(database, "sessions"), 0);
    } finally {
      database.close();
    }
  });
});

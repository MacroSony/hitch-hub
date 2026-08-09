import assert from "node:assert/strict";
import { test } from "node:test";

import type { BootstrapPublicationRecords } from "../model/application.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  BootstrapPublicationConflictError,
  SQLiteBootstrapPublicationUnitOfWork,
} from "./bootstrap-publication.js";
import type { V2Database } from "./database.js";
import { TransactionBoundaryFaultError } from "./errors.js";
import { projectBootstrapFoundationRows } from "./foundation-rows.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import { DeterministicTransactionFaults } from "./transaction.js";

function mutable(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function count(database: V2Database, table: string): number {
  const row = database.transaction((transaction) =>
    transaction.get(`SELECT COUNT(*) AS count FROM "${table}"`),
  );
  assert.ok(row);
  const value = row.count;
  assert.equal(typeof value, "number");
  return value as number;
}

function unit(
  database: V2Database,
  ids = new DeterministicIdSource("bootstrap"),
  clock = new DeterministicClock("2026-07-29T12:01:00.000Z"),
) {
  return {
    ids,
    clock,
    publication: new SQLiteBootstrapPublicationUnitOfWork({
      database,
      ids,
      clock,
    }),
  };
}

function retimestamp(value: unknown, timestamp: string): void {
  if (Array.isArray(value)) {
    value.forEach((item) => retimestamp(item, timestamp));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (key === "createdAt" || key === "updatedAt") {
      object[key] = timestamp;
    } else {
      retimestamp(child, timestamp);
    }
  }
}

function nextRevision(
  records: BootstrapPublicationRecords,
): BootstrapPublicationRecords {
  const next = structuredClone(records);
  retimestamp(next, "2026-07-29T12:02:00.000Z");
  mutable(next.workspaceRevision).id = "workspace-revision-v2";
  mutable(next.workspaceRevision).revision = 2;
  mutable(next.referenceBindings.workspace).workspaceRevisionId =
    "workspace-revision-v2";
  mutable(next.executionPolicySnapshot).id =
    "execution-policy-snapshot-v2";
  mutable(next.executionPolicySnapshot).revision = 2;
  mutable(next.turnPolicySnapshot).id = "turn-policy-snapshot-v2";
  mutable(next.turnPolicySnapshot).revision = 2;
  mutable(next.agentProfileRevision).id = "pi-profile-revision-v2";
  mutable(next.agentProfileRevision).revision = 2;
  return next;
}

test("bootstrap publication atomically inserts foundation and allowlisted audit", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const input = structuredClone(createBootstrapPublicationRecords());
      const { publication } = unit(database);
      const result = await publication.publishBootstrap(input);

      assert.equal(result.status, "published");
      assert.equal(result.installation.id, input.installation.id);
      assert.equal(result.owner.id, input.owner.id);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.installation));
      assert.ok(Object.isFrozen(result.auditEvents));
      assert.deepEqual(result.auditEvents, [
        {
          id: "bootstrap:AuditEnvelope:0001",
          installationId: "installation-v1",
          actor: { kind: "bootstrap" },
          outcome: "succeeded",
          action: "installation-published",
          occurredAt: "2026-07-29T12:01:00.000Z",
        },
      ]);
      assert.equal(count(database, "installations"), 1);
      assert.equal(count(database, "audit_envelopes"), 1);
      assert.equal(count(database, "bootstrap_publication_rows"), 83);
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT actor_kind, actor_principal_id, system_component,
              outcome, action, authentication_request_id, session_id,
              turn_id, occurred_at
            FROM audit_envelopes`,
          ),
        ),
        {
          actor_kind: "bootstrap",
          actor_principal_id: null,
          system_component: null,
          outcome: "succeeded",
          action: "installation-published",
          authentication_request_id: null,
          session_id: null,
          turn_id: null,
          occurred_at: "2026-07-29T12:01:00.000Z",
        },
      );

      mutable(input.owner).displayName = "Mutated after commit";
      assert.notEqual(
        result.owner.displayName,
        input.owner.displayName,
      );
    } finally {
      database.close();
    }
  });

});

test("exact and relationally reordered bootstrap retries are unchanged", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { publication, ids } = unit(database);
      assert.equal(
        (await publication.publishBootstrap(records)).status,
        "published",
      );
      const exact = await publication.publishBootstrap(
        structuredClone(records),
      );
      assert.equal(exact.status, "unchanged");
      assert.deepEqual(exact.auditEvents, []);

      const retimed = structuredClone(records);
      retimestamp(retimed, "2026-07-29T12:05:00.000Z");
      const retimedResult = await publication.publishBootstrap(retimed);
      assert.equal(retimedResult.status, "unchanged");
      assert.equal(
        retimedResult.installation.createdAt,
        records.installation.createdAt,
      );
      assert.equal(
        retimedResult.installation.updatedAt,
        records.installation.updatedAt,
      );

      const reordered = structuredClone(records);
      mutableArray(reordered.accessGrants).reverse();
      mutableArray(
        reordered.providerConnection.allowedUpstreamOrigins,
      ).reverse();
      mutableArray(
        reordered.executionPolicySnapshot.resourceGrants,
      ).reverse();
      mutableArray(reordered.executionPolicySnapshot.tools).reverse();
      const reorderedResult =
        await publication.publishBootstrap(reordered);
      assert.equal(reorderedResult.status, "unchanged");
      assert.deepEqual(reorderedResult.auditEvents, []);
      assert.equal(count(database, "audit_envelopes"), 1);
      assert.equal(
        ids.next("AuditEnvelope"),
        "bootstrap:AuditEnvelope:0002",
      );
    } finally {
      database.close();
    }
  });

});

test("bootstrap replay preserves runtime multi-user rows and mutable capacity", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { publication } = unit(database);
      await publication.publishBootstrap(records);
      const createdAt = "2026-07-29T12:03:00.000Z";
      const fingerprint = `sha256:${"ab".repeat(32)}`;
      database.transaction((transaction) => {
        transaction.run(
          `UPDATE principal_execution_capacity
            SET next_admission_ordinal = ?, updated_at = ?
            WHERE principal_id = ?`,
          [7, createdAt, records.owner.id],
        );
        transaction.run(
          `INSERT INTO principals (
            id, installation_id, kind, display_name, state, created_at
          ) VALUES (?, ?, 'human', ?, 'active', ?)`,
          ["member-v1", records.installation.id, "Member", createdAt],
        );
        transaction.run(
          `INSERT INTO workspaces (
            id, installation_id, reference, display_name, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            "member-workspace-v1",
            records.installation.id,
            "member-workspace-v1",
            "Member workspace",
            createdAt,
          ],
        );
        transaction.run(
          `INSERT INTO principal_workspace_bindings (
            principal_id, installation_id, workspace_id,
            created_actor_kind, created_at
          ) VALUES (?, ?, ?, 'bootstrap', ?)`,
          [
            "member-v1",
            records.installation.id,
            "member-workspace-v1",
            createdAt,
          ],
        );
        transaction.run(
          `INSERT INTO identity_bindings (
            id, installation_id, principal_id, source_kind,
            client_trust_root_id, subject_id, state, created_at
          ) VALUES (?, ?, ?, 'mtls-client', ?, ?, 'active', ?)`,
          [
            "member-binding-v1",
            records.installation.id,
            "member-v1",
            "client-ca-v1",
            fingerprint,
            createdAt,
          ],
        );
        transaction.run(
          `INSERT INTO endpoints (
            id, installation_id, address_kind, identity_binding_id,
            identity_binding_source_kind, audience_kind,
            audience_principal_id, created_at
          ) VALUES (?, ?, 'remote-client', ?, 'mtls-client', 'private', ?, ?)`,
          [
            "member-endpoint-v1",
            records.installation.id,
            "member-binding-v1",
            "member-v1",
            createdAt,
          ],
        );
        transaction.run(
          `INSERT INTO access_grants (
            id, kind, installation_id, principal_id, role,
            granted_actor_kind, created_at, state
          ) VALUES (?, 'installation-role', ?, ?, 'member', 'bootstrap', ?, 'active')`,
          ["member-role-v1", records.installation.id, "member-v1", createdAt],
        );
        transaction.run(
          `INSERT INTO principal_execution_capacity (
            principal_id, next_admission_ordinal, active_turn_id, updated_at
          ) VALUES (?, 0, NULL, ?)`,
          ["member-v1", createdAt],
        );
      });

      const replay = await publication.publishBootstrap(
        structuredClone(records),
      );
      assert.equal(replay.status, "unchanged");
      assert.deepEqual(replay.auditEvents, []);
      assert.equal(count(database, "principals"), 2);
      assert.equal(count(database, "identity_bindings"), 2);
      assert.equal(count(database, "endpoints"), 2);
      assert.equal(count(database, "workspaces"), 2);
      assert.equal(count(database, "principal_workspace_bindings"), 2);
      assert.equal(count(database, "principal_execution_capacity"), 2);
      assert.equal(count(database, "bootstrap_publication_rows"), 83);
      assert.equal(count(database, "audit_envelopes"), 1);
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT next_admission_ordinal, updated_at
              FROM principal_execution_capacity WHERE principal_id = ?`,
            [records.owner.id],
          ),
        ),
        { next_admission_ordinal: 7, updated_at: createdAt },
      );

      database.transaction((transaction) =>
        transaction.run(
          `INSERT INTO provider_credential_bindings (
            id, installation_id, provider_id, custody, display_name, state,
            created_actor_kind, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "extra-credential-binding-v1",
            records.installation.id,
            records.providerConnection.providerId,
            "hitch-control-plane",
            "Unexpected credential",
            "active",
            "bootstrap",
            createdAt,
            createdAt,
          ],
        ),
      );
      await assert.rejects(
        publication.publishBootstrap(records),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "provider_credential_bindings"), 2);
      assert.equal(count(database, "audit_envelopes"), 1);
    } finally {
      database.close();
    }
  });
});

test("semantic bootstrap changes append revisions and reject stale pointer rollback", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const original = createBootstrapPublicationRecords();
      const advanced = nextRevision(original);
      const { publication } = unit(database);
      await publication.publishBootstrap(original);
      const backward = nextRevision(original);
      retimestamp(backward, "2026-07-29T11:59:00.000Z");
      await assert.rejects(
        publication.publishBootstrap(backward),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "workspace_revisions"), 1);
      assert.equal(count(database, "audit_envelopes"), 1);

      const jumped = structuredClone(advanced);
      for (const revision of [
        jumped.workspaceRevision,
        jumped.executionPolicySnapshot,
        jumped.turnPolicySnapshot,
        jumped.agentProfileRevision,
      ]) {
        mutable(revision).revision = 3;
      }
      await assert.rejects(
        publication.publishBootstrap(jumped),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "workspace_revisions"), 1);
      assert.equal(count(database, "audit_envelopes"), 1);

      const changed = await publication.publishBootstrap(advanced);
      assert.equal(changed.status, "published");
      assert.equal(
        changed.auditEvents[0].id,
        "bootstrap:AuditEnvelope:0002",
      );
      assert.equal(
        changed.installation.createdAt,
        original.installation.createdAt,
      );
      assert.equal(
        changed.installation.updatedAt,
        advanced.installation.updatedAt,
      );
      assert.equal(changed.owner.createdAt, original.owner.createdAt);
      for (const table of [
        "workspace_revisions",
        "execution_policy_snapshots",
        "turn_policy_snapshots",
        "agent_profile_revisions",
      ]) {
        assert.equal(count(database, table), 2, table);
      }
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT workspace_revision_id
            FROM workspace_reference_bindings
            WHERE workspace_id = ?`,
            [original.workspace.id],
          ),
        ),
        { workspace_revision_id: advanced.workspaceRevision.id },
      );
      assert.equal(count(database, "audit_envelopes"), 2);

      const retry = await publication.publishBootstrap(
        structuredClone(advanced),
      );
      assert.equal(retry.status, "unchanged");
      assert.equal(count(database, "audit_envelopes"), 2);
      const mixed = structuredClone(advanced);
      mutable(mixed).executionPolicySnapshot =
        original.executionPolicySnapshot;
      mutable(mixed).turnPolicySnapshot = original.turnPolicySnapshot;
      mutable(mixed).agentProfileRevision =
        original.agentProfileRevision;
      await assert.rejects(
        publication.publishBootstrap(mixed),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "audit_envelopes"), 2);
      await assert.rejects(
        publication.publishBootstrap(original),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "workspace_revisions"), 2);
      assert.equal(count(database, "audit_envelopes"), 2);
    } finally {
      database.close();
    }
  });
});

test("conflicting or partial bootstrap state fails closed without mutation", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { publication } = unit(database);
      await publication.publishBootstrap(records);
      const conflict = structuredClone(records);
      mutable(conflict.owner).displayName = "Different owner";
      await assert.rejects(
        publication.publishBootstrap(conflict),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "audit_envelopes"), 1);
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            "SELECT display_name FROM principals WHERE id = ?",
            [records.owner.id],
          ),
        ),
        { display_name: records.owner.displayName },
      );

    } finally {
      database.close();
    }
  });

  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      database.transaction((transaction) =>
        transaction.run(
          "INSERT INTO extension_capabilities (id) VALUES (?)",
          ["orphan-capability-v1"],
        ),
      );
      const { publication } = unit(database);
      await assert.rejects(
        publication.publishBootstrap(
          createBootstrapPublicationRecords(),
        ),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "installations"), 0);
      assert.equal(count(database, "extension_capabilities"), 1);
      assert.equal(count(database, "audit_envelopes"), 0);
    } finally {
      database.close();
    }
  });

  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const installation = projectBootstrapFoundationRows(records).rows.find(
        (row) => row.table === "installations",
      );
      assert.ok(installation);
      database.transaction((transaction) =>
        transaction.run(
          `INSERT INTO installations (
            id, service_schema_digest, hard_ceilings_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)`,
          installation.values,
        ),
      );
      const { publication } = unit(database);
      await assert.rejects(
        publication.publishBootstrap(records),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "installations"), 1);
      assert.equal(count(database, "principals"), 0);
      assert.equal(count(database, "audit_envelopes"), 0);
      assert.equal(count(database, "bootstrap_publication_rows"), 0);
    } finally {
      database.close();
    }
  });
});

test("bootstrap publication never heals missing ledgered foundation rows", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { publication } = unit(database);
      await publication.publishBootstrap(records);
      const deleted = database.transaction((transaction) =>
        transaction.run(
          `DELETE FROM provider_connection_origins
            WHERE provider_connection_id = ? AND origin = ?`,
          [
            records.providerConnection.id,
            records.providerConnection.allowedUpstreamOrigins[0]!,
          ],
        ),
      );
      assert.equal(deleted.changes, 1);
      assert.equal(count(database, "provider_connection_origins"), 1);

      await assert.rejects(
        publication.publishBootstrap(records),
        BootstrapPublicationConflictError,
      );
      assert.equal(count(database, "provider_connection_origins"), 1);
      assert.equal(count(database, "audit_envelopes"), 1);
      assert.equal(count(database, "bootstrap_publication_rows"), 83);
    } finally {
      database.close();
    }
  });
});

test("bootstrap publication rolls back before commit and converges after commit uncertainty", async () => {
  await withDisposableDataRoot(async (root) => {
    const faults = new DeterministicTransactionFaults();
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
      transactionFaults: faults,
    });
    try {
      const { publication } = unit(database);
      faults.failNext("before-commit");
      await assert.rejects(
        publication.publishBootstrap(
          createBootstrapPublicationRecords(),
        ),
        (error: unknown) =>
          error instanceof TransactionBoundaryFaultError &&
          error.boundary === "before-commit",
      );
      assert.equal(count(database, "installations"), 0);
      assert.equal(count(database, "audit_envelopes"), 0);
      assert.equal(count(database, "bootstrap_publication_rows"), 0);
      const retried = await publication.publishBootstrap(
        createBootstrapPublicationRecords(),
      );
      assert.equal(retried.status, "published");
      assert.equal(
        retried.auditEvents[0].id,
        "bootstrap:AuditEnvelope:0002",
      );
    } finally {
      database.close();
    }
  });

  await withDisposableDataRoot(async (root) => {
    const faults = new DeterministicTransactionFaults();
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
      transactionFaults: faults,
    });
    try {
      const records: BootstrapPublicationRecords =
        createBootstrapPublicationRecords();
      const { publication } = unit(database);
      faults.failNext("after-commit");
      await assert.rejects(
        publication.publishBootstrap(records),
        (error: unknown) =>
          error instanceof TransactionBoundaryFaultError &&
          error.boundary === "after-commit",
      );
      assert.equal(count(database, "installations"), 1);
      assert.equal(count(database, "audit_envelopes"), 1);
      assert.equal(count(database, "bootstrap_publication_rows"), 83);
      const retried = await publication.publishBootstrap(records);
      assert.equal(retried.status, "unchanged");
      assert.deepEqual(retried.auditEvents, []);
      assert.equal(count(database, "audit_envelopes"), 1);
    } finally {
      database.close();
    }
  });
});

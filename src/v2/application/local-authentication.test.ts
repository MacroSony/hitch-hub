import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AcceptedLocalConnectorConnection,
  AuthenticatedConnectorContext,
} from "../model/application.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import type { V2Database } from "../persistence/database.js";
import { TransactionBoundaryFaultError } from "../persistence/errors.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { DeterministicTransactionFaults } from "../persistence/transaction.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  createLocalConnectorAuthentication,
  LocalAuthenticationStateError,
  LocalConnectorTrustError,
} from "./local-authentication.js";

function count(database: V2Database, table: string): number {
  const row = database.transaction((transaction) =>
    transaction.get(`SELECT COUNT(*) AS count FROM "${table}"`),
  );
  assert.ok(row);
  assert.equal(typeof row.count, "number");
  return row.count as number;
}

async function publish(database: V2Database): Promise<void> {
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(createBootstrapPublicationRecords());
}

test("local connection authentication records one request and audit before minting context", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("local-auth"),
      });
      const connection =
        trust.connectionIssuer.issueAcceptedConnection();
      const result = await trust.authentication.authenticate(connection);
      assert.equal(result.status, "authenticated");
      if (result.status !== "authenticated") return;

      assert.equal(trust.contextVerifier.isAuthentic(result.context), true);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.context));
      assert.ok(Object.isFrozen(result.context.actor));
      assert.deepEqual(result.context, {
        actor: {
          kind: "authenticated-principal",
          principalId: "owner-v1",
          identityBindingId: "owner-binding-v1",
          method: "local-peer",
          assurance: "normal",
          requestId: "local-auth:AuthenticationRequest:0001",
          authenticatedAt: "2026-07-29T12:03:00.000Z",
        },
        endpointId: "endpoint-v1",
      });
      assert.equal(count(database, "authentication_requests"), 1);
      assert.equal(count(database, "audit_envelopes"), 2);
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT
              evidence_kind, socket_security, outcome_status,
              principal_id, identity_binding_id, assurance,
              rejection_reason, decided_at
            FROM authentication_requests`,
          ),
        ),
        {
          evidence_kind: "local-peer-owner-socket",
          socket_security:
            "service-owned-0700-parent-and-0600-socket",
          outcome_status: "authenticated",
          principal_id: "owner-v1",
          identity_binding_id: "owner-binding-v1",
          assurance: "normal",
          rejection_reason: null,
          decided_at: "2026-07-29T12:03:00.000Z",
        },
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT actor_kind, system_component, outcome, action,
              authentication_request_id
            FROM audit_envelopes
            WHERE action = 'authentication-recorded'`,
          ),
        ),
        {
          actor_kind: "system",
          system_component: "local-connector",
          outcome: "succeeded",
          action: "authentication-recorded",
          authentication_request_id:
            "local-auth:AuthenticationRequest:0001",
        },
      );

      await assert.rejects(
        trust.authentication.authenticate(connection),
        LocalConnectorTrustError,
      );
      assert.equal(count(database, "authentication_requests"), 1);
      const forgedConnection = {} as AcceptedLocalConnectorConnection;
      await assert.rejects(
        trust.authentication.authenticate(forgedConnection),
        LocalConnectorTrustError,
      );
      const forgedContext = {
        actor: result.context.actor,
        endpointId: result.context.endpointId,
      } as AuthenticatedConnectorContext;
      assert.equal(trust.contextVerifier.isAuthentic(forgedContext), false);
    } finally {
      database.close();
    }
  });
});

test("local authentication records live binding and principal rejection reasons", async () => {
  const cases = [
    {
      name: "binding-revoked",
      mutate(database: V2Database): void {
        database.transaction((transaction) =>
          transaction.run(
            `UPDATE identity_bindings
              SET state = 'revoked',
                revoked_at = ?,
                revoked_actor_kind = 'system',
                revoked_actor_system_component = 'authorization'
              WHERE id = ?`,
            ["2026-07-29T12:02:00.000Z", "owner-binding-v1"],
          ),
        );
      },
    },
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
            ["2026-07-29T12:02:00.000Z", "owner-v1"],
          ),
        );
      },
    },
    {
      name: "unknown-binding",
      mutate(database: V2Database): void {
        database.transaction((transaction) => {
          transaction.run(
            `DELETE FROM authentication_subject_reference_bindings
              WHERE identity_binding_id = ?`,
            ["owner-binding-v1"],
          );
          transaction.run(
            `DELETE FROM identity_binding_reference_bindings
              WHERE identity_binding_id = ?`,
            ["owner-binding-v1"],
          );
          transaction.run(
            "DELETE FROM identity_bindings WHERE id = ?",
            ["owner-binding-v1"],
          );
        });
      },
    },
  ] as const;

  for (const scenario of cases) {
    await withDisposableDataRoot(async (root) => {
      const database = openCanonicalHitchV2Database({
        dataRoot: root.resolve(`state-${scenario.name}`),
      });
      try {
        await publish(database);
        scenario.mutate(database);
        const trust = createLocalConnectorAuthentication({
          database,
          clock: new DeterministicClock(
            "2026-07-29T12:03:00.000Z",
          ),
          ids: new DeterministicIdSource(scenario.name),
        });
        const result = await trust.authentication.authenticate(
          trust.connectionIssuer.issueAcceptedConnection(),
        );
        assert.deepEqual(result, {
          status: "rejected",
          authenticationRequestId:
            `${scenario.name}:AuthenticationRequest:0001`,
          reason: scenario.name,
        });
        assert.deepEqual(
          database.transaction((transaction) =>
            transaction.get(
              `SELECT outcome_status, principal_id,
                identity_binding_id, assurance, rejection_reason
              FROM authentication_requests`,
            ),
          ),
          {
            outcome_status: "rejected",
            principal_id: null,
            identity_binding_id: null,
            assurance: null,
            rejection_reason: scenario.name,
          },
        );
        assert.deepEqual(
          database.transaction((transaction) =>
            transaction.get(
              `SELECT outcome
              FROM audit_envelopes
              WHERE action = 'authentication-recorded'`,
            ),
          ),
          { outcome: "denied" },
        );
      } finally {
        database.close();
      }
    });
  }
});

test("local authentication rejects missing mapping, provenance, and unpublished state", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      database.transaction((transaction) => {
        transaction.run(
          "DELETE FROM endpoint_reference_bindings WHERE endpoint_id = ?",
          ["endpoint-v1"],
        );
        transaction.run(
          "DELETE FROM endpoints WHERE id = ?",
          ["endpoint-v1"],
        );
      });
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("missing-endpoint"),
      });
      await assert.rejects(
        trust.authentication.authenticate(
          trust.connectionIssuer.issueAcceptedConnection(),
        ),
        LocalAuthenticationStateError,
      );
      assert.equal(count(database, "authentication_requests"), 0);
      assert.equal(count(database, "audit_envelopes"), 1);
    } finally {
      database.close();
    }
  });

  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      database.transaction((transaction) =>
        transaction.run(
          `DELETE FROM bootstrap_publication_rows
            WHERE table_name = ? AND primary_key_json = ?`,
          ["endpoints", '["endpoint-v1"]'],
        ),
      );
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("missing-provenance"),
      });
      await assert.rejects(
        trust.authentication.authenticate(
          trust.connectionIssuer.issueAcceptedConnection(),
        ),
        LocalAuthenticationStateError,
      );
      assert.equal(count(database, "endpoints"), 1);
      assert.equal(count(database, "authentication_requests"), 0);
      assert.equal(count(database, "audit_envelopes"), 1);
    } finally {
      database.close();
    }
  });

  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("unpublished"),
      });
      await assert.rejects(
        trust.authentication.authenticate(
          trust.connectionIssuer.issueAcceptedConnection(),
        ),
        LocalAuthenticationStateError,
      );
      assert.equal(count(database, "authentication_requests"), 0);
      assert.equal(count(database, "audit_envelopes"), 0);
    } finally {
      database.close();
    }
  });
});

test("local authentication rejects ambiguous binding state without recording a decision", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      database.transaction((transaction) =>
        transaction.run(
          `INSERT INTO identity_bindings (
            id, installation_id, principal_id, source_kind,
            local_host_id, subject_id, state, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "ambiguous-binding-v1",
            "installation-v1",
            "owner-v1",
            "local-peer",
            "local-host-v1",
            "ambiguous-subject-v1",
            "active",
            "2026-07-29T12:02:00.000Z",
          ],
        ),
      );
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("ambiguous"),
      });
      await assert.rejects(
        trust.authentication.authenticate(
          trust.connectionIssuer.issueAcceptedConnection(),
        ),
        LocalAuthenticationStateError,
      );
      assert.equal(count(database, "authentication_requests"), 0);
      assert.equal(count(database, "audit_envelopes"), 1);
    } finally {
      database.close();
    }
  });
});

test("one accepted connection cannot authenticate concurrently twice", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      await publish(database);
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("concurrent"),
      });
      const connection =
        trust.connectionIssuer.issueAcceptedConnection();
      const results = await Promise.allSettled([
        trust.authentication.authenticate(connection),
        trust.authentication.authenticate(connection),
      ]);
      assert.equal(
        results.filter(
          (result) =>
            result.status === "fulfilled" &&
            result.value.status === "authenticated",
        ).length,
        1,
      );
      const rejected = results.find(
        (result) => result.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(rejected.reason instanceof LocalConnectorTrustError);
      assert.equal(count(database, "authentication_requests"), 1);
      assert.equal(count(database, "audit_envelopes"), 2);
    } finally {
      database.close();
    }
  });
});

test("local authentication transaction rolls back before commit and records post-commit uncertainty", async () => {
  await withDisposableDataRoot(async (root) => {
    const faults = new DeterministicTransactionFaults();
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("before"),
      transactionFaults: faults,
    });
    try {
      await publish(database);
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("before"),
      });
      faults.failNext("before-commit");
      await assert.rejects(
        trust.authentication.authenticate(
          trust.connectionIssuer.issueAcceptedConnection(),
        ),
        (error: unknown) =>
          error instanceof TransactionBoundaryFaultError &&
          error.boundary === "before-commit",
      );
      assert.equal(count(database, "authentication_requests"), 0);
      assert.equal(count(database, "audit_envelopes"), 1);

      const retry = await trust.authentication.authenticate(
        trust.connectionIssuer.issueAcceptedConnection(),
      );
      assert.equal(retry.status, "authenticated");
      if (retry.status === "authenticated") {
        assert.equal(
          retry.context.actor.requestId,
          "before:AuthenticationRequest:0002",
        );
        assert.equal(trust.contextVerifier.isAuthentic(retry.context), true);
      }
      assert.equal(count(database, "authentication_requests"), 1);
      assert.equal(count(database, "audit_envelopes"), 2);
    } finally {
      database.close();
    }
  });

  await withDisposableDataRoot(async (root) => {
    const faults = new DeterministicTransactionFaults();
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("after"),
      transactionFaults: faults,
    });
    try {
      await publish(database);
      const trust = createLocalConnectorAuthentication({
        database,
        clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
        ids: new DeterministicIdSource("after"),
      });
      const connection =
        trust.connectionIssuer.issueAcceptedConnection();
      faults.failNext("after-commit");
      await assert.rejects(
        trust.authentication.authenticate(connection),
        (error: unknown) =>
          error instanceof TransactionBoundaryFaultError &&
          error.boundary === "after-commit",
      );
      assert.equal(count(database, "authentication_requests"), 1);
      assert.equal(count(database, "audit_envelopes"), 2);
      await assert.rejects(
        trust.authentication.authenticate(connection),
        LocalConnectorTrustError,
      );
    } finally {
      database.close();
    }
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import { insertAuditEnvelope } from "./audit-repository.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "./bootstrap-publication.js";
import { openCanonicalHitchV2Database } from "./initialize.js";

test("audit repository maps identity and grant correlations exactly", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const ids = new DeterministicIdSource("audit");
      const clock = new DeterministicClock(
        "2026-07-29T12:03:00.000Z",
      );
      await new SQLiteBootstrapPublicationUnitOfWork({
        database,
        ids,
        clock,
      }).publishBootstrap(records);

      const envelopes = database.transaction((transaction) => [
        insertAuditEnvelope(transaction, {
          id: ids.next("AuditEnvelope"),
          installationId: records.installation.id,
          actor: {
            kind: "principal",
            principalId: records.owner.id,
          },
          outcome: "succeeded",
          action: "identity-binding-state-changed",
          identityBindingId: records.localIdentityBinding.id,
          occurredAt: clock.now(),
        }),
        insertAuditEnvelope(transaction, {
          id: ids.next("AuditEnvelope"),
          installationId: records.installation.id,
          actor: { kind: "system", component: "authorization" },
          outcome: "denied",
          action: "configuration-grant-state-changed",
          accessGrantId: records.accessGrants[0]!.id,
          occurredAt: clock.now(),
        }),
      ]);
      const identityEnvelope = envelopes[0];
      const grantEnvelope = envelopes[1];
      assert.ok(identityEnvelope);
      assert.ok(grantEnvelope);
      assert.equal(identityEnvelope.action, "identity-binding-state-changed");
      assert.equal(grantEnvelope.action, "configuration-grant-state-changed");
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT actor_kind, actor_principal_id, system_component,
              outcome, action, identity_binding_id, access_grant_id
            FROM audit_envelopes
            WHERE action != 'installation-published'
            ORDER BY id`,
          ),
        ),
        [
          {
            actor_kind: "principal",
            actor_principal_id: records.owner.id,
            system_component: null,
            outcome: "succeeded",
            action: "identity-binding-state-changed",
            identity_binding_id: records.localIdentityBinding.id,
            access_grant_id: null,
          },
          {
            actor_kind: "system",
            actor_principal_id: null,
            system_component: "authorization",
            outcome: "denied",
            action: "configuration-grant-state-changed",
            identity_binding_id: null,
            access_grant_id: records.accessGrants[0]!.id,
          },
        ],
      );

      assert.throws(() =>
        database.transaction((transaction) => {
          insertAuditEnvelope(transaction, {
            id: ids.next("AuditEnvelope"),
            installationId: records.installation.id,
            actor: { kind: "bootstrap" },
            outcome: "succeeded",
            action: "installation-published",
            occurredAt: clock.now(),
          });
          throw new Error("force caller transaction rollback");
        }),
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            "SELECT COUNT(*) AS count FROM audit_envelopes",
          ),
        )?.count,
        3,
      );
    } finally {
      database.close();
    }
  });
});

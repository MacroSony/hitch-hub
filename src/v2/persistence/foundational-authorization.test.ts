import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFirstSliceAuthorizationTrust,
  type FirstSliceAuthorizationTrust,
} from "../application/authorization-contexts.js";
import type { AuthenticatedConnectorContext } from "../model/application.js";
import type {
  InstallationRole,
  SessionConfigurationResourceRef,
  SessionConfigurationUseGrant,
} from "../model/identity-access.js";
import type { AgentProfileId } from "../model/primitives.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "./bootstrap-publication.js";
import type { V2Database } from "./database.js";
import {
  FoundationalAuthorizationInputError,
  FoundationalAuthorizationIntegrityError,
  SQLiteFoundationalAuthorizationReads,
  UntrustedAuthorizationContextError,
  type LiveConnectorIdentity,
} from "./foundational-authorization.js";
import { openCanonicalHitchV2Database } from "./initialize.js";

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

function revoke(
  database: V2Database,
  table: "access_grants" | "provider_credential_bindings",
  id: string,
): void {
  database.transaction((transaction) =>
    transaction.run(
      `UPDATE "${table}"
        SET state = 'revoked',
          revoked_at = ?,
          revoked_actor_kind = 'system',
          revoked_actor_system_component = 'authorization'
        WHERE id = ?`,
      ["2026-07-29T12:04:00.000Z", id],
    ),
  );
}

test("foundational reads resolve live identity, roles, references, and exact configuration grants", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const reads = new SQLiteFoundationalAuthorizationReads({
        contextVerifier: trust.contextVerifier,
      });
      database.transaction((transaction) => {
        const identity = reads.readLiveConnectorIdentity(
          transaction,
          context,
        );
        assert.deepEqual(identity, {
          status: "active",
          installationId: records.installation.id,
          principalId: records.owner.id,
          identityBindingId: records.localIdentityBinding.id,
          endpointId: records.localEndpoint.id,
          authenticationRequestId:
            "authorization:AuthenticationRequest:0001",
        });
        assert.ok(Object.isFrozen(identity));
        if (identity.status !== "active") return;

        assert.deepEqual(
          reads.readInstallationRole(transaction, identity, "admin"),
          { status: "active", grantId: "role-grant-v1" },
        );
        assert.deepEqual(
          reads.readInstallationRole(
            transaction,
            identity,
            "member" as InstallationRole,
          ),
          { status: "absent" },
        );
        assert.deepEqual(
          reads.resolveProfileReference(
            transaction,
            identity,
            records.agentProfile.reference,
          ),
          { status: "resolved", profileId: records.agentProfile.id },
        );
        assert.deepEqual(
          reads.resolveWorkspaceReference(
            transaction,
            identity,
            records.workspace.reference,
          ),
          { status: "resolved", workspaceId: records.workspace.id },
        );
        assert.deepEqual(
          reads.resolveProfileReference(
            transaction,
            identity,
            "missing-profile",
          ),
          { status: "not-found" },
        );
        assert.throws(
          () =>
            reads.resolveWorkspaceReference(
              transaction,
              identity,
              "../unsafe",
            ),
          FoundationalAuthorizationInputError,
        );

        for (const grant of records.accessGrants) {
          if (grant.kind !== "session-configuration-use") continue;
          const result = reads.readConfigurationUse(
            transaction,
            identity,
            grant.resource,
          );
          assert.deepEqual(result, {
            status: "active",
            grantId: grant.id,
          });
          assert.ok(Object.isFrozen(result));
        }
        assert.deepEqual(
          reads.readConfigurationUse(transaction, identity, {
            kind: "agent-profile",
            id: "missing-profile-v1" as AgentProfileId,
          }),
          { status: "absent" },
        );
      });
    } finally {
      database.close();
    }
  });
});

test("foundational reads reject forged, service, foreign, and cross-transaction authority", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { trust, context } = await publishAndAuthenticate(database);
      const reads = new SQLiteFoundationalAuthorizationReads({
        contextVerifier: trust.contextVerifier,
      });
      const foreignReads = new SQLiteFoundationalAuthorizationReads({
        contextVerifier: trust.contextVerifier,
      });
      const service =
        await trust.serviceContextIssuer.forComponent("broker");
      let retainedIdentity: LiveConnectorIdentity | undefined;
      database.transaction((transaction) => {
        assert.throws(
          () =>
            reads.readLiveConnectorIdentity(
              transaction,
              structuredClone(context),
            ),
          UntrustedAuthorizationContextError,
        );
        assert.throws(
          () => reads.readLiveConnectorIdentity(transaction, service),
          UntrustedAuthorizationContextError,
        );
        const identity = reads.readLiveConnectorIdentity(
          transaction,
          context,
        );
        assert.equal(identity.status, "active");
        if (identity.status !== "active") return;
        retainedIdentity = identity;
        assert.throws(
          () =>
            foreignReads.readInstallationRole(
              transaction,
              identity,
              "admin",
            ),
          UntrustedAuthorizationContextError,
        );
      });
      assert.ok(retainedIdentity);
      database.transaction((transaction) => {
        assert.throws(
          () =>
            reads.readInstallationRole(
              transaction,
              retainedIdentity!,
              "admin",
            ),
          UntrustedAuthorizationContextError,
        );
      });
    } finally {
      database.close();
    }
  });
});

test("minted connector identity immediately reflects principal, binding, and endpoint loss", async () => {
  const cases = [
    {
      name: "principal-disabled",
      expected: "principal-disabled",
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
      name: "binding-revoked",
      expected: "binding-inactive",
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
    {
      name: "endpoint-mismatch",
      expected: "binding-inactive",
      mutate(database: V2Database): void {
        database.transaction((transaction) => {
          transaction.run(
            `INSERT INTO local_hosts (id, installation_id, created_at)
              VALUES (?, ?, ?)`,
            [
              "foreign-local-host-v1",
              "installation-v1",
              "2026-07-29T12:04:00.000Z",
            ],
          );
          transaction.run(
            "UPDATE endpoints SET local_host_id = ? WHERE id = ?",
            ["foreign-local-host-v1", "endpoint-v1"],
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
        const { trust, context } = await publishAndAuthenticate(database);
        scenario.mutate(database);
        const reads = new SQLiteFoundationalAuthorizationReads({
          contextVerifier: trust.contextVerifier,
        });
        assert.deepEqual(
          database.transaction((transaction) =>
            reads.readLiveConnectorIdentity(transaction, context),
          ),
          {
            status: "denied",
            installationId: "installation-v1",
            reason: scenario.expected,
          },
        );
      } finally {
        database.close();
      }
    });
  }
});

test("role and configuration-use reads distinguish revoked, absent, and resource-revoked authority", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const records = createBootstrapPublicationRecords();
      const { trust, context } = await publishAndAuthenticate(database);
      const workspaceGrant = records.accessGrants.find(
        (grant): grant is SessionConfigurationUseGrant =>
          grant.kind === "session-configuration-use" &&
          grant.resource.kind === "workspace",
      );
      const credentialGrant = records.accessGrants.find(
        (grant): grant is SessionConfigurationUseGrant =>
          grant.kind === "session-configuration-use" &&
          grant.resource.kind === "provider-credential-binding",
      );
      assert.ok(workspaceGrant);
      assert.ok(credentialGrant);
      revoke(database, "access_grants", "role-grant-v1");
      revoke(database, "access_grants", workspaceGrant.id);
      revoke(
        database,
        "provider_credential_bindings",
        records.providerCredentialBinding.id,
      );
      const reads = new SQLiteFoundationalAuthorizationReads({
        contextVerifier: trust.contextVerifier,
      });
      database.transaction((transaction) => {
        const identity = reads.readLiveConnectorIdentity(
          transaction,
          context,
        );
        assert.equal(identity.status, "active");
        if (identity.status !== "active") return;
        assert.deepEqual(
          reads.readInstallationRole(transaction, identity, "admin"),
          { status: "revoked", grantId: "role-grant-v1" },
        );
        assert.deepEqual(
          reads.readConfigurationUse(
            transaction,
            identity,
            workspaceGrant.resource,
          ),
          {
            status: "revoked",
            cause: "grant-revoked",
            grantId: workspaceGrant.id,
          },
        );
        assert.deepEqual(
          reads.readConfigurationUse(
            transaction,
            identity,
            credentialGrant.resource,
          ),
          {
            status: "revoked",
            cause: "resource-revoked",
            grantId: credentialGrant.id,
          },
        );
      });
    } finally {
      database.close();
    }
  });
});

test("foundational reads fail closed on ambiguous or unproven grant state", async () => {
  const scenarios = [
    {
      name: "ambiguous",
      mutate(database: V2Database, resource: SessionConfigurationResourceRef): void {
        database.transaction((transaction) =>
          transaction.run(
            `INSERT INTO access_grants (
              id, kind, installation_id, principal_id, role,
              resource_kind, resource_id, granted_actor_kind,
              created_at, state, revoked_at, revoked_actor_kind,
              revoked_actor_system_component
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              "duplicate-workspace-grant-v1",
              "session-configuration-use",
              "installation-v1",
              "owner-v1",
              null,
              resource.kind,
              resource.id,
              "bootstrap",
              "2026-07-29T12:04:00.000Z",
              "revoked",
              "2026-07-29T12:04:00.000Z",
              "system",
              "authorization",
            ],
          ),
        );
      },
    },
    {
      name: "unproven",
      mutate(database: V2Database, _resource: SessionConfigurationResourceRef): void {
        database.transaction((transaction) =>
          transaction.run(
            `DELETE FROM bootstrap_publication_rows
              WHERE table_name = 'access_grants'
                AND primary_key_json = ?`,
            ['["grant-workspace-v1"]'],
          ),
        );
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    await withDisposableDataRoot(async (root) => {
      const database = openCanonicalHitchV2Database({
        dataRoot: root.resolve(`state-${scenario.name}`),
      });
      try {
        const records = createBootstrapPublicationRecords();
        const { trust, context } = await publishAndAuthenticate(database);
        const workspaceGrant = records.accessGrants.find(
          (grant): grant is SessionConfigurationUseGrant =>
            grant.kind === "session-configuration-use" &&
            grant.resource.kind === "workspace",
        );
        assert.ok(workspaceGrant);
        scenario.mutate(database, workspaceGrant.resource);
        const reads = new SQLiteFoundationalAuthorizationReads({
          contextVerifier: trust.contextVerifier,
        });
        assert.throws(
          () =>
            database.transaction((transaction) => {
              const identity = reads.readLiveConnectorIdentity(
                transaction,
                context,
              );
              assert.equal(identity.status, "active");
              if (identity.status !== "active") return;
              reads.readConfigurationUse(
                transaction,
                identity,
                workspaceGrant.resource,
              );
            }),
          FoundationalAuthorizationIntegrityError,
        );
      } finally {
        database.close();
      }
    });
  }
});

test("foundational identity requires exactly one successful authentication audit", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { trust, context } = await publishAndAuthenticate(database);
      database.transaction((transaction) =>
        transaction.run(
          `DELETE FROM audit_envelopes
            WHERE action = 'authentication-recorded'
              AND authentication_request_id = ?`,
          [context.actor.requestId],
        ),
      );
      const reads = new SQLiteFoundationalAuthorizationReads({
        contextVerifier: trust.contextVerifier,
      });
      assert.throws(
        () =>
          database.transaction((transaction) =>
            reads.readLiveConnectorIdentity(transaction, context),
          ),
        FoundationalAuthorizationIntegrityError,
      );
    } finally {
      database.close();
    }
  });
});

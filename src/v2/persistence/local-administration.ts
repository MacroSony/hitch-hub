import { lstatSync, realpathSync } from "node:fs";

import {
  decodeClientCertificateTrustRootId,
  decodeServiceId,
} from "../codecs/primitives.js";
import {
  ClientCertificatePolicyError,
  inspectMvpClientCertificate,
} from "../connectors/remote/certificate-verification.js";
import type {
  AuthenticatedConnectorContext,
  Clock,
  IdSource,
  LocalAdministrationCommand,
  LocalAdministrationPort,
  LocalAdministrationResponse,
} from "../model/application.js";
import type {
  ClientCertificateTrustRootId,
  IdentityBindingId,
  PrincipalId,
} from "../model/primitives.js";
import type { TrustedAuthorizationContextVerifier } from "../application/authorization-contexts.js";
import { insertAuditEnvelope } from "./audit-repository.js";
import type {
  SQLiteBindValue,
  SQLiteRow,
  V2Database,
  V2RepositoryTransaction,
} from "./database.js";
import {
  SQLiteFoundationalAuthorizationReads,
  type LiveConnectorIdentity,
} from "./foundational-authorization.js";

export interface SQLiteLocalAdministrationOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
  readonly clientCertificateTrustRootId: string;
}

export class LocalAdministrationStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalAdministrationStateError";
  }
}

function inserted(
  transaction: V2RepositoryTransaction,
  sql: string,
  values: readonly SQLiteBindValue[],
  label: string,
): void {
  if (transaction.run(sql, values).changes !== 1) {
    throw new LocalAdministrationStateError(
      `${label} did not change exactly one row`,
    );
  }
}

function requiredText(row: SQLiteRow, column: string, label: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new LocalAdministrationStateError(`durable ${label} is invalid`);
  }
  return value;
}

function canonicalWorkspaceDirectory(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      throw new LocalAdministrationStateError(
        "workspace root must be an existing canonical directory, never a symlink",
      );
    }
    return path;
  } catch (error) {
    if (error instanceof LocalAdministrationStateError) throw error;
    throw new LocalAdministrationStateError(
      "unable to inspect the administrator-provisioned workspace root",
      { cause: error },
    );
  }
}

function rejected(
  code: Extract<
    LocalAdministrationResponse,
    { readonly status: "rejected" }
  >["code"],
): LocalAdministrationResponse {
  return Object.freeze({ status: "rejected" as const, code });
}

function succeeded(
  result: Extract<
    LocalAdministrationResponse,
    { readonly status: "succeeded" }
  >["result"],
): LocalAdministrationResponse {
  return Object.freeze({ status: "succeeded" as const, result });
}

/** One atomic implementation of the four local-only MVP administration commands. */
export class SQLiteLocalAdministration implements LocalAdministrationPort {
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #contextVerifier: TrustedAuthorizationContextVerifier;
  readonly #authorization: SQLiteFoundationalAuthorizationReads;
  readonly #trustRootId: ClientCertificateTrustRootId;

  constructor(options: SQLiteLocalAdministrationOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#contextVerifier = options.contextVerifier;
    this.#authorization = new SQLiteFoundationalAuthorizationReads({
      contextVerifier: options.contextVerifier,
    });
    this.#trustRootId = decodeClientCertificateTrustRootId(
      options.clientCertificateTrustRootId,
    );
  }

  async execute(
    context: AuthenticatedConnectorContext,
    command: LocalAdministrationCommand,
  ): Promise<LocalAdministrationResponse> {
    switch (command.kind) {
      case "create-principal": {
        let workspaceRoot: string;
        try {
          workspaceRoot = canonicalWorkspaceDirectory(
            command.canonicalWorkspaceRoot,
          );
        } catch (error) {
          if (error instanceof LocalAdministrationStateError) {
            return rejected("invalid-request");
          }
          throw error;
        }
        return this.#createPrincipal(context, command, workspaceRoot);
      }
      case "disable-principal":
        return this.#disablePrincipal(context, command.principalReference);
      case "bind-client-certificate": {
        let fingerprint;
        try {
          ({ fingerprint } = inspectMvpClientCertificate({
            completeDer: command.completeDer,
            clock: this.#clock,
          }));
        } catch (error) {
          if (error instanceof ClientCertificatePolicyError) {
            return rejected("invalid-request");
          }
          throw error;
        }
        return this.#bindCertificate(
          context,
          command.principalReference,
          command.bindingReference,
          fingerprint,
        );
      }
      case "revoke-client-certificate":
        return this.#revokeCertificate(context, command.bindingReference);
    }
  }

  #authorizedAdministrator(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
  ): LiveConnectorIdentity | undefined {
    const classified = this.#contextVerifier.classify(context);
    if (
      classified?.kind !== "connector" ||
      classified.context.actor.method !== "local-peer" ||
      classified.context.actor.assurance !== "elevated"
    ) {
      return undefined;
    }
    const identity = this.#authorization.readLiveConnectorIdentity(
      transaction,
      context,
    );
    if (identity.status !== "active") return undefined;
    const role = this.#authorization.readInstallationRole(
      transaction,
      identity,
      "admin",
    );
    return role.status === "active" ? identity : undefined;
  }

  #createPrincipal(
    context: AuthenticatedConnectorContext,
    command: Extract<LocalAdministrationCommand, { readonly kind: "create-principal" }>,
    workspaceRoot: string,
  ): LocalAdministrationResponse {
    const now = this.#clock.now();
    const principalId = decodeServiceId(
      "Principal",
      this.#ids.next("Principal"),
    );
    const workspaceId = decodeServiceId(
      "Workspace",
      this.#ids.next("Workspace"),
    );
    const workspaceRevisionId = decodeServiceId(
      "WorkspaceRevision",
      this.#ids.next("WorkspaceRevision"),
    );
    const workspaceResourceId = decodeServiceId(
      "WorkspaceResource",
      this.#ids.next("WorkspaceResource"),
    );
    const roleGrantId = decodeServiceId(
      "AccessGrant",
      this.#ids.next("AccessGrant"),
    );
    const workspaceGrantId = decodeServiceId(
      "AccessGrant",
      this.#ids.next("AccessGrant"),
    );
    const auditId = decodeServiceId(
      "AuditEnvelope",
      this.#ids.next("AuditEnvelope"),
    );

    return this.#database.transaction((transaction) => {
      const administrator = this.#authorizedAdministrator(transaction, context);
      if (administrator === undefined) return rejected("not-authorized");
      const conflict = transaction.get(
        `SELECT 1 AS present
        FROM principal_reference_bindings
        WHERE installation_id = ? AND reference = ?
        UNION ALL
        SELECT 1 AS present FROM workspaces
        WHERE installation_id = ? AND reference = ?
        UNION ALL
        SELECT 1 AS present FROM workspace_resources
        WHERE installation_id = ? AND canonical_host_path = ?
        LIMIT 1`,
        [
          administrator.installationId,
          command.principalReference,
          administrator.installationId,
          command.workspaceReference,
          administrator.installationId,
          workspaceRoot,
        ],
      );
      if (conflict !== undefined) return rejected("conflict");

      inserted(
        transaction,
        `INSERT INTO principals (
          id, installation_id, kind, display_name, state, created_at
        ) VALUES (?, ?, 'human', ?, 'active', ?)`,
        [principalId, administrator.installationId, command.displayName, now],
        "principal create",
      );
      inserted(
        transaction,
        `INSERT INTO principal_reference_bindings (
          principal_id, installation_id, reference
        ) VALUES (?, ?, ?)`,
        [principalId, administrator.installationId, command.principalReference],
        "principal reference create",
      );
      inserted(
        transaction,
        `INSERT INTO principal_execution_capacity (
          principal_id, next_admission_ordinal, active_turn_id, updated_at
        ) VALUES (?, 0, NULL, ?)`,
        [principalId, now],
        "principal capacity create",
      );
      inserted(
        transaction,
        `INSERT INTO workspaces (
          id, installation_id, reference, display_name, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          workspaceId,
          administrator.installationId,
          command.workspaceReference,
          `${command.displayName} workspace`,
          now,
        ],
        "workspace create",
      );
      inserted(
        transaction,
        `INSERT INTO principal_workspace_bindings (
          principal_id, installation_id, workspace_id, created_actor_kind,
          created_actor_principal_id, created_at
        ) VALUES (?, ?, ?, 'principal', ?, ?)`,
        [
          principalId,
          administrator.installationId,
          workspaceId,
          administrator.principalId,
          now,
        ],
        "principal workspace bind",
      );
      inserted(
        transaction,
        `INSERT INTO workspace_resources (
          id, installation_id, canonical_host_path, sandbox_path,
          maximum_access, created_at
        ) VALUES (?, ?, ?, '/workspace', 'read-write', ?)`,
        [workspaceResourceId, administrator.installationId, workspaceRoot, now],
        "workspace resource create",
      );
      inserted(
        transaction,
        `INSERT INTO workspace_revisions (
          id, workspace_id, revision, display_name, created_at
        ) VALUES (?, ?, 1, ?, ?)`,
        [
          workspaceRevisionId,
          workspaceId,
          `${command.displayName} workspace v1`,
          now,
        ],
        "workspace revision create",
      );
      inserted(
        transaction,
        `INSERT INTO workspace_revision_resources (
          workspace_revision_id, workspace_resource_id, ordinal, role
        ) VALUES (?, ?, 0, 'root')`,
        [workspaceRevisionId, workspaceResourceId],
        "workspace revision root create",
      );
      inserted(
        transaction,
        `INSERT INTO workspace_reference_bindings (
          workspace_id, workspace_revision_id, installation_id,
          binding_reference
        ) VALUES (?, ?, ?, ?)`,
        [
          workspaceId,
          workspaceRevisionId,
          administrator.installationId,
          command.workspaceReference,
        ],
        "workspace reference create",
      );
      this.#insertGrant(
        transaction,
        roleGrantId,
        administrator,
        principalId,
        now,
        { kind: "installation-role", role: command.role },
      );
      this.#insertGrant(
        transaction,
        workspaceGrantId,
        administrator,
        principalId,
        now,
        { kind: "resource", resourceKind: "workspace", resourceId: workspaceId },
      );

      const shared = transaction.all(
        `SELECT resource_kind, resource_id
        FROM access_grants
        WHERE kind = 'session-configuration-use'
          AND installation_id = ?
          AND principal_id = ?
          AND state = 'active'
          AND resource_kind != 'workspace'
        ORDER BY resource_kind, resource_id`,
        [administrator.installationId, administrator.principalId],
      );
      for (const row of shared) {
        const resourceKind = requiredText(
          row,
          "resource_kind",
          "shared configuration resource kind",
        );
        const resourceId = requiredText(
          row,
          "resource_id",
          "shared configuration resource identifier",
        );
        this.#insertGrant(
          transaction,
          decodeServiceId("AccessGrant", this.#ids.next("AccessGrant")),
          administrator,
          principalId,
          now,
          { kind: "resource", resourceKind, resourceId },
        );
      }

      const executionSnapshots = transaction.all(
        `SELECT snapshots.id
        FROM access_grants AS grants
        JOIN execution_policy_snapshots AS snapshots
          ON snapshots.policy_id = grants.resource_id
        WHERE grants.kind = 'session-configuration-use'
          AND grants.installation_id = ?
          AND grants.principal_id = ?
          AND grants.resource_kind = 'execution-policy'
          AND grants.state = 'active'
          AND snapshots.revision = (
            SELECT MAX(current.revision)
            FROM execution_policy_snapshots AS current
            WHERE current.policy_id = snapshots.policy_id
          )`,
        [administrator.installationId, administrator.principalId],
      );
      if (executionSnapshots.length !== 1) {
        throw new LocalAdministrationStateError(
          "administrator execution policy snapshot is missing or ambiguous",
        );
      }
      inserted(
        transaction,
        `INSERT INTO execution_policy_resource_grants (
          execution_policy_snapshot_id, workspace_resource_id, access
        ) VALUES (?, ?, 'read-write')`,
        [
          requiredText(
            executionSnapshots[0]!,
            "id",
            "execution policy snapshot identifier",
          ),
          workspaceResourceId,
        ],
        "workspace execution grant create",
      );
      insertAuditEnvelope(transaction, {
        id: auditId,
        installationId: administrator.installationId,
        actor: { kind: "principal", principalId: administrator.principalId },
        outcome: "succeeded",
        action: "principal-created",
        subjectPrincipalId: principalId,
        occurredAt: now,
      });
      return succeeded({ kind: "principal-created", principalId, workspaceId });
    });
  }

  #insertGrant(
    transaction: V2RepositoryTransaction,
    grantId: string,
    administrator: LiveConnectorIdentity,
    principalId: PrincipalId,
    now: ReturnType<Clock["now"]>,
    target:
      | { readonly kind: "installation-role"; readonly role: "admin" | "member" }
      | {
          readonly kind: "resource";
          readonly resourceKind: string;
          readonly resourceId: string;
        },
  ): void {
    inserted(
      transaction,
      `INSERT INTO access_grants (
        id, kind, installation_id, principal_id, role, resource_kind,
        resource_id, granted_actor_kind, granted_actor_principal_id,
        created_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'principal', ?, ?, 'active')`,
      [
        grantId,
        target.kind === "installation-role"
          ? "installation-role"
          : "session-configuration-use",
        administrator.installationId,
        principalId,
        target.kind === "installation-role" ? target.role : null,
        target.kind === "resource" ? target.resourceKind : null,
        target.kind === "resource" ? target.resourceId : null,
        administrator.principalId,
        now,
      ],
      "access grant create",
    );
  }

  #disablePrincipal(
    context: AuthenticatedConnectorContext,
    reference: string,
  ): LocalAdministrationResponse {
    const now = this.#clock.now();
    const auditId = decodeServiceId(
      "AuditEnvelope",
      this.#ids.next("AuditEnvelope"),
    );
    return this.#database.transaction((transaction) => {
      const administrator = this.#authorizedAdministrator(transaction, context);
      if (administrator === undefined) return rejected("not-authorized");
      const rows = transaction.all(
        `SELECT principals.id, principals.state
        FROM principal_reference_bindings AS refs
        JOIN principals ON principals.id = refs.principal_id
        WHERE refs.installation_id = ? AND refs.reference = ?`,
        [administrator.installationId, reference],
      );
      if (rows.length === 0) return rejected("not-found");
      if (rows.length !== 1) {
        throw new LocalAdministrationStateError(
          "principal reference is ambiguous",
        );
      }
      const principalId = decodeServiceId(
        "Principal",
        requiredText(rows[0]!, "id", "principal identifier"),
      );
      if (principalId === administrator.principalId) return rejected("conflict");
      const state = requiredText(rows[0]!, "state", "principal state");
      if (state === "disabled") {
        return succeeded({ kind: "principal-already-disabled", principalId });
      }
      if (state !== "active") {
        throw new LocalAdministrationStateError(
          "principal state is unsupported",
        );
      }
      inserted(
        transaction,
        `UPDATE principals SET state = 'disabled', disabled_at = ?,
          disabled_actor_kind = 'principal', disabled_actor_principal_id = ?
        WHERE id = ? AND installation_id = ? AND state = 'active'`,
        [
          now,
          administrator.principalId,
          principalId,
          administrator.installationId,
        ],
        "principal disable",
      );
      insertAuditEnvelope(transaction, {
        id: auditId,
        installationId: administrator.installationId,
        actor: { kind: "principal", principalId: administrator.principalId },
        outcome: "succeeded",
        action: "principal-state-changed",
        subjectPrincipalId: principalId,
        occurredAt: now,
      });
      return succeeded({ kind: "principal-disabled", principalId });
    });
  }

  #bindCertificate(
    context: AuthenticatedConnectorContext,
    principalReference: string,
    bindingReference: string,
    fingerprint: ReturnType<typeof inspectMvpClientCertificate>["fingerprint"],
  ): LocalAdministrationResponse {
    const now = this.#clock.now();
    const identityBindingId = decodeServiceId(
      "IdentityBinding",
      this.#ids.next("IdentityBinding"),
    );
    const endpointId = decodeServiceId("Endpoint", this.#ids.next("Endpoint"));
    const auditId = decodeServiceId(
      "AuditEnvelope",
      this.#ids.next("AuditEnvelope"),
    );
    return this.#database.transaction((transaction) => {
      const administrator = this.#authorizedAdministrator(transaction, context);
      if (administrator === undefined) return rejected("not-authorized");
      const principalRows = transaction.all(
        `SELECT principals.id, principals.state
        FROM principal_reference_bindings AS refs
        JOIN principals ON principals.id = refs.principal_id
        WHERE refs.installation_id = ? AND refs.reference = ?`,
        [administrator.installationId, principalReference],
      );
      if (principalRows.length === 0) return rejected("not-found");
      if (principalRows.length !== 1) {
        throw new LocalAdministrationStateError(
          "principal reference is ambiguous",
        );
      }
      const principalId = decodeServiceId(
        "Principal",
        requiredText(principalRows[0]!, "id", "principal identifier"),
      );
      if (principalRows[0]!.state !== "active") return rejected("conflict");
      const conflict = transaction.get(
        `SELECT 1 AS present FROM identity_binding_reference_bindings
        WHERE installation_id = ? AND reference = ?
        UNION ALL
        SELECT 1 AS present FROM identity_bindings
        WHERE installation_id = ? AND source_kind = 'mtls-client'
          AND subject_id = ? AND state = 'active'
        LIMIT 1`,
        [
          administrator.installationId,
          bindingReference,
          administrator.installationId,
          fingerprint,
        ],
      );
      if (conflict !== undefined) return rejected("conflict");
      inserted(
        transaction,
        `INSERT INTO identity_bindings (
          id, installation_id, principal_id, source_kind,
          client_trust_root_id, subject_id, state, created_at
        ) VALUES (?, ?, ?, 'mtls-client', ?, ?, 'active', ?)`,
        [
          identityBindingId,
          administrator.installationId,
          principalId,
          this.#trustRootId,
          fingerprint,
          now,
        ],
        "client certificate binding create",
      );
      inserted(
        transaction,
        `INSERT INTO identity_binding_reference_bindings (
          identity_binding_id, installation_id, reference
        ) VALUES (?, ?, ?)`,
        [identityBindingId, administrator.installationId, bindingReference],
        "client certificate binding reference create",
      );
      inserted(
        transaction,
        `INSERT INTO endpoints (
          id, installation_id, address_kind, identity_binding_id,
          identity_binding_source_kind, audience_kind,
          audience_principal_id, created_at
        ) VALUES (?, ?, 'remote-client', ?, 'mtls-client', 'private', ?, ?)`,
        [
          endpointId,
          administrator.installationId,
          identityBindingId,
          principalId,
          now,
        ],
        "remote client endpoint create",
      );
      insertAuditEnvelope(transaction, {
        id: auditId,
        installationId: administrator.installationId,
        actor: { kind: "principal", principalId: administrator.principalId },
        outcome: "succeeded",
        action: "identity-binding-state-changed",
        identityBindingId,
        occurredAt: now,
      });
      return succeeded({
        kind: "client-certificate-bound",
        principalId,
        identityBindingId,
        fingerprint,
      });
    });
  }

  #revokeCertificate(
    context: AuthenticatedConnectorContext,
    bindingReference: string,
  ): LocalAdministrationResponse {
    const now = this.#clock.now();
    const auditId = decodeServiceId(
      "AuditEnvelope",
      this.#ids.next("AuditEnvelope"),
    );
    return this.#database.transaction((transaction) => {
      const administrator = this.#authorizedAdministrator(transaction, context);
      if (administrator === undefined) return rejected("not-authorized");
      const rows = transaction.all(
        `SELECT bindings.id, bindings.state
        FROM identity_binding_reference_bindings AS refs
        JOIN identity_bindings AS bindings
          ON bindings.id = refs.identity_binding_id
        WHERE refs.installation_id = ? AND refs.reference = ?
          AND bindings.source_kind = 'mtls-client'`,
        [administrator.installationId, bindingReference],
      );
      if (rows.length === 0) return rejected("not-found");
      if (rows.length !== 1) {
        throw new LocalAdministrationStateError(
          "client certificate binding reference is ambiguous",
        );
      }
      const identityBindingId = decodeServiceId(
        "IdentityBinding",
        requiredText(rows[0]!, "id", "identity-binding identifier"),
      );
      const state = requiredText(rows[0]!, "state", "identity-binding state");
      if (state === "revoked") {
        return succeeded({
          kind: "client-certificate-already-revoked",
          identityBindingId,
        });
      }
      if (state !== "active") {
        throw new LocalAdministrationStateError(
          "identity-binding state is unsupported",
        );
      }
      inserted(
        transaction,
        `UPDATE identity_bindings SET state = 'revoked', revoked_at = ?,
          revoked_actor_kind = 'principal', revoked_actor_principal_id = ?
        WHERE id = ? AND installation_id = ? AND state = 'active'`,
        [
          now,
          administrator.principalId,
          identityBindingId,
          administrator.installationId,
        ],
        "client certificate binding revoke",
      );
      insertAuditEnvelope(transaction, {
        id: auditId,
        installationId: administrator.installationId,
        actor: { kind: "principal", principalId: administrator.principalId },
        outcome: "succeeded",
        action: "identity-binding-state-changed",
        identityBindingId,
        occurredAt: now,
      });
      return succeeded({
        kind: "client-certificate-revoked",
        identityBindingId,
      });
    });
  }
}

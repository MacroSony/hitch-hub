/**
 * V2-009A: live authorization, exact `SessionSpec` creation, and private
 * endpoint binding.
 *
 * One authoritative SQLite transaction resolves both stable references,
 * selects their current append-only revisions, rechecks every required
 * configuration-use grant against the same transaction view, pins the
 * SessionSpec, and creates the session, metadata, lifecycle, runtime, and
 * private binding rows with their audit evidence. Connector callers never
 * select a principal, endpoint, revision, grant, or authorization result.
 */

import { decodeServiceId } from "../codecs/primitives.js";
import type { TrustedAuthorizationContextVerifier } from "../application/authorization-contexts.js";
import type {
  AuditEnvelopeFor,
  AuthenticatedConnectorContext,
  Clock,
  IdSource,
  SessionCreationUnitOfWork,
} from "../model/application.js";
import type { SessionEndpointBinding } from "../model/endpoint-binding.js";
import type {
  SessionConfigurationResourceRef,
  SessionConfigurationUseGrant,
} from "../model/identity-access.js";
import type {
  AgentProfileRevisionId,
  AgentResourceSnapshotId,
  ExecutionPolicySnapshotId,
  ExtensionGrantSnapshotId,
  ExtensionId,
  ExecutionPolicyId,
  Id,
  InstallationId,
  ProviderCredentialBindingId,
  ProviderConnectionId,
  ProviderId,
  TurnPolicyId,
  TurnPolicySnapshotId,
  WorkspaceRevisionId,
} from "../model/primitives.js";
import type {
  Session,
  SessionLifecycle,
  SessionMetadata,
  SessionRuntimeState,
  SessionSpec,
} from "../model/session.js";
import { insertAuditEnvelope } from "./audit-repository.js";
import type {
  SQLiteBindValue,
  V2Database,
  V2RepositoryTransaction,
} from "./database.js";
import type { BootstrapFoundationTable } from "./foundation-rows.js";
import {
  assertPrincipalWorkspaceProvenance,
  assertPublishedRow,
  requiredText,
  SQLiteFoundationalAuthorizationReads,
  type LiveConnectorIdentity,
} from "./foundational-authorization.js";

export class SessionCreationIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionCreationIntegrityError";
  }
}

export class SessionCreationInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionCreationInputError";
  }
}

export interface SQLiteSessionCreationUnitOfWorkOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
}

type CreatePrivateSessionInput = Parameters<
  SessionCreationUnitOfWork["createPrivateSession"]
>[0];

type SessionCreationResult = Awaited<
  ReturnType<SessionCreationUnitOfWork["createPrivateSession"]>
>;

type SessionCreationDenial = Extract<
  SessionCreationResult,
  { readonly status: "denied" }
>;

type ConfigurationResourceKind =
  SessionConfigurationUseGrant["resource"]["kind"];

interface CurrentConfigurationSelection {
  readonly profileRevisionId: AgentProfileRevisionId;
  readonly workspaceRevisionId: WorkspaceRevisionId;
  readonly executionPolicySnapshotId: ExecutionPolicySnapshotId;
  readonly turnPolicySnapshotId: TurnPolicySnapshotId;
  readonly resourceSnapshotIds: readonly AgentResourceSnapshotId[];
  readonly extensionGrantSnapshotIds: readonly ExtensionGrantSnapshotId[];
  readonly providerId: ProviderId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly credentialBindingId: ProviderCredentialBindingId;
}

const DISPLAY_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const EMPTY_LABELS: readonly string[] = Object.freeze([]);

function decodeDisplayName(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    DISPLAY_NAME_CONTROL_CHARACTERS.test(input)
  ) {
    throw new SessionCreationInputError(
      "session display name must be 1-256 characters without control characters",
    );
  }
  return input;
}

export class SQLiteSessionCreationUnitOfWork
  implements SessionCreationUnitOfWork
{
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #reads: SQLiteFoundationalAuthorizationReads;

  constructor(options: SQLiteSessionCreationUnitOfWorkOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#reads = new SQLiteFoundationalAuthorizationReads({
      contextVerifier: options.contextVerifier,
    });
  }

  async createPrivateSession(
    input: CreatePrivateSessionInput,
  ): Promise<SessionCreationResult> {
    return this.#database.transaction((transaction) =>
      this.#create(transaction, input),
    );
  }

  #create(
    transaction: V2RepositoryTransaction,
    input: CreatePrivateSessionInput,
  ): SessionCreationResult {
    const identity = this.#reads.readLiveConnectorIdentity(
      transaction,
      input.context,
    );
    if (identity.status === "denied") {
      return this.#denied(
        transaction,
        input.context,
        identity.installationId,
        identity.reason,
      );
    }
    const displayName = decodeDisplayName(input.displayName);
    const installationId = identity.installationId;

    const profile = this.#reads.resolveProfileReference(
      transaction,
      identity,
      input.profileReference,
    );
    if (profile.status === "not-found") {
      return this.#notFound(
        transaction,
        input.context,
        installationId,
        "profile",
      );
    }
    const workspace = this.#reads.resolveWorkspaceReference(
      transaction,
      identity,
      input.workspaceReference,
    );
    if (workspace.status === "not-found") {
      return this.#notFound(
        transaction,
        input.context,
        installationId,
        "workspace",
      );
    }

    const selection = this.#selectCurrentConfiguration(
      transaction,
      identity,
      profile.profileId,
      workspace.workspaceId,
    );

    const useChecks: readonly SessionConfigurationResourceRef[] = [
      { kind: "agent-profile", id: profile.profileId },
      { kind: "workspace", id: workspace.workspaceId },
      {
        kind: "execution-policy",
        id: selection.executionPolicyId,
      },
      { kind: "turn-policy", id: selection.turnPolicyId },
      ...selection.extensionIds.map(
        (extensionId): SessionConfigurationResourceRef => ({
          kind: "extension",
          id: extensionId,
        }),
      ),
      {
        kind: "provider-credential-binding",
        id: selection.credentialBindingId,
      },
    ];
    for (const resource of useChecks) {
      const use = this.#reads.readConfigurationUse(
        transaction,
        identity,
        resource,
      );
      if (use.status !== "active") {
        return this.#denied(
          transaction,
          input.context,
          installationId,
          "required-configuration-use-revoked",
          resource.kind,
        );
      }
    }

    return this.#insertSession(
      transaction,
      identity,
      displayName,
      selection,
    );
  }

  /** Selects the current append-only revision of one published resource. */
  #currentRevision<Kind extends
    | "AgentProfileRevision"
    | "WorkspaceRevision"
    | "ExecutionPolicySnapshot"
    | "TurnPolicySnapshot">(
    transaction: V2RepositoryTransaction,
    installationId: InstallationId,
    table: BootstrapFoundationTable,
    ownerColumn: string,
    ownerId: string,
    kind: Kind,
    label: string,
    identity?: LiveConnectorIdentity,
  ): Id<Kind> {
    const rows = transaction.all(
      `SELECT id FROM "${table}"
      WHERE "${ownerColumn}" = ?
      ORDER BY revision DESC
      LIMIT 1`,
      [ownerId],
    );
    if (rows.length !== 1) {
      throw new SessionCreationIntegrityError(
        `published ${label} has no current revision`,
      );
    }
    const id = requiredText(rows[0]!, "id", `${label} revision`);
    if (table === "workspace_revisions" && identity !== undefined) {
      assertPrincipalWorkspaceProvenance(
        transaction,
        identity,
        decodeServiceId("Workspace", ownerId),
        decodeServiceId("WorkspaceRevision", id),
      );
    } else {
      assertPublishedRow(
        transaction,
        installationId,
        table,
        [id],
        `${label} revision`,
      );
    }
    return decodeServiceId(kind, id);
  }

  /** The first slice publishes exactly one policy of each kind. */
  #solePolicy<Kind extends "ExecutionPolicy" | "TurnPolicy">(
    transaction: V2RepositoryTransaction,
    installationId: InstallationId,
    table: "execution_policies" | "turn_policies",
    kind: Kind,
    label: string,
  ): Id<Kind> {
    const rows = transaction.all(
      `SELECT id FROM "${table}" WHERE installation_id = ?`,
      [installationId],
    );
    if (rows.length !== 1) {
      throw new SessionCreationIntegrityError(
        `first-slice session creation requires exactly one published ${label}`,
      );
    }
    const id = requiredText(rows[0]!, "id", `${label} identifier`);
    assertPublishedRow(transaction, installationId, table, [id], label);
    return decodeServiceId(kind, id);
  }

  #selectCurrentConfiguration(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    profileId: string,
    workspaceId: string,
  ): CurrentConfigurationSelection & {
    readonly executionPolicyId: ExecutionPolicyId;
    readonly turnPolicyId: TurnPolicyId;
    readonly extensionIds: readonly ExtensionId[];
  } {
    const installationId = identity.installationId;
    const profileRevisionId = this.#currentRevision(
      transaction,
      installationId,
      "agent_profile_revisions",
      "profile_id",
      profileId,
      "AgentProfileRevision",
      "agent profile",
    );
    const workspaceRevisionId = this.#currentRevision(
      transaction,
      installationId,
      "workspace_revisions",
      "workspace_id",
      workspaceId,
      "WorkspaceRevision",
      "workspace",
      identity,
    );
    const executionPolicyId = this.#solePolicy(
      transaction,
      installationId,
      "execution_policies",
      "ExecutionPolicy",
      "execution policy",
    );
    const executionPolicySnapshotId = this.#currentRevision(
      transaction,
      installationId,
      "execution_policy_snapshots",
      "policy_id",
      executionPolicyId,
      "ExecutionPolicySnapshot",
      "execution policy",
    );
    const turnPolicyId = this.#solePolicy(
      transaction,
      installationId,
      "turn_policies",
      "TurnPolicy",
      "turn policy",
    );
    const turnPolicySnapshotId = this.#currentRevision(
      transaction,
      installationId,
      "turn_policy_snapshots",
      "policy_id",
      turnPolicyId,
      "TurnPolicySnapshot",
      "turn policy",
    );

    const resourceRows = transaction.all(
      `SELECT agent_resource_snapshot_id AS snapshot_id
      FROM agent_profile_resource_snapshots
      WHERE agent_profile_revision_id = ?
      ORDER BY ordinal`,
      [profileRevisionId],
    );
    const resourceSnapshotIds = resourceRows.map((row) => {
      const snapshotId = requiredText(
        row,
        "snapshot_id",
        "profile resource snapshot",
      );
      assertPublishedRow(
        transaction,
        installationId,
        "agent_profile_resource_snapshots",
        [profileRevisionId, snapshotId],
        "profile resource snapshot",
      );
      assertPublishedRow(
        transaction,
        installationId,
        "agent_resource_snapshots",
        [snapshotId],
        "agent resource snapshot",
      );
      return decodeServiceId("AgentResourceSnapshot", snapshotId);
    });

    const extensionRows = transaction.all(
      `SELECT grants.extension_grant_snapshot_id AS snapshot_id,
        snapshots.extension_id AS extension_id
      FROM agent_profile_extension_grants AS grants
      JOIN extension_grant_snapshots AS snapshots
        ON snapshots.id = grants.extension_grant_snapshot_id
      WHERE grants.agent_profile_revision_id = ?
      ORDER BY grants.ordinal`,
      [profileRevisionId],
    );
    const extensionGrants = extensionRows.map((row) => {
      const snapshotId = requiredText(
        row,
        "snapshot_id",
        "profile extension grant",
      );
      const extensionId = requiredText(
        row,
        "extension_id",
        "profile extension grant extension",
      );
      assertPublishedRow(
        transaction,
        installationId,
        "agent_profile_extension_grants",
        [profileRevisionId, snapshotId],
        "profile extension grant",
      );
      assertPublishedRow(
        transaction,
        installationId,
        "extension_grant_snapshots",
        [snapshotId],
        "extension grant snapshot",
      );
      return Object.freeze({
        snapshotId: decodeServiceId("ExtensionGrantSnapshot", snapshotId),
        extensionId: decodeServiceId("Extension", extensionId),
      });
    });

    const allowanceRows = transaction.all(
      `SELECT provider_id, provider_connection_id
      FROM agent_profile_provider_allowances
      WHERE agent_profile_revision_id = ?
      ORDER BY provider_id`,
      [profileRevisionId],
    );
    if (allowanceRows.length !== 1) {
      throw new SessionCreationIntegrityError(
        "first-slice session creation requires exactly one profile provider allowance",
      );
    }
    const providerId = requiredText(
      allowanceRows[0]!,
      "provider_id",
      "profile provider allowance",
    );
    const providerConnectionId = requiredText(
      allowanceRows[0]!,
      "provider_connection_id",
      "profile provider connection",
    );
    assertPublishedRow(
      transaction,
      installationId,
      "agent_profile_provider_allowances",
      [profileRevisionId, providerId],
      "profile provider allowance",
    );

    const bindingRows = transaction.all(
      `SELECT id
      FROM provider_credential_bindings
      WHERE installation_id = ? AND provider_id = ?`,
      [installationId, providerId],
    );
    if (bindingRows.length !== 1) {
      throw new SessionCreationIntegrityError(
        "first-slice session creation requires exactly one credential binding for the allowed provider",
      );
    }
    const credentialBindingId = requiredText(
      bindingRows[0]!,
      "id",
      "provider credential binding",
    );
    assertPublishedRow(
      transaction,
      installationId,
      "provider_credential_bindings",
      [credentialBindingId],
      "provider credential binding",
    );

    return Object.freeze({
      profileRevisionId,
      workspaceRevisionId,
      executionPolicyId,
      executionPolicySnapshotId,
      turnPolicyId,
      turnPolicySnapshotId,
      resourceSnapshotIds: Object.freeze(resourceSnapshotIds),
      extensionGrantSnapshotIds: Object.freeze(
        extensionGrants.map((grant) => grant.snapshotId),
      ),
      extensionIds: Object.freeze(
        extensionGrants.map((grant) => grant.extensionId),
      ),
      providerId: decodeServiceId("Provider", providerId),
      providerConnectionId: decodeServiceId(
        "ProviderConnection",
        providerConnectionId,
      ),
      credentialBindingId: decodeServiceId(
        "ProviderCredentialBinding",
        credentialBindingId,
      ),
    });
  }

  #insertOne(
    transaction: V2RepositoryTransaction,
    sql: string,
    parameters: readonly SQLiteBindValue[],
  ): void {
    const result = transaction.run(sql, parameters);
    if (result.changes !== 1) {
      throw new SessionCreationIntegrityError(
        "session creation did not append exactly one row",
      );
    }
  }

  #insertSession(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity & { readonly status: "active" },
    displayName: string | undefined,
    selection: CurrentConfigurationSelection,
  ): SessionCreationResult {
    const now = this.#clock.now();
    const specId = this.#ids.next("SessionSpec");
    const sessionId = this.#ids.next("Session");
    const bindingId = this.#ids.next("SessionEndpointBinding");

    this.#insertOne(
      transaction,
      `INSERT INTO session_specs (
        id, schema_version, agent_profile_revision_id,
        workspace_revision_id, execution_policy_snapshot_id,
        turn_policy_snapshot_id, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      [
        specId,
        selection.profileRevisionId,
        selection.workspaceRevisionId,
        selection.executionPolicySnapshotId,
        selection.turnPolicySnapshotId,
        now,
      ],
    );
    selection.resourceSnapshotIds.forEach((snapshotId, ordinal) => {
      this.#insertOne(
        transaction,
        `INSERT INTO session_spec_resource_snapshots (
          session_spec_id, agent_resource_snapshot_id, ordinal
        ) VALUES (?, ?, ?)`,
        [specId, snapshotId, ordinal],
      );
    });
    selection.extensionGrantSnapshotIds.forEach((grantId, ordinal) => {
      this.#insertOne(
        transaction,
        `INSERT INTO session_spec_extension_grants (
          session_spec_id, extension_grant_snapshot_id, ordinal
        ) VALUES (?, ?, ?)`,
        [specId, grantId, ordinal],
      );
    });
    this.#insertOne(
      transaction,
      `INSERT INTO session_spec_provider_bindings (
        session_spec_id, provider_id, provider_connection_id,
        credential_binding_id
      ) VALUES (?, ?, ?, ?)`,
      [
        specId,
        selection.providerId,
        selection.providerConnectionId,
        selection.credentialBindingId,
      ],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO sessions (id, owner_principal_id, spec_id, created_at)
      VALUES (?, ?, ?, ?)`,
      [sessionId, identity.principalId, specId, now],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO session_metadata (
        session_id, display_name, labels_json, updated_at
      ) VALUES (?, ?, '[]', ?)`,
      [sessionId, displayName ?? null, now],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO session_lifecycle (
        session_id, status, blocked_reason, updated_at
      ) VALUES (?, 'active', NULL, ?)`,
      [sessionId, now],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO session_runtime_state (
        session_id, status, active_turn_id, worker_lease_id,
        agent_resume_handle_id, last_activity_at, updated_at
      ) VALUES (?, 'idle', NULL, NULL, NULL, NULL, ?)`,
      [sessionId, now],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO session_endpoint_bindings (
        id, kind, session_id, endpoint_id, created_by_principal_id,
        state, suspended_at, suspended_actor_kind,
        suspended_actor_principal_id, suspended_actor_system_component,
        suspended_reason, revoked_at, revoked_actor_kind,
        revoked_actor_principal_id, revoked_actor_system_component,
        created_at, updated_at
      ) VALUES (
        ?, 'private', ?, ?, ?, 'active', NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, ?, ?
      )`,
      [
        bindingId,
        sessionId,
        identity.endpointId,
        identity.principalId,
        now,
        now,
      ],
    );

    const auditEvents = Object.freeze([
      insertAuditEnvelope(transaction, {
        id: this.#ids.next("AuditEnvelope"),
        installationId: identity.installationId,
        actor: { kind: "principal", principalId: identity.principalId },
        outcome: "succeeded",
        action: "session-created",
        sessionId,
        sessionSpecId: specId,
        endpointBindingId: bindingId,
        occurredAt: now,
      }),
    ] as const);

    const spec: SessionSpec = Object.freeze({
      id: specId,
      schemaVersion: 1,
      agentProfileRevisionId: selection.profileRevisionId,
      workspaceRevisionId: selection.workspaceRevisionId,
      executionPolicySnapshotId: selection.executionPolicySnapshotId,
      turnPolicySnapshotId: selection.turnPolicySnapshotId,
      agentResourceSnapshotIds: selection.resourceSnapshotIds,
      extensionGrantSnapshotIds: selection.extensionGrantSnapshotIds,
      providerBindings: Object.freeze([
        Object.freeze({
          providerId: selection.providerId,
          providerConnectionId: selection.providerConnectionId,
          credentialBindingId: selection.credentialBindingId,
        }),
      ]),
      createdAt: now,
    });
    const session: Session = Object.freeze({
      id: sessionId,
      ownerPrincipalId: identity.principalId,
      specId,
      createdAt: now,
    });
    const metadata: SessionMetadata =
      displayName === undefined
        ? Object.freeze({
            sessionId,
            labels: EMPTY_LABELS,
            updatedAt: now,
          })
        : Object.freeze({
            sessionId,
            displayName,
            labels: EMPTY_LABELS,
            updatedAt: now,
          });
    const lifecycle = Object.freeze({
      sessionId,
      status: "active" as const,
      updatedAt: now,
    });
    const runtime = Object.freeze({
      sessionId,
      status: "idle" as const,
      updatedAt: now,
    });
    const endpointBinding: SessionEndpointBinding = Object.freeze({
      id: bindingId,
      kind: "private",
      sessionId,
      endpointId: identity.endpointId,
      createdByPrincipalId: identity.principalId,
      state: Object.freeze({ status: "active" as const }),
      createdAt: now,
      updatedAt: now,
    });

    return Object.freeze({
      status: "created" as const,
      session,
      spec,
      metadata,
      lifecycle,
      runtime,
      endpointBinding,
      auditEvents,
    });
  }

  #deniedAudit(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
    installationId: InstallationId,
  ): AuditEnvelopeFor<"session-creation-denied"> {
    return insertAuditEnvelope(transaction, {
      id: this.#ids.next("AuditEnvelope"),
      installationId,
      actor: { kind: "principal", principalId: context.actor.principalId },
      outcome: "denied",
      action: "session-creation-denied",
      occurredAt: this.#clock.now(),
    });
  }

  #denied(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
    installationId: InstallationId,
    reason: "principal-disabled" | "binding-inactive",
  ): SessionCreationResult;
  #denied(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
    installationId: InstallationId,
    reason: "required-configuration-use-revoked",
    resourceKind: ConfigurationResourceKind,
  ): SessionCreationResult;
  #denied(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
    installationId: InstallationId,
    reason: SessionCreationDenial["reason"],
    resourceKind?: ConfigurationResourceKind,
  ): SessionCreationResult {
    const auditEvents = Object.freeze([
      this.#deniedAudit(transaction, context, installationId),
    ] as const);
    if (reason === "required-configuration-use-revoked") {
      if (resourceKind === undefined) {
        throw new SessionCreationIntegrityError(
          "configuration-use denial requires its resource kind",
        );
      }
      return Object.freeze({
        status: "denied" as const,
        reason,
        resourceKind,
        auditEvents,
      });
    }
    return Object.freeze({
      status: "denied" as const,
      reason,
      auditEvents,
    });
  }

  #notFound(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
    installationId: InstallationId,
    missing: "profile" | "workspace",
  ): SessionCreationResult {
    return Object.freeze({
      status: "not-found" as const,
      missing,
      auditEvents: Object.freeze([
        this.#deniedAudit(transaction, context, installationId),
      ] as const),
    });
  }
}

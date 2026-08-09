import { encodeCanonicalJson } from "../codecs/json.js";
import {
  decodeBoundedString,
  decodeServiceId,
} from "../codecs/primitives.js";
import type {
  TrustedAuthorizationContextVerifier,
} from "../application/authorization-contexts.js";
import type {
  AccessGrantId,
  AgentProfileId,
  AuthenticationRequestId,
  ConfigurationReference,
  EndpointId,
  IdentityBindingId,
  InstallationId,
  PrincipalId,
  WorkspaceId,
  WorkspaceRevisionId,
} from "../model/primitives.js";
import type {
  InstallationRole,
  SessionConfigurationResourceRef,
} from "../model/identity-access.js";
import type {
  SQLiteBindValue,
  SQLiteRow,
  V2RepositoryTransaction,
} from "./database.js";
import type { BootstrapFoundationTable } from "./foundation-rows.js";
import {
  assertPrincipalProvisionedRow,
  PrincipalProvisioningIntegrityError,
  type PrincipalProvisionedRowRef,
} from "./principal-provisioning.js";

const CONFIGURATION_REFERENCE = /^[a-z][a-z0-9-]{0,127}$/u;

export interface FoundationalAuthorizationReadOptions {
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
}

export interface LiveConnectorIdentity {
  readonly status: "active";
  readonly installationId: InstallationId;
  readonly principalId: PrincipalId;
  readonly identityBindingId: IdentityBindingId;
  readonly endpointId: EndpointId;
  readonly authenticationRequestId: AuthenticationRequestId;
}

export type LiveConnectorIdentityRead =
  | LiveConnectorIdentity
  | {
      readonly status: "denied";
      /**
       * Validated by the durable authentication evidence before denial; safe
       * for denial-audit attribution even though no live identity exists.
       */
      readonly installationId: InstallationId;
      readonly reason: "principal-disabled" | "binding-inactive";
    };

export type InstallationRoleRead =
  | {
      readonly status: "active" | "revoked";
      readonly grantId: AccessGrantId;
    }
  | { readonly status: "absent" };

export type ConfigurationUseRead =
  | {
      readonly status: "active";
      readonly grantId: AccessGrantId;
    }
  | {
      readonly status: "revoked";
      readonly cause: "grant-revoked" | "resource-revoked";
      readonly grantId: AccessGrantId;
    }
  | { readonly status: "absent" };

export type ProfileReferenceRead =
  | {
      readonly status: "resolved";
      readonly profileId: AgentProfileId;
    }
  | { readonly status: "not-found" };

export type WorkspaceReferenceRead =
  | {
      readonly status: "resolved";
      readonly workspaceId: WorkspaceId;
    }
  | { readonly status: "not-found" };

export class UntrustedAuthorizationContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedAuthorizationContextError";
  }
}

export class FoundationalAuthorizationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundationalAuthorizationIntegrityError";
  }
}

export class FoundationalAuthorizationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoundationalAuthorizationInputError";
  }
}

function decodeAuthenticationRequestId(
  input: unknown,
): AuthenticationRequestId {
  return decodeServiceId("AuthenticationRequest", input);
}

function decodeAccessGrantId(input: unknown): AccessGrantId {
  return decodeServiceId("AccessGrant", input);
}

export function requiredText(
  row: SQLiteRow,
  column: string,
  label: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new FoundationalAuthorizationIntegrityError(
      `durable ${label} is invalid`,
    );
  }
  return value;
}

function requiredCount(
  transaction: V2RepositoryTransaction,
  sql: string,
  parameters: readonly SQLiteBindValue[] = [],
): number {
  const row = transaction.get(sql, parameters);
  if (
    row === undefined ||
    typeof row.count !== "number" ||
    !Number.isSafeInteger(row.count) ||
    row.count < 0
  ) {
    throw new FoundationalAuthorizationIntegrityError(
      "cannot determine durable authorization cardinality",
    );
  }
  return row.count;
}

export function assertPublishedRow(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  table: BootstrapFoundationTable,
  primaryKey: readonly string[],
  label: string,
): void {
  const count = exactBootstrapPublicationCount(
    transaction,
    installationId,
    table,
    primaryKey,
  );
  if (count !== 1) {
    throw new FoundationalAuthorizationIntegrityError(
      `durable ${label} has no exact bootstrap publication provenance`,
    );
  }
}

function exactBootstrapPublicationCount(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  table: BootstrapFoundationTable,
  primaryKey: readonly string[],
): number {
  return requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM bootstrap_publication_rows AS publication
      JOIN audit_envelopes AS first_audit
        ON first_audit.id = publication.first_published_audit_id
      WHERE publication.table_name = ?
        AND publication.primary_key_json = ?
        AND first_audit.installation_id = ?
        AND first_audit.actor_kind = 'bootstrap'
        AND first_audit.outcome = 'succeeded'
        AND first_audit.action = 'installation-published'`,
    [table, encodeCanonicalJson(primaryKey), installationId],
  );
}

function assertAccessGrantProvenance(
  transaction: V2RepositoryTransaction,
  identity: LiveConnectorIdentity,
  grantId: AccessGrantId,
): void {
  if (
    exactBootstrapPublicationCount(
      transaction,
      identity.installationId,
      "access_grants",
      [grantId],
    ) === 1
  ) {
    return;
  }
  assertExactPrincipalProvisionedRow(transaction, identity, {
    table: "access_grants",
    primaryKey: [grantId],
  });
}

function assertExactPrincipalProvisionedRow(
  transaction: V2RepositoryTransaction,
  identity: LiveConnectorIdentity,
  row: PrincipalProvisionedRowRef,
): void {
  try {
    assertPrincipalProvisionedRow(transaction, {
      installationId: identity.installationId,
      principalId: identity.principalId,
      row,
    });
  } catch (error) {
    if (error instanceof PrincipalProvisioningIntegrityError) {
      throw new FoundationalAuthorizationIntegrityError(error.message);
    }
    throw error;
  }
}

export function assertPrincipalWorkspaceProvenance(
  transaction: V2RepositoryTransaction,
  identity: LiveConnectorIdentity,
  workspaceId: WorkspaceId,
  workspaceRevisionId?: WorkspaceRevisionId,
): void {
  const ownerBindingCount = requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
    FROM principal_workspace_bindings
    WHERE principal_id = ? AND installation_id = ? AND workspace_id = ?`,
    [identity.principalId, identity.installationId, workspaceId],
  );
  if (ownerBindingCount !== 1) {
    throw new FoundationalAuthorizationIntegrityError(
      "durable workspace is not the principal's fixed workspace",
    );
  }
  const bootstrapWorkspace = exactBootstrapPublicationCount(
    transaction,
    identity.installationId,
    "workspaces",
    [workspaceId],
  );
  const bootstrapRevision = workspaceRevisionId === undefined
    ? 1
    : exactBootstrapPublicationCount(
        transaction,
        identity.installationId,
        "workspace_revisions",
        [workspaceRevisionId],
      );
  if (bootstrapWorkspace === 1 && bootstrapRevision === 1) return;

  const revisionPredicate = workspaceRevisionId === undefined
    ? ""
    : "AND revisions.id = ?";
  const rows = transaction.all(
    `SELECT revisions.id AS workspace_revision_id,
      resources.id AS workspace_resource_id,
      execution_grants.execution_policy_snapshot_id AS execution_policy_snapshot_id
    FROM workspaces
    JOIN principal_workspace_bindings AS principal_binding
      ON principal_binding.workspace_id = workspaces.id
      AND principal_binding.installation_id = workspaces.installation_id
    JOIN principals AS subject
      ON subject.id = principal_binding.principal_id
      AND subject.installation_id = principal_binding.installation_id
    JOIN workspace_reference_bindings AS reference_binding
      ON reference_binding.workspace_id = workspaces.id
      AND reference_binding.installation_id = workspaces.installation_id
      AND reference_binding.binding_reference = workspaces.reference
    JOIN workspace_revisions AS revisions
      ON revisions.id = reference_binding.workspace_revision_id
      AND revisions.workspace_id = workspaces.id
    JOIN workspace_revision_resources AS revision_resources
      ON revision_resources.workspace_revision_id = revisions.id
      AND revision_resources.ordinal = 0
      AND revision_resources.role = 'root'
    JOIN workspace_resources AS resources
      ON resources.id = revision_resources.workspace_resource_id
      AND resources.installation_id = workspaces.installation_id
      AND resources.sandbox_path = '/workspace'
      AND resources.maximum_access = 'read-write'
    JOIN execution_policy_resource_grants AS execution_grants
      ON execution_grants.workspace_resource_id = resources.id
      AND execution_grants.access = 'read-write'
    WHERE workspaces.id = ?
      AND workspaces.installation_id = ?
      AND principal_binding.principal_id = ?
      AND principal_binding.created_actor_kind = 'principal'
      AND (SELECT COUNT(*) FROM workspace_revisions AS all_revisions
        WHERE all_revisions.workspace_id = workspaces.id) = 1
      AND (SELECT COUNT(*) FROM workspace_revision_resources AS all_resources
        WHERE all_resources.workspace_revision_id = revisions.id) = 1
      AND (SELECT COUNT(*) FROM execution_policy_resource_grants AS execution_grants
        WHERE execution_grants.workspace_resource_id = resources.id) = 1
      ${revisionPredicate}`,
    workspaceRevisionId === undefined
      ? [workspaceId, identity.installationId, identity.principalId]
      : [
          workspaceId,
          identity.installationId,
          identity.principalId,
          workspaceRevisionId,
        ],
  );
  if (rows.length !== 1) {
    throw new FoundationalAuthorizationIntegrityError(
      "durable workspace has no exact bootstrap or principal-creation provenance",
    );
  }
  const row = rows[0]!;
  const revisionId = requiredText(
    row,
    "workspace_revision_id",
    "workspace revision identifier",
  );
  const resourceId = requiredText(
    row,
    "workspace_resource_id",
    "workspace resource identifier",
  );
  const executionPolicySnapshotId = requiredText(
    row,
    "execution_policy_snapshot_id",
    "execution policy snapshot identifier",
  );
  for (const provisioned of [
    { table: "principals", primaryKey: [identity.principalId] },
    { table: "workspaces", primaryKey: [workspaceId] },
    {
      table: "principal_workspace_bindings",
      primaryKey: [identity.principalId],
    },
    { table: "workspace_resources", primaryKey: [resourceId] },
    { table: "workspace_revisions", primaryKey: [revisionId] },
    {
      table: "workspace_revision_resources",
      primaryKey: [revisionId, resourceId],
    },
    {
      table: "workspace_reference_bindings",
      primaryKey: [workspaceId],
    },
    {
      table: "execution_policy_resource_grants",
      primaryKey: [executionPolicySnapshotId, resourceId],
    },
  ] as const) {
    assertExactPrincipalProvisionedRow(transaction, identity, provisioned);
  }
}

function decodeConfigurationReference(input: unknown): ConfigurationReference {
  let value: string;
  try {
    value = decodeBoundedString(input, {
      minimumLength: 1,
      maximumLength: 128,
      label: "configuration reference",
    });
  } catch {
    throw new FoundationalAuthorizationInputError(
      "configuration reference must be a bounded string",
    );
  }
  if (!CONFIGURATION_REFERENCE.test(value)) {
    throw new FoundationalAuthorizationInputError(
      "configuration reference is not canonical",
    );
  }
  return value as ConfigurationReference;
}

function authenticationAuditCount(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  authenticationRequestId: string,
  component: "local-connector" | "remote-ingress",
): number {
  return requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM audit_envelopes
      WHERE installation_id = ?
        AND actor_kind = 'system'
        AND system_component = ?
        AND outcome = 'succeeded'
        AND action = 'authentication-recorded'
        AND authentication_request_id = ?`,
    [installationId, component, authenticationRequestId],
  );
}

function totalAuthenticationAuditCount(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  authenticationRequestId: string,
): number {
  return requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM audit_envelopes
      WHERE installation_id = ?
        AND action = 'authentication-recorded'
        AND authentication_request_id = ?`,
    [installationId, authenticationRequestId],
  );
}

interface ConfigurationResourceState {
  readonly exists: boolean;
  readonly revoked: boolean;
  readonly table: BootstrapFoundationTable;
}

function readConfigurationResource(
  transaction: V2RepositoryTransaction,
  identity: LiveConnectorIdentity,
  resource: SessionConfigurationResourceRef,
): ConfigurationResourceState {
  const query = (
    table: BootstrapFoundationTable,
    id: string,
    includeState = false,
  ): ConfigurationResourceState => {
    const row = transaction.get(
      includeState
        ? `SELECT installation_id, state FROM "${table}" WHERE id = ?`
        : `SELECT installation_id FROM "${table}" WHERE id = ?`,
      [id],
    );
    if (row === undefined) {
      return Object.freeze({
        exists: false,
        revoked: false,
        table,
      });
    }
    if (row.installation_id !== identity.installationId) {
      return Object.freeze({
        exists: false,
        revoked: false,
        table,
      });
    }
    let revoked = false;
    if (includeState) {
      const state = requiredText(
        row,
        "state",
        "configuration resource state",
      );
      if (state !== "active" && state !== "revoked") {
        throw new FoundationalAuthorizationIntegrityError(
          "durable configuration resource state is unsupported",
        );
      }
      revoked = state === "revoked";
    }
    if (resource.kind === "workspace") {
      assertPrincipalWorkspaceProvenance(
        transaction,
        identity,
        decodeServiceId("Workspace", id),
      );
    } else {
      assertPublishedRow(
        transaction,
        identity.installationId,
        table,
        [id],
        `${resource.kind} resource`,
      );
    }
    return Object.freeze({ exists: true, revoked, table });
  };

  switch (resource.kind) {
    case "agent-profile":
      return query(
        "agent_profiles",
        decodeServiceId("AgentProfile", resource.id),
      );
    case "workspace":
      return query(
        "workspaces",
        decodeServiceId("Workspace", resource.id),
      );
    case "execution-policy":
      return query(
        "execution_policies",
        decodeServiceId("ExecutionPolicy", resource.id),
      );
    case "turn-policy":
      return query(
        "turn_policies",
        decodeServiceId("TurnPolicy", resource.id),
      );
    case "extension":
      return query(
        "extensions",
        decodeServiceId("Extension", resource.id),
      );
    case "provider-credential-binding":
      return query(
        "provider_credential_bindings",
        decodeServiceId("ProviderCredentialBinding", resource.id),
        true,
      );
  }
}

function requireGrantState(row: SQLiteRow): "active" | "revoked" {
  const state = requiredText(row, "state", "access-grant state");
  if (state !== "active" && state !== "revoked") {
    throw new FoundationalAuthorizationIntegrityError(
      "durable access-grant state is unsupported",
    );
  }
  return state;
}

/**
 * Transaction-scoped reader for identity, role, stable-reference, and
 * configuration-use authority. It never opens a transaction and never returns
 * a reusable authorization decision accepted by a write.
 */
export class SQLiteFoundationalAuthorizationReads {
  readonly #contextVerifier: TrustedAuthorizationContextVerifier;
  readonly #identityTransactions =
    new WeakMap<object, V2RepositoryTransaction>();

  constructor(options: FoundationalAuthorizationReadOptions) {
    this.#contextVerifier = options.contextVerifier;
  }

  readLiveConnectorIdentity(
    transaction: V2RepositoryTransaction,
    context: unknown,
  ): LiveConnectorIdentityRead {
    const verified = this.#contextVerifier.classify(context);
    if (verified?.kind !== "connector") {
      throw new UntrustedAuthorizationContextError(
        "foundational connector read requires a minted connector context",
      );
    }
    const actor = verified.context.actor;
    const authenticationRequestId = decodeAuthenticationRequestId(
      actor.requestId,
    );
    const request = transaction.get(
      `SELECT installation_id, evidence_kind, socket_security,
        client_trust_root_id, client_certificate_fingerprint,
        binding_source_kind, outcome_status, principal_id,
        identity_binding_id, assurance, rejection_reason, decided_at
      FROM authentication_requests
      WHERE id = ?`,
      [authenticationRequestId],
    );
    if (request === undefined) {
      throw new FoundationalAuthorizationIntegrityError(
        "minted connector context lost its authentication request",
      );
    }
    const installationId = decodeServiceId(
      "Installation",
      requiredText(
        request,
        "installation_id",
        "authentication installation",
      ),
    );
    const isLocalEvidence =
      actor.method === "local-peer" &&
      actor.assurance === "elevated" &&
      request.evidence_kind === "local-peer-owner-socket" &&
      request.socket_security ===
        "service-owned-0700-parent-and-0600-socket" &&
      request.client_trust_root_id === null &&
      request.client_certificate_fingerprint === null &&
      request.binding_source_kind === "local-peer";
    const isRemoteEvidence =
      actor.method === "mtls-client" &&
      actor.assurance === "normal" &&
      request.evidence_kind === "mtls-client-certificate" &&
      request.socket_security === null &&
      typeof request.client_trust_root_id === "string" &&
      typeof request.client_certificate_fingerprint === "string" &&
      request.binding_source_kind === "mtls-client";
    const auditComponent = actor.method === "local-peer"
      ? "local-connector" as const
      : actor.method === "mtls-client"
        ? "remote-ingress" as const
        : undefined;
    if (
      (!isLocalEvidence && !isRemoteEvidence) ||
      auditComponent === undefined ||
      request.outcome_status !== "authenticated" ||
      request.principal_id !== actor.principalId ||
      request.identity_binding_id !== actor.identityBindingId ||
      request.assurance !== actor.assurance ||
      request.rejection_reason !== null ||
      request.decided_at !== actor.authenticatedAt ||
      authenticationAuditCount(
        transaction,
        installationId,
        authenticationRequestId,
        auditComponent,
      ) !== 1 ||
      totalAuthenticationAuditCount(
        transaction,
        installationId,
        authenticationRequestId,
      ) !== 1
    ) {
      throw new FoundationalAuthorizationIntegrityError(
        "minted connector context differs from durable authentication evidence",
      );
    }

    const principalId = decodeServiceId("Principal", actor.principalId);
    const identityBindingId = decodeServiceId(
      "IdentityBinding",
      actor.identityBindingId,
    );
    const endpointId = decodeServiceId(
      "Endpoint",
      verified.context.endpointId,
    );
    const principal = transaction.get(
      "SELECT installation_id, state FROM principals WHERE id = ?",
      [principalId],
    );
    const binding = transaction.get(
      `SELECT installation_id, principal_id, source_kind, local_host_id,
        client_trust_root_id, subject_id, state
      FROM identity_bindings
      WHERE id = ?`,
      [identityBindingId],
    );
    const endpoint = transaction.get(
      `SELECT installation_id, address_kind, local_host_id,
        identity_binding_id, identity_binding_source_kind,
        audience_kind, audience_principal_id
      FROM endpoints
      WHERE id = ?`,
      [endpointId],
    );
    const localHost =
      typeof binding?.local_host_id === "string"
        ? transaction.get(
            `SELECT installation_id
            FROM local_hosts
            WHERE id = ?`,
            [binding.local_host_id],
          )
        : undefined;
    if (principal === undefined || binding === undefined || endpoint === undefined) {
      return Object.freeze({
        status: "denied" as const,
        installationId,
        reason: "binding-inactive" as const,
      });
    }
    assertPublishedRow(
      transaction,
      installationId,
      "installations",
      [installationId],
      "installation",
    );
    if (actor.method === "local-peer") {
      if (localHost === undefined) {
        return Object.freeze({
          status: "denied" as const,
          installationId,
          reason: "binding-inactive" as const,
        });
      }
      assertPublishedRow(
        transaction,
        installationId,
        "principals",
        [principalId],
        "principal",
      );
      assertPublishedRow(
        transaction,
        installationId,
        "identity_bindings",
        [identityBindingId],
        "identity binding",
      );
      const localHostId = decodeServiceId(
        "LocalHost",
        binding.local_host_id,
      );
      assertPublishedRow(
        transaction,
        installationId,
        "local_hosts",
        [localHostId],
        "local host",
      );
      assertPublishedRow(
        transaction,
        installationId,
        "endpoints",
        [endpointId],
        "endpoint",
      );
    }

    const principalState = requiredText(
      principal,
      "state",
      "principal state",
    );
    const bindingState = requiredText(
      binding,
      "state",
      "identity-binding state",
    );
    if (
      (principalState !== "active" && principalState !== "disabled") ||
      (bindingState !== "active" && bindingState !== "revoked")
    ) {
      throw new FoundationalAuthorizationIntegrityError(
        "durable connector identity state is unsupported",
      );
    }
    const localGraphMatches =
      actor.method === "local-peer" &&
      localHost !== undefined &&
      binding.installation_id === installationId &&
      binding.principal_id === principalId &&
      binding.source_kind === "local-peer" &&
      binding.client_trust_root_id === null &&
      localHost.installation_id === installationId &&
      endpoint.installation_id === installationId &&
      endpoint.address_kind === "local-client" &&
      endpoint.local_host_id === binding.local_host_id &&
      endpoint.identity_binding_id === null &&
      endpoint.identity_binding_source_kind === null &&
      endpoint.audience_kind === "private" &&
      endpoint.audience_principal_id === principalId;
    const remoteGraphMatches =
      actor.method === "mtls-client" &&
      binding.installation_id === installationId &&
      binding.principal_id === principalId &&
      binding.source_kind === "mtls-client" &&
      binding.local_host_id === null &&
      binding.client_trust_root_id === request.client_trust_root_id &&
      binding.subject_id === request.client_certificate_fingerprint &&
      endpoint.installation_id === installationId &&
      endpoint.address_kind === "remote-client" &&
      endpoint.local_host_id === null &&
      endpoint.identity_binding_id === identityBindingId &&
      endpoint.identity_binding_source_kind === "mtls-client" &&
      endpoint.audience_kind === "private" &&
      endpoint.audience_principal_id === principalId;
    if (
      (!localGraphMatches && !remoteGraphMatches) ||
      principal.installation_id !== installationId ||
      bindingState === "revoked"
    ) {
      return Object.freeze({
        status: "denied" as const,
        installationId,
        reason: "binding-inactive" as const,
      });
    }
    if (principalState === "disabled") {
      return Object.freeze({
        status: "denied" as const,
        installationId,
        reason: "principal-disabled" as const,
      });
    }

    const identity = Object.freeze({
      status: "active" as const,
      installationId,
      principalId,
      identityBindingId,
      endpointId,
      authenticationRequestId,
    });
    this.#identityTransactions.set(identity, transaction);
    return identity;
  }

  readInstallationRole(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    role: InstallationRole,
  ): InstallationRoleRead {
    this.#requireTransactionIdentity(transaction, identity);
    const rows = transaction.all(
      `SELECT id, state
      FROM access_grants
      WHERE kind = 'installation-role'
        AND installation_id = ?
        AND principal_id = ?
        AND role = ?`,
      [identity.installationId, identity.principalId, role],
    );
    if (rows.length === 0) return Object.freeze({ status: "absent" });
    if (rows.length !== 1) {
      throw new FoundationalAuthorizationIntegrityError(
        "installation role grant is ambiguous",
      );
    }
    const grantId = decodeAccessGrantId(
      requiredText(rows[0]!, "id", "access-grant identifier"),
    );
    assertAccessGrantProvenance(transaction, identity, grantId);
    return Object.freeze({
      status: requireGrantState(rows[0]!),
      grantId,
    });
  }

  readConfigurationUse(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    resource: SessionConfigurationResourceRef,
  ): ConfigurationUseRead {
    this.#requireTransactionIdentity(transaction, identity);
    const rows = transaction.all(
      `SELECT id, state
      FROM access_grants
      WHERE kind = 'session-configuration-use'
        AND installation_id = ?
        AND principal_id = ?
        AND resource_kind = ?
        AND resource_id = ?`,
      [
        identity.installationId,
        identity.principalId,
        resource.kind,
        resource.id,
      ],
    );
    if (rows.length === 0) return Object.freeze({ status: "absent" });
    if (rows.length !== 1) {
      throw new FoundationalAuthorizationIntegrityError(
        "configuration-use grant is ambiguous",
      );
    }
    const grantId = decodeAccessGrantId(
      requiredText(rows[0]!, "id", "access-grant identifier"),
    );
    assertAccessGrantProvenance(transaction, identity, grantId);
    const grantState = requireGrantState(rows[0]!);
    const resourceState = readConfigurationResource(
      transaction,
      identity,
      resource,
    );
    if (!resourceState.exists) {
      throw new FoundationalAuthorizationIntegrityError(
        "configuration-use grant targets a missing or foreign resource",
      );
    }
    if (grantState === "revoked") {
      return Object.freeze({
        status: "revoked" as const,
        cause: "grant-revoked" as const,
        grantId,
      });
    }
    if (resourceState.revoked) {
      return Object.freeze({
        status: "revoked" as const,
        cause: "resource-revoked" as const,
        grantId,
      });
    }
    return Object.freeze({
      status: "active" as const,
      grantId,
    });
  }

  resolveProfileReference(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    reference: unknown,
  ): ProfileReferenceRead {
    this.#requireTransactionIdentity(transaction, identity);
    const decoded = decodeConfigurationReference(reference);
    const rows = transaction.all(
      `SELECT id
      FROM agent_profiles
      WHERE installation_id = ? AND reference = ?`,
      [identity.installationId, decoded],
    );
    if (rows.length === 0) return Object.freeze({ status: "not-found" });
    if (rows.length !== 1) {
      throw new FoundationalAuthorizationIntegrityError(
        "agent-profile reference is ambiguous",
      );
    }
    const profileId = decodeServiceId(
      "AgentProfile",
      requiredText(rows[0]!, "id", "agent-profile identifier"),
    );
    assertPublishedRow(
      transaction,
      identity.installationId,
      "agent_profiles",
      [profileId],
      "agent profile",
    );
    return Object.freeze({
      status: "resolved" as const,
      profileId,
    });
  }

  resolveWorkspaceReference(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    reference: unknown,
  ): WorkspaceReferenceRead {
    this.#requireTransactionIdentity(transaction, identity);
    const decoded = decodeConfigurationReference(reference);
    const rows = transaction.all(
      `SELECT workspaces.id AS id
      FROM workspaces
      JOIN principal_workspace_bindings AS principal_binding
        ON principal_binding.workspace_id = workspaces.id
        AND principal_binding.installation_id = workspaces.installation_id
      WHERE workspaces.installation_id = ?
        AND workspaces.reference = ?
        AND principal_binding.principal_id = ?`,
      [identity.installationId, decoded, identity.principalId],
    );
    if (rows.length === 0) return Object.freeze({ status: "not-found" });
    if (rows.length !== 1) {
      throw new FoundationalAuthorizationIntegrityError(
        "workspace reference is ambiguous",
      );
    }
    const workspaceId = decodeServiceId(
      "Workspace",
      requiredText(rows[0]!, "id", "workspace identifier"),
    );
    assertPrincipalWorkspaceProvenance(
      transaction,
      identity,
      workspaceId,
    );
    return Object.freeze({
      status: "resolved" as const,
      workspaceId,
    });
  }

  #requireTransactionIdentity(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
  ): void {
    if (
      typeof identity !== "object" ||
      identity === null ||
      this.#identityTransactions.get(identity) !== transaction
    ) {
      throw new UntrustedAuthorizationContextError(
        "foundational authorization read requires identity from this transaction",
      );
    }
  }
}

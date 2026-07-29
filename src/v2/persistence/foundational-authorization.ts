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

function requiredText(
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

function assertPublishedRow(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  table: BootstrapFoundationTable,
  primaryKey: readonly string[],
  label: string,
): void {
  const count = requiredCount(
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
  if (count !== 1) {
    throw new FoundationalAuthorizationIntegrityError(
      `durable ${label} has no exact bootstrap publication provenance`,
    );
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
): number {
  return requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM audit_envelopes
      WHERE installation_id = ?
        AND actor_kind = 'system'
        AND system_component = 'local-connector'
        AND outcome = 'succeeded'
        AND action = 'authentication-recorded'
        AND authentication_request_id = ?`,
    [installationId, authenticationRequestId],
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
  installationId: InstallationId,
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
    if (row.installation_id !== installationId) {
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
    assertPublishedRow(
      transaction,
      installationId,
      table,
      [id],
      `${resource.kind} resource`,
    );
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
        outcome_status, principal_id, identity_binding_id, assurance,
        rejection_reason, decided_at
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
    if (
      request.evidence_kind !== "local-peer-owner-socket" ||
      request.socket_security !==
        "service-owned-0700-parent-and-0600-socket" ||
      request.outcome_status !== "authenticated" ||
      request.principal_id !== actor.principalId ||
      request.identity_binding_id !== actor.identityBindingId ||
      request.assurance !== actor.assurance ||
      request.rejection_reason !== null ||
      request.decided_at !== actor.authenticatedAt ||
      actor.method !== "local-peer" ||
      actor.assurance !== "normal" ||
      authenticationAuditCount(
        transaction,
        installationId,
        authenticationRequestId,
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
      `SELECT installation_id, principal_id, source_kind, local_host_id, state
      FROM identity_bindings
      WHERE id = ?`,
      [identityBindingId],
    );
    const endpoint = transaction.get(
      `SELECT installation_id, address_kind, local_host_id,
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
    if (
      principal === undefined ||
      binding === undefined ||
      endpoint === undefined ||
      localHost === undefined
    ) {
      return Object.freeze({
        status: "denied" as const,
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
    if (
      binding.installation_id !== installationId ||
      binding.principal_id !== principalId ||
      binding.source_kind !== "local-peer" ||
      localHost.installation_id !== installationId ||
      endpoint.installation_id !== installationId ||
      endpoint.address_kind !== "local-client" ||
      endpoint.local_host_id !== binding.local_host_id ||
      endpoint.audience_kind !== "private" ||
      endpoint.audience_principal_id !== principalId ||
      principal.installation_id !== installationId ||
      bindingState === "revoked"
    ) {
      return Object.freeze({
        status: "denied" as const,
        reason: "binding-inactive" as const,
      });
    }
    if (principalState === "disabled") {
      return Object.freeze({
        status: "denied" as const,
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
    assertPublishedRow(
      transaction,
      identity.installationId,
      "access_grants",
      [grantId],
      "installation role grant",
    );
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
    assertPublishedRow(
      transaction,
      identity.installationId,
      "access_grants",
      [grantId],
      "configuration-use grant",
    );
    const grantState = requireGrantState(rows[0]!);
    const resourceState = readConfigurationResource(
      transaction,
      identity.installationId,
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
      `SELECT id
      FROM workspaces
      WHERE installation_id = ? AND reference = ?`,
      [identity.installationId, decoded],
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
    assertPublishedRow(
      transaction,
      identity.installationId,
      "workspaces",
      [workspaceId],
      "workspace",
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

/**
 * Compile-only v2 session model.
 *
 * These interfaces describe domain records, not runtime objects with mutable
 * fields. Revisions and snapshots are append-only. Mutable facts such as
 * bindings and worker state live in separate records.
 */

import type {
  AgentDriverId,
  AgentProfileId,
  AgentProfileRevisionId,
  AgentResumeHandleId,
  CanonicalHostPath,
  ExecutionPolicyId,
  ExecutionPolicySnapshotId,
  ExtensionCapabilityId,
  ExtensionGrantSnapshotId,
  ExtensionId,
  ExtensionRevisionId,
  IsoTimestamp,
  JsonObject,
  ModelId,
  PrincipalId,
  ProviderCredentialBindingId,
  ProviderId,
  SandboxPath,
  SessionId,
  SessionSpecId,
  ToolCapabilityId,
  TurnId,
  TurnPolicySnapshotId,
  WorkerLeaseId,
  WorkspaceId,
  WorkspaceResourceId,
  WorkspaceRevisionId,
} from "./primitives.js";

export interface ModelRef {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
}

/** Allows every model exposed by a provider after live policy validation. */
export interface AllProviderModels {
  readonly kind: "all";
}

/** Allows only the named models for this provider. */
export interface ExplicitProviderModels {
  readonly kind: "allowlist";
  readonly modelIds: readonly ModelId[];
}

export type ProviderModelAllowance = AllProviderModels | ExplicitProviderModels;

export interface AgentProviderAllowance {
  readonly providerId: ProviderId;
  readonly models: ProviderModelAllowance;
}

/**
 * An append-only agent profile revision. Configuration must contain no secret,
 * credential value, or host path. Provider credentials are resolved through
 * session-scoped broker bindings.
 */
export interface AgentProfileRevision {
  readonly id: AgentProfileRevisionId;
  readonly profileId: AgentProfileId;
  readonly revision: number;
  readonly driverId: AgentDriverId;
  readonly displayName: string;
  readonly providers: readonly AgentProviderAllowance[];
  readonly defaultModel?: ModelRef;
  readonly configuration: JsonObject;
  readonly createdAt: IsoTimestamp;
}

/**
 * Immutable model-selection intent recorded on every Turn. A configured
 * default is resolved before admission; agent-selected is explicit rather
 * than represented by an omitted field.
 */
export type TurnModelSelection =
  | {
      readonly kind: "resolved";
      readonly providerId: ProviderId;
      readonly modelId: ModelId;
    }
  | {
      readonly kind: "agent-selected";
      /** Optionally constrain agent selection to one allowed provider. */
      readonly providerId?: ProviderId;
    };

export interface TurnExecutionOptions {
  readonly model: TurnModelSelection;
}

export type WorkspaceAccess = "read-only" | "read-write";

/**
 * A host resource known only to the trusted workspace catalog and supervisor.
 * Agent drivers receive its sandboxPath, never canonicalHostPath.
 */
export interface WorkspaceResource {
  readonly id: WorkspaceResourceId;
  readonly canonicalHostPath: CanonicalHostPath;
  readonly sandboxPath: SandboxPath;
  readonly maximumAccess: WorkspaceAccess;
}

/**
 * An append-only snapshot of one workspace root and its optional extra mounts.
 * Revision pinning does not require a revision-management UI.
 */
export interface WorkspaceRevision {
  readonly id: WorkspaceRevisionId;
  readonly workspaceId: WorkspaceId;
  readonly revision: number;
  readonly displayName: string;
  readonly root: WorkspaceResource;
  readonly mounts: readonly WorkspaceResource[];
  readonly createdAt: IsoTimestamp;
}

export type WorkspaceFilesystemAccess = "none" | "read-only" | "read-write";
export type ProcessAccess = "deny" | "allow";
export type NetworkAccess = "deny" | "host-network" | "egress-proxy";

export interface WorkspaceResourceGrant {
  readonly resourceId: WorkspaceResourceId;
  readonly access: WorkspaceAccess;
}

export interface ResourceLimits {
  readonly memoryBytes?: number;
  readonly maxProcesses?: number;
  readonly temporaryStorageBytes?: number;
  readonly outputBytes?: number;
}

/**
 * The exact immutable policy used to authorize a session. A launch must still
 * verify this snapshot against current installation and principal authority.
 */
export interface ExecutionPolicySnapshot {
  readonly id: ExecutionPolicySnapshotId;
  readonly policyId: ExecutionPolicyId;
  readonly revision: number;
  readonly sandbox: "required";
  readonly workspaceFilesystem: WorkspaceFilesystemAccess;
  readonly resourceGrants: readonly WorkspaceResourceGrant[];
  readonly process: ProcessAccess;
  readonly network: NetworkAccess;
  readonly tools: readonly ToolCapabilityId[];
  readonly limits: ResourceLimits;
  readonly createdAt: IsoTimestamp;
}

/**
 * An immutable capability grant for one exact extension revision. Capability
 * definitions will be designed separately; this record contains no secret.
 */
export interface ExtensionGrantSnapshot {
  readonly id: ExtensionGrantSnapshotId;
  readonly extensionId: ExtensionId;
  readonly extensionRevisionId: ExtensionRevisionId;
  readonly capabilities: readonly ExtensionCapabilityId[];
  readonly createdAt: IsoTimestamp;
}

/**
 * Maps an allowed provider to a broker-owned credential binding. The binding's
 * underlying secret may rotate or be revoked without changing this reference.
 */
export interface SessionProviderBinding {
  readonly providerId: ProviderId;
  readonly credentialBindingId: ProviderCredentialBindingId;
}

/** The complete immutable configuration of a session. */
export interface SessionSpec {
  readonly id: SessionSpecId;
  readonly schemaVersion: 1;
  readonly agentProfileRevisionId: AgentProfileRevisionId;
  readonly workspaceRevisionId: WorkspaceRevisionId;
  readonly executionPolicySnapshotId: ExecutionPolicySnapshotId;
  readonly turnPolicySnapshotId: TurnPolicySnapshotId;
  readonly extensionGrantSnapshotIds: readonly ExtensionGrantSnapshotId[];
  readonly providerBindings: readonly SessionProviderBinding[];
  readonly createdAt: IsoTimestamp;
}

/** Stable session identity and ownership. Configuration lives in SessionSpec. */
export interface Session {
  readonly id: SessionId;
  readonly ownerPrincipalId: PrincipalId;
  readonly specId: SessionSpecId;
  readonly parentSessionId?: SessionId;
  readonly createdAt: IsoTimestamp;
}

/** Mutable presentation metadata; it has no authorization effect. */
export interface SessionMetadata {
  readonly sessionId: SessionId;
  readonly displayName?: string;
  readonly labels: readonly string[];
  readonly updatedAt: IsoTimestamp;
}

export type SessionLifecycleStatus = "active" | "blocked" | "archived";

export interface SessionLifecycle {
  readonly sessionId: SessionId;
  readonly status: SessionLifecycleStatus;
  readonly blockedReason?: string;
  readonly updatedAt: IsoTimestamp;
}

export type SessionRuntimeStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "stopping"
  | "error";

/** Ephemeral/recoverable facts; none of these change session configuration. */
export interface SessionRuntimeState {
  readonly sessionId: SessionId;
  readonly status: SessionRuntimeStatus;
  readonly activeTurnId?: TurnId;
  readonly workerLeaseId?: WorkerLeaseId;
  readonly agentResumeHandleId?: AgentResumeHandleId;
  readonly lastActivityAt?: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

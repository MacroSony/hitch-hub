/**
 * Compile-only v2 execution trust and credential-broker model.
 *
 * Durable records contain authority and lifecycle metadata only. Secure
 * brokered provider secrets remain in the trusted control plane; agent-native
 * custody is an explicit lower-assurance mode. Raw broker capability material
 * exists only in an ephemeral supervisor launch authorization. Hitch never
 * intentionally persists or logs it, returns it through management APIs, or
 * exposes it to connectors.
 */

import type {
  AgentDriverId,
  AgentProfileRevisionId,
  AgentResourceSnapshotId,
  BrokerCapabilityToken,
  BrokerEndpoint,
  CanonicalHostPath,
  CredentialLeaseId,
  ExecutionPolicySnapshotId,
  ExtensionGrantSnapshotId,
  InferenceTransportBridgeId,
  IntegrityDigest,
  InstallationId,
  IsoTimestamp,
  JsonObject,
  ModelId,
  ProviderConnectionId,
  ProviderCredentialBindingId,
  ProviderId,
  SandboxPath,
  SessionId,
  SessionSpecId,
  TurnId,
  WorkerLeaseId,
  WorkspaceResourceId,
  WorkspaceRevisionId,
} from "./primitives.js";
import type { AuditActorRef } from "./identity-access.js";
import type {
  InferenceExecutionMode,
  ProviderCredentialCustody,
  ProviderModelManifest,
} from "./provider-broker.js";
import type {
  ProviderModelAllowance,
  TurnModelSelection,
  TurnReasoningSelection,
  WorkspaceAccess,
} from "./session.js";

declare const sanitizedAgentConfigurationBrand: unique symbol;
declare const sanitizedInferenceTransportConfigurationBrand: unique symbol;
declare const verifiedSupervisorLaunchMountBrand: unique symbol;

/**
 * Produced only by the selected AgentDriver's runtime codec after rejecting
 * secret-bearing fields, host paths, unsafe commands, and unsupported options.
 */
export type SanitizedAgentProfileConfiguration = JsonObject & {
  readonly [sanitizedAgentConfigurationBrand]: true;
};

/**
 * Secret-free bridge/driver projection validated against the exact connection
 * and native stack revision. It cannot carry an origin override or credential.
 */
export type SanitizedInferenceTransportConfiguration = JsonObject & {
  readonly [sanitizedInferenceTransportConfigurationBrand]: true;
};

export type ProviderCredentialBindingState =
  | { readonly status: "active" }
  | {
      readonly status: "revoked";
      readonly revokedAt: IsoTimestamp;
      readonly revokedBy: AuditActorRef;
    };

/**
 * Stable metadata for one provider credential. The real API key, OAuth token,
 * refresh token, and vault locator are deliberately absent. Secure brokered
 * modes resolve it inside the Hitch control plane; `agent-native` explicitly
 * places the native agent and its approved executable extensions in the
 * credential trust boundary.
 */
export interface ProviderCredentialBinding {
  readonly id: ProviderCredentialBindingId;
  readonly installationId: InstallationId;
  readonly providerId: ProviderId;
  readonly custody: ProviderCredentialCustody;
  readonly displayName: string;
  readonly state: ProviderCredentialBindingState;
  readonly createdBy: AuditActorRef;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type WorkerLeaseState =
  | { readonly status: "active" }
  | {
      readonly status: "released" | "expired" | "revoked";
      readonly endedAt: IsoTimestamp;
      readonly reason: string;
    };

/**
 * Fenced ownership of one session runtime. `fencingToken` increases for every
 * lease issued for a session. Repositories, broker requests, and future driver
 * events accept work only from the currently active ID/token pair.
 */
export interface WorkerLease {
  readonly id: WorkerLeaseId;
  readonly sessionId: SessionId;
  readonly fencingToken: number;
  readonly state: WorkerLeaseState;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type CredentialLeaseState =
  | { readonly status: "active" }
  | {
      readonly status: "released" | "expired" | "revoked";
      readonly endedAt: IsoTimestamp;
      readonly reason: string;
    };

/**
 * Durable authorization metadata for one provider connection available to one
 * worker. Raw bearer capability or native credential material is not part of
 * this record. A brokered request also requires this worker to own the
 * session's current active Turn.
 */
export interface CredentialLease {
  readonly id: CredentialLeaseId;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly credentialBindingId: ProviderCredentialBindingId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerId: ProviderId;
  readonly transportMode: InferenceExecutionMode;
  readonly allowedModels: ProviderModelAllowance;
  readonly state: CredentialLeaseState;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Raw runtime capability passed to an agent as its provider API credential.
 * It authorizes use of the broker only and can never authenticate directly to
 * an upstream provider. Persist only a one-way verifier, never this token.
 */
export interface RuntimeBrokerCapability {
  readonly credentialLeaseId: CredentialLeaseId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly providerId: ProviderId;
  readonly transportMode: Exclude<InferenceExecutionMode, "agent-native">;
  readonly bridgeId: InferenceTransportBridgeId;
  readonly endpoint: BrokerEndpoint;
  readonly bearerToken: BrokerCapabilityToken;
}

/**
 * Ephemeral result of trusted launch-time source identity and destination
 * validation. Only the supervisor mount resolver may apply this brand.
 */
export interface VerifiedSupervisorLaunchMount {
  readonly [verifiedSupervisorLaunchMountBrand]: true;
  readonly resourceId?: WorkspaceResourceId;
  readonly canonicalHostPath: CanonicalHostPath;
  readonly sandboxPath: SandboxPath;
  readonly access: WorkspaceAccess;
  readonly purpose:
    | "workspace"
    | "state"
    | "agent-runtime"
    | "agent-resource";
}

/**
 * Provider configuration projected into the runtime. Brokered modes contain
 * only a local capability. Agent-native mode contains no credential value in
 * this domain object; the trusted supervisor's native-auth renderer supplies
 * the agent-owned credential projection outside the driver contract.
 */
export type AgentProviderRuntimeConfiguration =
  | {
      readonly kind: "brokered";
      readonly providerConnectionId: ProviderConnectionId;
      readonly providerId: ProviderId;
      readonly transportMode: Exclude<InferenceExecutionMode, "agent-native">;
      readonly bridgeId: InferenceTransportBridgeId;
      readonly broker: RuntimeBrokerCapability;
      readonly models: readonly [
        ProviderModelManifest,
        ...ProviderModelManifest[],
      ];
      readonly transportConfiguration: SanitizedInferenceTransportConfiguration;
    }
  | {
      readonly kind: "agent-native";
      readonly providerConnectionId: ProviderConnectionId;
      readonly providerId: ProviderId;
      readonly transportMode: "agent-native";
      readonly credentialLeaseId: CredentialLeaseId;
      readonly credentialCustody: "agent-runtime";
      readonly models: readonly [
        ProviderModelManifest,
        ...ProviderModelManifest[],
      ];
      readonly transportConfiguration: SanitizedInferenceTransportConfiguration;
    };

export interface AgentTurnProviderCatalog {
  readonly providerId: ProviderId;
  /**
   * Profile-allowed models filtered by live policy and exact support for this
   * Turn's reasoning intent. Discovery is always an explicit non-empty set.
   */
  readonly eligibleModelIds: readonly [ModelId, ...ModelId[]];
}

/**
 * Per-Turn inference projection supplied at dispatch. Agent-selected catalogs
 * are filtered before admission; resolved selections name exactly one model.
 */
export type AgentTurnInferenceConfiguration =
  | {
      readonly turnId: TurnId;
      readonly selection: Extract<
        TurnModelSelection,
        { readonly kind: "resolved" }
      >;
      readonly reasoning: TurnReasoningSelection;
    }
  | {
      readonly turnId: TurnId;
      readonly selection: Extract<
        TurnModelSelection,
        { readonly kind: "agent-selected" }
      >;
      readonly reasoning: TurnReasoningSelection;
      readonly agentSelectedCatalog: readonly [
        AgentTurnProviderCatalog,
        ...AgentTurnProviderCatalog[],
      ];
    };

/**
 * Explicit resources projected into one runtime. A driver receives only
 * verified sandbox paths. Declarative resources may influence the model;
 * extensions additionally execute with the worker's full sandbox authority.
 */
export type AgentRuntimeResource =
  | {
      readonly kind: "skill" | "prompt-template" | "theme";
      readonly trust: "agent-instruction";
      readonly snapshotId: AgentResourceSnapshotId;
      readonly integrityDigest: IntegrityDigest;
      readonly sandboxPath: SandboxPath;
    }
  | {
      readonly kind: "extension";
      readonly trust: "worker-executable";
      readonly grantSnapshotId: ExtensionGrantSnapshotId;
      readonly integrityDigest: IntegrityDigest;
      readonly sandboxPath: SandboxPath;
      readonly loading: "explicit-pinned";
      readonly promptLifecycle: "agent-loop-preserving";
      /** Secret-free, host-path-free values validated at publication/launch. */
      readonly configuration: JsonObject;
    };

/**
 * The only launch-time configuration projection an AgentDriver may give the
 * agent.
 */
export interface SanitizedAgentRuntimeConfiguration {
  readonly driverId: AgentDriverId;
  readonly workingDirectory: SandboxPath;
  readonly providers: readonly [
    AgentProviderRuntimeConfiguration,
    ...AgentProviderRuntimeConfiguration[],
  ];
  readonly resources: readonly AgentRuntimeResource[];
  readonly profileConfiguration: SanitizedAgentProfileConfiguration;
}

/**
 * Ephemeral trusted-supervisor authorization produced after live
 * reauthorization. It is not yet an executable process specification and is
 * not a database record because it contains raw broker capabilities and
 * canonical host paths. Agent drivers receive only `agentConfiguration`.
 */
export interface SupervisorLaunchAuthorization {
  readonly sessionId: SessionId;
  readonly sessionSpecId: SessionSpecId;
  readonly workerLease: WorkerLease;
  readonly agentProfileRevisionId: AgentProfileRevisionId;
  readonly workspaceRevisionId: WorkspaceRevisionId;
  readonly executionPolicySnapshotId: ExecutionPolicySnapshotId;
  readonly agentResourceSnapshotIds: readonly AgentResourceSnapshotId[];
  readonly extensionGrantSnapshotIds: readonly ExtensionGrantSnapshotId[];
  readonly mounts: readonly VerifiedSupervisorLaunchMount[];
  readonly credentialLeases: readonly CredentialLease[];
  readonly agentConfiguration: SanitizedAgentRuntimeConfiguration;
  readonly createdAt: IsoTimestamp;
}

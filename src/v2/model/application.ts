/**
 * Compile-only v2 application command and persistence-boundary contracts.
 *
 * Connector commands contain only caller-controlled intent. Authentication,
 * endpoint routing, Turn origins, SessionSpecs, authorization results, and
 * database transaction handles are constructed by trusted adapters/services.
 * The semantic units below deliberately replace generic CRUD repositories.
 */

import type {
  AgentDispatchAttemptId,
  AgentProfileId,
  AgentResourceSnapshotId,
  AgentResumeHandleId,
  AuthenticationSubjectId,
  AuthenticationRequestId,
  ClientCertificateFingerprint,
  ConfigurationReference,
  CredentialLeaseId,
  EndpointId,
  ExecutionPolicyId,
  ExtensionId,
  ExtensionRevisionId,
  Id,
  IdentityBindingId,
  InferenceForwardingAttemptId,
  InferenceRequestReservationId,
  InferenceTransportBridgeId,
  InstallationId,
  IntegrityDigest,
  IsoTimestamp,
  LocalEndpointId,
  LocalHostId,
  OriginMessageId,
  PrincipalId,
  ProviderConnectionId,
  SessionId,
  TurnPolicyId,
  TurnId,
  TurnIdempotencyKey,
  TurnInteractionId,
  TurnInteractionResponseId,
  TurnResponseDeliveryAttemptId,
  TurnResponseDeliveryId,
  WorkerLeaseId,
  WorkspaceId,
  WorkspaceRevisionId,
} from "./primitives.js";
import type {
  AuditSystemComponent,
  AuthenticatedPrincipal,
  AuthorizationDecision,
  IdentityBinding,
  InstallationRoleGrant,
  PrincipalWorkspaceBinding,
  Principal,
  SessionConfigurationUseGrant,
} from "./identity-access.js";
import type {
  AgentResumeHandle,
  AuditAction,
  AuditEnvelope,
  Attachment,
  FinalizedTurnResponseMessage,
  Installation,
  TurnRecoveryRecord,
  TurnResponseDelivery,
  TurnResponseDeliveryAttempt,
  TurnResponseDeliveryAttemptState,
  TurnResponseDeliveryState,
  TurnInteractionResponseDispatch,
  TurnTerminalResponse,
} from "./records.js";
import type {
  CredentialLease,
  ProviderCredentialBinding,
  WorkerLease,
} from "./runtime-security.js";
import type {
  AgentProfileRevision,
  AgentResourceSnapshot,
  ExecutionPolicySnapshot,
  ExtensionGrantSnapshot,
  ExtensionRevision,
  Session,
  SessionLifecycle,
  SessionMetadata,
  SessionRuntimeState,
  SessionSpec,
  WorkspaceRevision,
} from "./session.js";
import type { Endpoint, SessionEndpointBinding } from "./endpoint-binding.js";
import type {
  AgentInteractionResponseAuthorization,
  AgentInteractionResponseDeliveryOutcome,
  AgentPromptAcceptanceOutcome,
  ArmedProtocolPromptSubmission,
  ProtocolPromptSubmissionOutcome,
  SendStartedAgentInteractionResponse,
} from "./agent-runtime.js";
import type {
  CheckpointTurnEventPayload,
  PromptAcceptanceEvidence,
  Turn,
  TurnInferenceResolution,
  TurnInputSnapshot,
  TurnInteraction,
  TurnInteractionResolution,
  TurnApprovalInteractionRequest,
  TurnLifecycleState,
  TurnPolicySnapshot,
  TurnReceipt,
  TurnResult,
  TurnRuntimeState,
} from "./turn.js";
import type {
  BoundProviderInvocation,
  PreparedProviderInferenceRequest,
  ProviderForwardAuthorization,
  ProviderForwardAuthorizationResult,
  ProviderRequestAuthorizationContext,
  ProviderReservationAuthorization,
  ProviderReservationAuthorizationResult,
  ProviderConnectionSpec,
  ProviderUsageObservation,
  SendStartedProviderInvocation,
} from "./provider-broker.js";

declare const acceptedLocalConnectorBrand: unique symbol;
declare const verifiedClientCertificateEvidenceBrand: unique symbol;
declare const authenticatedConnectorContextBrand: unique symbol;
declare const trustedServiceAuthorizationContextBrand: unique symbol;
declare const boundedConnectorImageUploadBrand: unique symbol;
declare const preparedAttachmentAdmissionBrand: unique symbol;
declare const deliveryAuthorizationRevocationBrand: unique symbol;

/** Audit envelopes narrowed to the semantic action owned by a unit of work. */
export type AuditEnvelopeFor<Action extends AuditAction> = Extract<
  AuditEnvelope,
  { readonly action: Action }
>;

export type AuditEventsFor<Action extends AuditAction> =
  readonly AuditEnvelopeFor<Action>[];

export type RequiredAuditEventsFor<Action extends AuditAction> = readonly [
  AuditEnvelopeFor<Action>,
  ...AuditEnvelopeFor<Action>[],
];

/** Production time source; application code never reads the ambient clock. */
export interface Clock {
  now(): IsoTimestamp;
}

/** Kinds allocated by the trusted service, rather than by connectors/drivers. */
export type ServiceAllocatedIdKind =
  | "Installation"
  | "Principal"
  | "IdentityBinding"
  | "AuthenticationRequest"
  | "LocalHost"
  | "AccessGrant"
  | "Session"
  | "SessionSpec"
  | "SessionEndpointBinding"
  | "Endpoint"
  | "Turn"
  | "TurnPolicy"
  | "TurnPolicySnapshot"
  | "TurnInputSnapshot"
  | "TurnEvent"
  | "TurnMessage"
  | "TurnInteraction"
  | "TurnInteractionOption"
  | "TurnInteractionResponse"
  | "ToolInvocation"
  | "AgentDispatchAttempt"
  | "Attachment"
  | "PrivateBlob"
  | "WorkerLease"
  | "CredentialLease"
  | "AgentResumeHandle"
  | "InferenceRequestReservation"
  | "InferenceForwardingAttempt"
  | "TurnTerminalResponse"
  | "TurnResponseDelivery"
  | "TurnResponseDeliveryAttempt"
  | "AuditEnvelope"
  | "AgentDriver"
  | "AgentDriverLaunchProfile"
  | "AgentDriverPermissionMediation"
  | "AgentProfile"
  | "AgentProfileRevision"
  | "AgentResourceSnapshot"
  | "Provider"
  | "ProviderConnection"
  | "Model"
  | "ProviderCredentialBinding"
  | "Workspace"
  | "WorkspaceRevision"
  | "WorkspaceResource"
  | "ExecutionPolicy"
  | "ExecutionPolicySnapshot"
  | "ToolCapability"
  | "Extension"
  | "ExtensionRevision"
  | "ExtensionGrantSnapshot"
  | "ExtensionCapability";

/** Production ID/randomness source; callers never select a durable Hitch ID. */
export interface IdSource {
  next<Kind extends ServiceAllocatedIdKind>(kind: Kind): Id<Kind>;
  nextTurnIdempotencyKey(): TurnIdempotencyKey;
  nextOriginMessageId(): OriginMessageId;
}

/**
 * Opaque accepted local connection. Only the socket listener may construct it;
 * it carries no caller-supplied principal, endpoint, role, or grant.
 */
export interface AcceptedLocalConnectorConnection {
  readonly [acceptedLocalConnectorBrand]: true;
}

/**
 * One-shot transport evidence minted only after Hitch has verified the mTLS
 * connection and its complete leaf certificate. Protocol data cannot
 * construct or populate this value.
 */
export interface VerifiedClientCertificateEvidence {
  readonly [verifiedClientCertificateEvidenceBrand]: true;
}

/**
 * Trusted request context minted by authentication. Its public principal is
 * useful for audit attribution, but the unforgeable brand is the authority
 * accepted by application entry points.
 */
export interface AuthenticatedConnectorContext {
  readonly [authenticatedConnectorContextBrand]: true;
  readonly actor: AuthenticatedPrincipal;
  /** Trusted local endpoint for routing and Turn-origin derivation. */
  readonly endpointId: EndpointId;
}

/**
 * Service-only subject for recovery, dispatch, broker, and delivery work that
 * is not executing on an open connector request. Persisted data and driver
 * events cannot construct this context.
 */
export interface TrustedServiceAuthorizationContext<
  Component extends AuditSystemComponent = AuditSystemComponent,
> {
  readonly [trustedServiceAuthorizationContextBrand]: Component;
  readonly actor: {
    readonly kind: "system";
    readonly component: Component;
  };
}

export type TrustedAuthorizationContext =
  | AuthenticatedConnectorContext
  | TrustedServiceAuthorizationContext;

/** Background components allowed to receive runtime service authority. */
export type BackgroundServiceAuthorizationComponent =
  | "turn-coordinator"
  | "supervisor"
  | "broker"
  | "delivery"
  | "recovery";

export type ConnectorAuthenticationResult =
  | { readonly status: "authenticated"; readonly context: AuthenticatedConnectorContext }
  | {
      readonly status: "rejected";
      readonly authenticationRequestId: AuthenticationRequestId;
      readonly reason: "unknown-binding" | "binding-revoked" | "principal-disabled";
    };

/** Authentication owns evidence collection and AuthenticationRequest creation. */
export interface LocalConnectorAuthenticationPort {
  authenticate(
    connection: AcceptedLocalConnectorConnection,
  ): Promise<ConnectorAuthenticationResult>;
}

/** Remote authentication consumes only verifier-minted transport evidence. */
export interface RemoteConnectorAuthenticationPort {
  authenticate(
    evidence: VerifiedClientCertificateEvidence,
  ): Promise<ConnectorAuthenticationResult>;
}

/** A connector cannot carry an authorization assertion in its command. */
export type ConnectorCommand =
  | CreateSessionConnectorCommand
  | SubmitTurnConnectorCommand
  | GetTurnConnectorCommand
  | CancelTurnConnectorCommand
  | StopSessionConnectorCommand
  | ResolveInteractionConnectorCommand;

export interface CreateSessionConnectorCommand {
  readonly kind: "create-session";
  /** Stable configuration names resolved by trusted configuration services. */
  readonly profileReference: string;
  readonly workspaceReference: string;
  readonly displayName?: string;
}

/**
 * Opaque intake handle minted by the trusted local connector only after it has
 * enforced the installation's request framing and attachment byte ceiling.
 * V2-001B2 defines the staging port that consumes it without materializing an
 * unbounded caller-owned `Uint8Array`.
 */
export interface BoundedConnectorImageUpload {
  readonly [boundedConnectorImageUploadBrand]: true;
  readonly byteLength: number;
}

export type SessionSelector =
  | { readonly kind: "session-id"; readonly sessionId: SessionId }
  | { readonly kind: "session-name"; readonly name: string };

export interface SubmitTurnConnectorCommand {
  readonly kind: "submit-turn";
  /** ID or owner-scoped name, resolved and authorized during Turn admission. */
  readonly session: SessionSelector;
  readonly idempotencyKey: TurnIdempotencyKey;
  readonly text: string;
  /**
   * Trusted bounded intake, not a host path, durable AttachmentId, or
   * caller-owned byte array. The application MIME-sniffs, hashes, and privately
   * stages it before a durable AttachmentId exists.
   */
  readonly image?: BoundedConnectorImageUpload;
}

export interface GetTurnConnectorCommand {
  readonly kind: "get-turn";
  readonly turnId: TurnId;
}

export interface CancelTurnConnectorCommand {
  readonly kind: "cancel-turn";
  readonly turnId: TurnId;
}

export interface StopSessionConnectorCommand {
  readonly kind: "stop-session";
  readonly sessionId: SessionId;
}

/** Input responses are intentionally absent: first-slice CLI exposes approval only. */
export interface ResolveInteractionConnectorCommand {
  readonly kind: "resolve-interaction";
  readonly interactionId: TurnInteractionId;
  readonly decision: "approve" | "deny";
}

/**
 * Sanitized response stream attached to the command connection. It is a
 * delivery/subscription projection, never a driver event stream or a means to
 * mutate authoritative Turn state.
 */
export type ConnectorResponseEvent =
  | {
      readonly kind: "turn-checkpoint";
      readonly turnId: TurnId;
      readonly sequence: number;
      readonly payload: CheckpointTurnEventPayload;
    }
  | {
      readonly kind: "approval-requested";
      readonly turnId: TurnId;
      readonly interactionId: TurnInteractionId;
      readonly request: TurnApprovalInteractionRequest;
    }
  | {
      readonly kind: "turn-terminal";
      readonly response: TurnTerminalResponse;
    }
  | {
      readonly kind: "response-delivery-state";
      readonly turnId: TurnId;
      readonly deliveryId: TurnResponseDeliveryId;
      readonly state: "pending" | "delivering" | "delivered" | "retryable-failure" | "failed" | "suppressed" | "expired";
    };

export interface AttachedConnectorResponseStream {
  readonly events: AsyncIterable<ConnectorResponseEvent>;
  close(): Promise<void>;
}

type NonterminalTurnRuntimeState = TurnRuntimeState & {
  readonly state: Exclude<TurnLifecycleState, { readonly status: "terminal" }>;
};

type TerminalTurnRuntimeState = TurnRuntimeState & {
  readonly state: Extract<TurnLifecycleState, { readonly status: "terminal" }>;
};

type TurnRuntimeAt<
  Status extends TurnLifecycleState["status"],
> = TurnRuntimeState & {
  readonly state: Extract<TurnLifecycleState, { readonly status: Status }>;
};

export type ConnectorCommandSuccess<Command extends ConnectorCommand> =
  Command extends CreateSessionConnectorCommand
    ? { readonly kind: "session-created"; readonly sessionId: SessionId }
    : Command extends SubmitTurnConnectorCommand
      ? { readonly kind: "turn-submitted"; readonly receipt: TurnReceipt }
      : Command extends GetTurnConnectorCommand
        ? (
            | {
                readonly kind: "turn-found";
                readonly turnId: TurnId;
                readonly status: "active";
                readonly runtime: NonterminalTurnRuntimeState;
              }
            | {
                readonly kind: "turn-found";
                readonly turnId: TurnId;
                readonly status: "terminal";
                readonly runtime: TerminalTurnRuntimeState;
                readonly terminalResponse: TurnTerminalResponse;
              }
          )
        : Command extends CancelTurnConnectorCommand
          ? (
              | {
                    readonly kind: "turn-cancelled" | "turn-already-cancelled";
                    readonly turnId: TurnId;
                  }
              | {
                    readonly kind: "turn-not-cancelled";
                    readonly turnId: TurnId;
                    readonly reason:
                      | "turn-not-queued-or-active"
                      | "already-terminal";
                  }
            )
          : Command extends StopSessionConnectorCommand
            ? {
                readonly kind:
                  | "session-stop-requested"
                  | "session-already-stopped";
                readonly sessionId: SessionId;
              }
            : Command extends ResolveInteractionConnectorCommand
              ? {
                  readonly kind:
                    | "interaction-resolved"
                    | "interaction-not-pending";
                  readonly interactionId: TurnInteractionId;
                }
              : never;

export type ConnectorCommandFailureCode =
  | "not-authorized"
  | "not-found"
  | "invalid-request"
  | "queue-capacity-exceeded"
  | "conflict"
  | "temporarily-unavailable";

export type LocalAdministrationCommand =
  | {
      readonly kind: "create-principal";
      readonly principalReference: string;
      readonly displayName: string;
      readonly role: "admin" | "member";
      readonly workspaceReference: string;
      readonly canonicalWorkspaceRoot: string;
    }
  | {
      readonly kind: "disable-principal";
      readonly principalReference: string;
    }
  | {
      readonly kind: "bind-client-certificate";
      readonly principalReference: string;
      readonly bindingReference: string;
      readonly completeDer: Uint8Array;
    }
  | {
      readonly kind: "revoke-client-certificate";
      readonly bindingReference: string;
    };

export type LocalAdministrationSuccess =
  | {
      readonly kind: "principal-created";
      readonly principalId: PrincipalId;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly kind: "principal-disabled" | "principal-already-disabled";
      readonly principalId: PrincipalId;
    }
  | {
      readonly kind: "client-certificate-bound";
      readonly principalId: PrincipalId;
      readonly identityBindingId: IdentityBindingId;
      readonly fingerprint: ClientCertificateFingerprint;
    }
  | {
      readonly kind:
        | "client-certificate-revoked"
        | "client-certificate-already-revoked";
      readonly identityBindingId: IdentityBindingId;
    };

export type LocalAdministrationResponse =
  | { readonly status: "succeeded"; readonly result: LocalAdministrationSuccess }
  | { readonly status: "rejected"; readonly code: ConnectorCommandFailureCode };

/** Elevated owner-private administration; never passed to remote ingress. */
export interface LocalAdministrationPort {
  execute(
    context: AuthenticatedConnectorContext,
    command: LocalAdministrationCommand,
  ): Promise<LocalAdministrationResponse>;
}

export type ConnectorCommandResponse<Command extends ConnectorCommand> =
  | {
      readonly status: "rejected";
      readonly code: ConnectorCommandFailureCode;
    }
  | (Command extends SubmitTurnConnectorCommand
      ? {
          readonly status: "succeeded";
          readonly result: ConnectorCommandSuccess<Command>;
          readonly responseEvents: AttachedConnectorResponseStream;
        }
      : {
          readonly status: "succeeded";
          readonly result: ConnectorCommandSuccess<Command>;
        });

/** The only application ingress used by the local connector. */
export interface FirstSliceConnectorApplication {
  execute<Command extends ConnectorCommand>(
    context: AuthenticatedConnectorContext,
    command: Command,
  ): Promise<ConnectorCommandResponse<Command>>;
}

export type AuthorizedTurnResultQuery =
  | ConnectorCommandSuccess<GetTurnConnectorCommand>
  | { readonly kind: "turn-not-found" }
  | { readonly kind: "turn-read-denied" };

/**
 * Semantic result projection. The query rechecks current read authority and
 * never exposes internal events, driver output, or a terminal result without
 * its immutable terminal response.
 */
export interface TurnResultQueryPort {
  queryAuthorizedTurnResult(input: {
    readonly context: AuthenticatedConnectorContext;
    readonly turnId: TurnId;
  }): Promise<AuthorizedTurnResultQuery>;
}

/**
 * Operations evaluated against current, revocable state. No command contains
 * an instance of this result; only the authorization service can mint it.
 */
export type LiveAuthorizationAction =
  | "session-create"
  | "turn-submit"
  | "turn-read"
  | "turn-cancel"
  | "session-stop"
  | "interaction-resolve"
  | "turn-dispatch"
  | "worker-lease"
  | "credential-lease"
  | "inference-reserve"
  | "response-deliver";

export type LiveAuthorizationSubject<Action extends LiveAuthorizationAction> =
  Action extends "session-create"
    ? { readonly profileReference: string; readonly workspaceReference: string }
    : Action extends "turn-submit"
      ? { readonly session: SessionSelector }
    : Action extends "session-stop" | "turn-dispatch" | "worker-lease" | "credential-lease"
      ? { readonly sessionId: SessionId }
      : Action extends "turn-read" | "turn-cancel" | "inference-reserve"
        ? { readonly turnId: TurnId }
        : Action extends "interaction-resolve"
          ? { readonly interactionId: TurnInteractionId }
          : Action extends "response-deliver"
            ? { readonly deliveryId: TurnResponseDeliveryId }
            : never;

/**
 * The long-running service obtains a sealed context immediately before a
 * background authorization check. It cannot reuse a connector context after
 * disconnect or reconstruct one from a persisted principal ID.
 */
export interface ServiceAuthorizationContextPort {
  forComponent<Component extends BackgroundServiceAuthorizationComponent>(
    component: Component,
  ): Promise<TrustedServiceAuthorizationContext<Component>>;
}

type TurnCoordinatorServiceContext = TrustedServiceAuthorizationContext<
  "turn-coordinator" | "recovery"
>;
type SupervisorServiceContext = TrustedServiceAuthorizationContext<
  "supervisor" | "recovery"
>;
type BrokerServiceContext = TrustedServiceAuthorizationContext<
  "broker" | "recovery"
>;
type DeliveryServiceContext = TrustedServiceAuthorizationContext<
  "delivery" | "recovery"
>;
type TurnControlAuthorizationContext =
  | AuthenticatedConnectorContext
  | TurnCoordinatorServiceContext;

/**
 * Advisory/read-side live authorization. Its decision is diagnostic only and
 * cannot be supplied to a write operation as reusable authority. Every
 * semantic write unit below accepts the trusted request/service context and
 * repeats its exact authorization checks against the same transaction view.
 */
export interface LiveAuthorizationPort {
  evaluate<Action extends LiveAuthorizationAction>(
    context: TrustedAuthorizationContext,
    action: Action,
    subject: LiveAuthorizationSubject<Action>,
  ): Promise<AuthorizationDecision>;
}

/**
 * Private attachment intake creates this sealed value after bounding,
 * MIME-sniffing, hashing, and staging a Hitch-owned copy. A connector command
 * can carry bytes, but it can never choose a durable AttachmentId.
 */
export interface PreparedAttachmentAdmission {
  readonly [preparedAttachmentAdmissionBrand]: true;
  readonly attachment: Attachment;
}

/**
 * Stable configuration identities whose append-only revisions are published
 * below. Every normalized `reference` is immutable and unique for its resource
 * kind within one installation; display names are presentation only.
 */
export interface WorkspaceResourceIdentity {
  readonly id: WorkspaceId;
  readonly installationId: InstallationId;
  readonly reference: ConfigurationReference;
  readonly displayName: string;
  readonly createdAt: IsoTimestamp;
}

export interface AgentProfileResourceIdentity {
  readonly id: AgentProfileId;
  readonly installationId: InstallationId;
  readonly reference: ConfigurationReference;
  readonly displayName: string;
  readonly createdAt: IsoTimestamp;
}

export interface ExecutionPolicyResourceIdentity {
  readonly id: ExecutionPolicyId;
  readonly installationId: InstallationId;
  readonly reference: ConfigurationReference;
  readonly displayName: string;
  readonly createdAt: IsoTimestamp;
}

export interface TurnPolicyResourceIdentity {
  readonly id: TurnPolicyId;
  readonly installationId: InstallationId;
  readonly reference: ConfigurationReference;
  readonly displayName: string;
  readonly createdAt: IsoTimestamp;
}

export interface ExtensionResourceIdentity {
  readonly id: ExtensionId;
  readonly installationId: InstallationId;
  readonly reference: ConfigurationReference;
  readonly displayName: string;
  readonly createdAt: IsoTimestamp;
}

/**
 * Durable lookup aliases used to make bootstrap publication idempotent without
 * treating configuration references as caller-selected durable IDs.
 */
export interface BootstrapPublicationReferenceBindings {
  readonly installation: {
    readonly reference: ConfigurationReference;
    readonly installationId: InstallationId;
    readonly displayName: string;
  };
  readonly owner: {
    readonly reference: ConfigurationReference;
    readonly principalId: PrincipalId;
  };
  readonly localHost: {
    readonly reference: ConfigurationReference;
    readonly localHostId: LocalHostId;
  };
  readonly identityBinding: {
    readonly reference: ConfigurationReference;
    readonly identityBindingId: IdentityBindingId;
  };
  readonly subject: {
    readonly reference: ConfigurationReference;
    readonly resolution: ConfigurationReference;
    readonly authenticationSubjectId: AuthenticationSubjectId;
  };
  readonly endpoint: {
    readonly reference: ConfigurationReference;
    readonly endpointId: EndpointId;
    readonly localEndpointId: LocalEndpointId;
  };
  readonly workspace: {
    readonly bindingReference: ConfigurationReference;
    readonly workspaceId: WorkspaceId;
    readonly workspaceRevisionId: WorkspaceRevisionId;
  };
}

/**
 * Durable content-addressed lookup metadata. V2-004 retains these bindings in
 * the same transaction as their snapshots/revisions so a pinned SessionSpec
 * remains resolvable after the current bootstrap configuration changes.
 */
export interface BootstrapPublicationArtifactBindings {
  readonly declarative: readonly {
    readonly agentResourceSnapshotId: AgentResourceSnapshotId;
    readonly artifactReference: ConfigurationReference;
    readonly integrityDigest: IntegrityDigest;
    readonly kind: "skill" | "prompt-template" | "theme";
  }[];
  readonly extensions: readonly {
    readonly extensionRevisionId: ExtensionRevisionId;
    readonly artifactReference: ConfigurationReference;
    readonly integrityDigest: IntegrityDigest;
  }[];
  readonly provider: {
    readonly providerConnectionId: ProviderConnectionId;
    readonly bridgeId: InferenceTransportBridgeId;
    readonly bridgeArtifactDigest: IntegrityDigest;
    readonly nativeStack: "pi-ai" | "other";
    readonly nativeStackVersion: string;
    readonly nativeStackDigest: IntegrityDigest;
    readonly nativeCatalogDigest: IntegrityDigest;
  };
}

/** Complete deterministic bootstrap graph published in one transaction. */
export interface BootstrapPublicationRecords {
  readonly installation: Installation;
  readonly owner: Principal;
  readonly ownerWorkspaceBinding: PrincipalWorkspaceBinding;
  readonly localIdentityBinding: IdentityBinding;
  readonly localEndpoint: Endpoint;
  readonly accessGrants: readonly (
    | InstallationRoleGrant
    | SessionConfigurationUseGrant
  )[];
  readonly workspace: WorkspaceResourceIdentity;
  readonly workspaceRevision: WorkspaceRevision;
  readonly agentProfile: AgentProfileResourceIdentity;
  readonly agentProfileRevision: AgentProfileRevision;
  readonly executionPolicy: ExecutionPolicyResourceIdentity;
  readonly executionPolicySnapshot: ExecutionPolicySnapshot;
  readonly turnPolicy: TurnPolicyResourceIdentity;
  readonly turnPolicySnapshot: TurnPolicySnapshot;
  readonly agentResourceSnapshots: readonly AgentResourceSnapshot[];
  readonly extensions: readonly ExtensionResourceIdentity[];
  readonly extensionRevisions: readonly ExtensionRevision[];
  readonly extensionGrantSnapshots: readonly ExtensionGrantSnapshot[];
  readonly providerConnection: ProviderConnectionSpec;
  readonly providerCredentialBinding: ProviderCredentialBinding;
  readonly referenceBindings: BootstrapPublicationReferenceBindings;
  readonly artifactBindings: BootstrapPublicationArtifactBindings;
}

export interface BootstrapPublicationUnitOfWork {
  /**
   * The method owns exactly one database transaction. It returns only after
   * commit; its implementation cannot call an injected process/runtime port.
   */
  publishBootstrap(
    records: BootstrapPublicationRecords,
  ): Promise<
    | {
        readonly status: "published";
        readonly installation: Installation;
        readonly owner: Principal;
        readonly localIdentityBinding: IdentityBinding;
        readonly localEndpoint: Endpoint;
        readonly auditEvents: RequiredAuditEventsFor<"installation-published">;
      }
    | {
        readonly status: "unchanged";
        readonly installation: Installation;
        readonly owner: Principal;
        readonly localIdentityBinding: IdentityBinding;
        readonly localEndpoint: Endpoint;
        readonly auditEvents: readonly [];
      }
  >;
}

export interface SessionCreationUnitOfWork {
  /**
   * Resolves both stable references, selects their current append-only
   * revisions, rechecks configuration-use grants, pins the SessionSpec, and
   * creates the private endpoint binding in this one transaction.
   */
  createPrivateSession(input: {
    readonly context: AuthenticatedConnectorContext;
    readonly profileReference: string;
    readonly workspaceReference: string;
    readonly displayName?: string;
  }): Promise<
    | {
        readonly status: "created";
        readonly session: Session;
        readonly spec: SessionSpec;
        readonly metadata: SessionMetadata;
        readonly lifecycle: SessionLifecycle & { readonly status: "active" };
        readonly runtime: SessionRuntimeState & { readonly status: "idle" };
        readonly endpointBinding: SessionEndpointBinding;
        readonly auditEvents: RequiredAuditEventsFor<"session-created">;
      }
    | {
        readonly status: "not-found";
        readonly missing: "profile" | "workspace";
        readonly auditEvents: RequiredAuditEventsFor<"session-creation-denied">;
      }
    | {
        readonly status: "denied";
        readonly reason: "principal-disabled" | "binding-inactive";
        readonly auditEvents: RequiredAuditEventsFor<"session-creation-denied">;
      }
    | {
        readonly status: "denied";
        readonly reason: "required-configuration-use-revoked";
        readonly resourceKind: SessionConfigurationUseGrant["resource"]["kind"];
        readonly auditEvents: RequiredAuditEventsFor<"session-creation-denied">;
      }
  >;
}

export interface SessionStopQueuedTurnResult {
  readonly turnId: TurnId;
  readonly terminalResponse: TurnTerminalResponse;
  readonly delivery: TurnResponseDelivery;
}

/**
 * Stops current runtime work without archiving or blocking the reusable
 * Session. It terminalizes every queued Turn with its delivery outbox and
 * records cancellation intent for the active Turn in one transaction. A later
 * prompt may start new work while the lifecycle remains active; any returned
 * driver cancellation is performed outside the transaction.
 */
export interface SessionStopUnitOfWork {
  stopPrivateSession(input: {
    readonly context: AuthenticatedConnectorContext;
    readonly sessionId: SessionId;
  }): Promise<
    | {
        readonly status: "stop-recorded-idle";
        readonly lifecycle: SessionLifecycle;
        readonly runtime: SessionRuntimeState & { readonly status: "idle" };
        readonly queuedTurns: readonly SessionStopQueuedTurnResult[];
        readonly auditEvents: readonly [
          AuditEnvelopeFor<"session-runtime-stop-recorded">,
          ...AuditEnvelopeFor<
            | "turn-state-transitioned"
            | "turn-terminalized"
            | "response-delivery-created"
          >[],
        ];
      }
    | {
        readonly status: "stop-recorded-stopping";
        readonly lifecycle: SessionLifecycle;
        readonly runtime: SessionRuntimeState & { readonly status: "stopping" };
        readonly queuedTurns: readonly SessionStopQueuedTurnResult[];
        readonly activeCancellation: {
          readonly turnId: TurnId;
          readonly runtime: TurnRuntimeAt<"cancelling">;
        };
        readonly auditEvents: readonly [
          AuditEnvelopeFor<"session-runtime-stop-recorded">,
          ...AuditEnvelopeFor<
            | "turn-state-transitioned"
            | "turn-terminalized"
            | "response-delivery-created"
          >[],
        ];
      }
    | {
        readonly status: "already-stopped";
        readonly lifecycle: SessionLifecycle;
        readonly runtime: SessionRuntimeState & { readonly status: "idle" };
        readonly auditEvents: readonly [];
      }
    | {
        readonly status: "not-found" | "denied";
        readonly auditEvents: readonly [];
      }
  >;
}

export type TurnAdmissionResult =
  | {
      readonly status: "admitted";
      readonly turn: Turn;
      readonly inputSnapshot: TurnInputSnapshot;
      readonly runtime: TurnRuntimeAt<"queued">;
      readonly inferenceResolution: TurnInferenceResolution;
      readonly attachment?: Attachment;
      readonly receipt: TurnReceipt;
      readonly auditEvents: readonly [
        AuditEnvelopeFor<"turn-admitted">,
        ...AuditEnvelopeFor<"attachment-admitted">[],
      ];
    }
  | {
      readonly status: "duplicate";
      readonly turnId: TurnId;
      readonly receipt: TurnReceipt;
    }
  | {
      readonly status: "queue-capacity-exceeded";
    }
  | {
      readonly status: "session-not-found" | "session-name-ambiguous" | "denied";
    };

export interface TurnAdmissionUnitOfWork {
  admitTurn(input: {
    readonly context: AuthenticatedConnectorContext;
    /**
     * Resolves an owner-scoped name and rechecks the resulting Session binding
     * in the same transaction as idempotency and queue insertion.
     */
    readonly session: SessionSelector;
    readonly originMessageId: OriginMessageId;
    readonly idempotencyKey: TurnIdempotencyKey;
    readonly text: string;
    readonly preparedAttachment?: PreparedAttachmentAdmission;
  }): Promise<TurnAdmissionResult>;
}

/** Claims only the current FIFO head while reauthorizing it in the transaction. */
export interface QueueHeadClaimUnitOfWork {
  claimEligibleQueueHead(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly principalId: PrincipalId;
  }): Promise<
    | {
        readonly status: "claimed";
        readonly turnId: TurnId;
        readonly attemptId: AgentDispatchAttemptId;
        readonly runtime: TurnRuntimeAt<"dispatching">;
        readonly auditEvents: readonly [
          AuditEnvelopeFor<"turn-dispatched">,
          ...AuditEnvelopeFor<"turn-state-transitioned">[],
        ];
      }
    | {
        readonly status: "no-eligible-head" | "session-blocked";
        readonly auditEvents: readonly [];
      }
    | {
        readonly status: "authorization-revoked";
        readonly cancelledTurnId: TurnId;
        readonly terminalResponse: TurnTerminalResponse;
        readonly delivery: TurnResponseDelivery;
        readonly auditEvents: readonly [
          AuditEnvelopeFor<"turn-terminalized">,
          AuditEnvelopeFor<"response-delivery-created">,
          ...AuditEnvelopeFor<"turn-state-transitioned">[],
        ];
      }
  >;
}

/** Removes a still-pending Turn and terminalizes it without launching a worker. */
export interface QueuedCancellationUnitOfWork {
  cancelStillQueuedTurn(input: {
    readonly context: TurnControlAuthorizationContext;
    readonly turnId: TurnId;
  }): Promise<
    | {
        readonly status: "cancelled";
        readonly terminalResponse: TurnTerminalResponse;
        readonly delivery: TurnResponseDelivery;
        readonly auditEvents: readonly [
          AuditEnvelopeFor<"turn-terminalized">,
          AuditEnvelopeFor<"response-delivery-created">,
          ...AuditEnvelopeFor<"turn-state-transitioned">[],
        ];
      }
    | {
        readonly status: "already-cancelled" | "not-queued" | "denied";
        readonly auditEvents: AuditEventsFor<"turn-state-transitioned">;
      }
  >;
}

/** Records active cancellation intent and closes privileged Turn authority. */
export interface ActiveCancellationUnitOfWork {
  requestActiveTurnCancellation(input: {
    readonly context: TurnControlAuthorizationContext;
    readonly turnId: TurnId;
    readonly reason:
      | "withdrawn-by-requester"
      | "cancelled-by-controller"
      | "session-stopped";
  }): Promise<
    | {
        readonly status: "cancelling";
        readonly runtime: TurnRuntimeAt<"cancelling">;
        readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
      }
    | {
        readonly status: "already-terminal" | "not-active" | "denied";
        readonly auditEvents: AuditEventsFor<"turn-state-transitioned">;
      }
  >;
}

/** Durable submission arming happens before a driver may emit protocol bytes. */
export interface SubmissionArmingUnitOfWork {
  armProtocolSubmission(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly turnId: TurnId;
    readonly attemptId: AgentDispatchAttemptId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
  }): Promise<{
    readonly authorization: ArmedProtocolPromptSubmission;
    readonly runtime: TurnRuntimeAt<"submission-armed">;
    readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
  }>;
}

/** Records one armed protocol write outcome using the exact current fence. */
export type ProtocolSubmissionResultFor<
  Outcome extends ProtocolPromptSubmissionOutcome,
> = Outcome extends { readonly kind: "submitted" }
  ? {
      readonly status: "submitted";
      readonly runtime: TurnRuntimeAt<"submitted-unconfirmed">;
      readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
    }
  : Outcome extends { readonly kind: "definitely-not-submitted" }
    ? {
        readonly status: "retry-authorized" | "retry-exhausted";
        readonly runtime: TurnRuntimeAt<"dispatching">;
        readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
      }
    : {
        readonly status: "submission-unknown";
        readonly runtime: TurnRuntimeAt<"submitted-unconfirmed">;
        readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
      };

export interface ProtocolSubmissionOutcomeUnitOfWork {
  recordProtocolSubmissionOutcome<
    Outcome extends ProtocolPromptSubmissionOutcome,
  >(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly turnId: TurnId;
    readonly attemptId: AgentDispatchAttemptId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly outcome: Outcome;
  }): Promise<ProtocolSubmissionResultFor<Outcome>>;
}

/** Acceptance remains distinct from submission; every exact outcome is durable. */
export type PromptAcceptanceResultFor<
  Outcome extends AgentPromptAcceptanceOutcome,
> = Outcome extends { readonly kind: "accepted" }
  ? {
      readonly status: "accepted";
      readonly runtime: TurnRuntimeAt<"accepted">;
      readonly evidence: PromptAcceptanceEvidence;
      readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
    }
  : Outcome extends { readonly kind: "rejected" }
    ? {
        readonly status:
          | "rejected-retry-authorized"
          | "rejected-retry-exhausted";
        readonly runtime: TurnRuntimeAt<"dispatching">;
        readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
      }
    : {
        readonly status: "acceptance-unknown";
        readonly runtime: TurnRuntimeAt<"submitted-unconfirmed">;
        readonly auditEvents: RequiredAuditEventsFor<"turn-state-transitioned">;
      };

export interface PromptAcceptanceUnitOfWork {
  recordPromptAcceptanceOutcome<
    Outcome extends AgentPromptAcceptanceOutcome,
  >(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly turnId: TurnId;
    readonly attemptId: AgentDispatchAttemptId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly outcome: Outcome;
  }): Promise<PromptAcceptanceResultFor<Outcome>>;
}

export interface InteractionCreationUnitOfWork {
  createInteractionAndWait(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly turnId: TurnId;
    readonly attemptId: AgentDispatchAttemptId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly interaction: TurnInteraction & {
      readonly state: { readonly status: "pending" };
    };
  }): Promise<{
    readonly interaction: TurnInteraction;
    readonly runtime: TurnRuntimeAt<
      "waiting-for-approval" | "waiting-for-input"
    >;
    readonly auditEvents: readonly [
      AuditEnvelopeFor<"interaction-recorded">,
      ...AuditEnvelopeFor<"turn-state-transitioned">[],
    ];
  }>;
}

export type InteractionResolutionIntent =
  | {
      readonly context: AuthenticatedConnectorContext;
      readonly interactionId: TurnInteractionId;
      readonly intent: {
        readonly kind: "principal-approval";
        readonly decision: "approve" | "deny";
      };
    }
  | {
      readonly context: TurnCoordinatorServiceContext;
      readonly interactionId: TurnInteractionId;
      readonly intent: {
        readonly kind: "system-resolution";
        readonly resolution: Exclude<
          TurnInteractionResolution,
          | { readonly kind: "approval-by-principal" }
          | { readonly kind: "input-by-originator" }
        >;
      };
    };

export type InteractionResponseOutcomeResultFor<
  Response extends SendStartedAgentInteractionResponse,
  Outcome extends AgentInteractionResponseDeliveryOutcome,
> = Outcome extends { readonly kind: "delivered" }
  ? {
      readonly status: "delivered";
      readonly dispatch: TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "delivered" };
      };
      readonly runtime: Response["disposition"] extends "resume-running"
        ? TurnRuntimeAt<"running">
        : TurnRuntimeAt<"cancelling">;
      readonly auditEvents: readonly [
        AuditEnvelopeFor<"interaction-response-dispatch-recorded">,
        ...AuditEnvelopeFor<"turn-state-transitioned">[],
      ];
    }
  : {
      readonly status: "outcome-unknown";
      readonly dispatch: TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "outcome-unknown" };
      };
      readonly runtime: TurnRuntimeAt<"cancelling">;
      readonly auditEvents: readonly [
        AuditEnvelopeFor<"interaction-response-dispatch-recorded">,
        ...AuditEnvelopeFor<"turn-state-transitioned">[],
      ];
    };

type ReadyInteractionResponseAuthorization<
  Disposition extends AgentInteractionResponseAuthorization["disposition"],
> = AgentInteractionResponseAuthorization & {
  readonly disposition: Disposition;
};

export type InteractionResolutionResult =
  | {
      readonly status: "resolved-running";
      readonly interaction: TurnInteraction;
      readonly dispatch: TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "ready" };
      };
      readonly responseAuthorization: ReadyInteractionResponseAuthorization<
        "resume-running"
      >;
      readonly runtime: TurnRuntimeAt<"running">;
      readonly auditEvents: readonly [
        AuditEnvelopeFor<"interaction-resolved">,
        AuditEnvelopeFor<"interaction-response-dispatch-recorded">,
        AuditEnvelopeFor<"turn-state-transitioned">,
      ];
    }
  | {
      readonly status: "resolved-cancelling";
      readonly interaction: TurnInteraction;
      readonly dispatch: TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "ready" };
      };
      readonly responseAuthorization: ReadyInteractionResponseAuthorization<
        "continue-cancelling"
      >;
      readonly runtime: TurnRuntimeAt<"cancelling">;
      readonly auditEvents: readonly [
        AuditEnvelopeFor<"interaction-resolved">,
        AuditEnvelopeFor<"interaction-response-dispatch-recorded">,
        AuditEnvelopeFor<"turn-state-transitioned">,
      ];
    }
  | {
      readonly status: "not-pending" | "denied";
      readonly auditEvents: AuditEventsFor<"interaction-resolved">;
    };

export type InteractionResponseSendStartResultFor<
  Authorization extends AgentInteractionResponseAuthorization,
> =
  | {
      readonly status: "send-started";
      readonly response: SendStartedAgentInteractionResponse & {
        readonly disposition: Authorization["disposition"];
      };
      readonly dispatch: TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "send-started" };
      };
      readonly runtime: Authorization["disposition"] extends "resume-running"
        ? TurnRuntimeAt<"running">
        : TurnRuntimeAt<"cancelling">;
      readonly auditEvents: RequiredAuditEventsFor<
        "interaction-response-dispatch-recorded"
      >;
    }
  | {
      readonly status: "not-sendable";
      readonly auditEvents: AuditEventsFor<
        "interaction-response-dispatch-recorded"
      >;
    };

export interface InteractionResolutionUnitOfWork {
  resolveInteractionAndAuthorizeDriverResponse(
    input: InteractionResolutionIntent,
  ): Promise<InteractionResolutionResult>;
  consumeDriverResponseAuthorization<
    Authorization extends AgentInteractionResponseAuthorization,
  >(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly authorization: Authorization;
  }): Promise<InteractionResponseSendStartResultFor<Authorization>>;
  recordDriverResponseOutcome<
    Response extends SendStartedAgentInteractionResponse,
    Outcome extends AgentInteractionResponseDeliveryOutcome,
  >(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly response: Response;
    readonly outcome: Outcome;
  }): Promise<InteractionResponseOutcomeResultFor<Response, Outcome>>;
  /**
   * Reconstructs the sealed response only from a durable resolved interaction
   * whose dispatch is still ready, while rechecking the current worker fence.
   */
  reauthorizeRecoveredReadyDriverResponse(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly responseDispatchId: TurnInteractionResponseId;
  }): Promise<
    | {
        readonly status: "ready-running";
        readonly dispatch: TurnInteractionResponseDispatch & {
          readonly state: { readonly status: "ready" };
        };
        readonly responseAuthorization: ReadyInteractionResponseAuthorization<
          "resume-running"
        >;
        readonly auditEvents: readonly [];
      }
    | {
        readonly status: "ready-cancelling";
        readonly dispatch: TurnInteractionResponseDispatch & {
          readonly state: { readonly status: "ready" };
        };
        readonly responseAuthorization: ReadyInteractionResponseAuthorization<
          "continue-cancelling"
        >;
        readonly auditEvents: readonly [];
      }
    | {
        readonly status: "not-ready" | "stale-fence";
        readonly auditEvents: AuditEventsFor<
          "interaction-response-dispatch-recorded"
        >;
      }
  >;
  /**
   * Restart-only conservative closure for a durable send-started dispatch
   * whose sealed in-memory response evidence was lost with the worker.
   */
  recordInterruptedDriverResponseOutcomeUnknown(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly responseDispatchId: TurnInteractionResponseId;
  }): Promise<{
    readonly status: "outcome-unknown";
    readonly dispatch: TurnInteractionResponseDispatch & {
      readonly state: { readonly status: "outcome-unknown" };
    };
    readonly runtime: TurnRuntimeAt<"cancelling">;
    readonly auditEvents: readonly [
      AuditEnvelopeFor<"interaction-response-dispatch-recorded">,
      ...AuditEnvelopeFor<"turn-state-transitioned">[],
    ];
  }>;
}

export interface WorkerLeaseUnitOfWork {
  issueWorkerLease(input: {
    readonly context: SupervisorServiceContext;
    readonly sessionId: SessionId;
  }): Promise<{
    readonly lease: WorkerLease;
    readonly auditEvents: RequiredAuditEventsFor<"worker-lease-state-changed">;
  }>;
  renewCurrentWorkerLease(input: {
    readonly context: SupervisorServiceContext;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
  }): Promise<{
    readonly lease: WorkerLease;
    readonly auditEvents: RequiredAuditEventsFor<"worker-lease-state-changed">;
  }>;
  endWorkerLease(input: {
    readonly context: SupervisorServiceContext;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly end: "released" | "expired" | "revoked";
  }): Promise<{
    readonly lease: WorkerLease;
    readonly auditEvents: RequiredAuditEventsFor<"worker-lease-state-changed">;
  }>;
}

export interface CredentialLeaseUnitOfWork {
  issueCredentialLease(input: {
    readonly context: BrokerServiceContext;
    readonly sessionId: SessionId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly providerConnectionId: ProviderConnectionId;
  }): Promise<{
    readonly lease: CredentialLease;
    readonly auditEvents: RequiredAuditEventsFor<"credential-lease-state-changed">;
  }>;
  renewCredentialLease(input: {
    readonly context: BrokerServiceContext;
    readonly credentialLeaseId: CredentialLeaseId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
  }): Promise<{
    readonly lease: CredentialLease;
    readonly auditEvents: RequiredAuditEventsFor<"credential-lease-state-changed">;
  }>;
  endCredentialLease(input: {
    readonly context: BrokerServiceContext;
    readonly credentialLeaseId: CredentialLeaseId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly end: "released" | "expired" | "revoked";
  }): Promise<{
    readonly lease: CredentialLease;
    readonly auditEvents: RequiredAuditEventsFor<"credential-lease-state-changed">;
  }>;
}

/** Resolution (where needed), reservation, and usage-ledger hold are atomic. */
export interface InferenceReservationUnitOfWork {
  reservePreparedInferenceRequest(input: {
    readonly context: BrokerServiceContext;
    readonly prepared: PreparedProviderInferenceRequest;
    readonly authorizationContext: ProviderRequestAuthorizationContext;
  }): Promise<
    | {
        readonly authorizationResult: Extract<
          ProviderReservationAuthorizationResult,
          { readonly authorized: true }
        >;
        readonly auditEvents: RequiredAuditEventsFor<"inference-reserved">;
      }
    | {
        readonly authorizationResult: Extract<
          ProviderReservationAuthorizationResult,
          { readonly authorized: false }
        >;
        readonly auditEvents: RequiredAuditEventsFor<
          "inference-reservation-denied"
        >;
      }
  >;
}

/** Forward marking and one-send consumption are separate exact CAS transactions. */
export interface InferenceForwardingUnitOfWork {
  markReservationForwarding(input: {
    readonly context: BrokerServiceContext;
    readonly prepared: PreparedProviderInferenceRequest;
    readonly reservation: ProviderReservationAuthorization;
  }): Promise<
    | {
        readonly authorizationResult: Extract<
          ProviderForwardAuthorizationResult,
          { readonly authorized: true }
        >;
        readonly auditEvents: RequiredAuditEventsFor<
          "inference-forwarding-recorded"
        >;
      }
    | {
        readonly authorizationResult: Extract<
          ProviderForwardAuthorizationResult,
          { readonly authorized: false }
        >;
        readonly auditEvents: RequiredAuditEventsFor<
          "inference-forwarding-denied"
        >;
      }
  >;
  consumeReadyForwardingAttempt(input: {
    readonly context: BrokerServiceContext;
    readonly invocation: BoundProviderInvocation;
  }): Promise<
    | {
        readonly status: "send-started";
        readonly invocation: SendStartedProviderInvocation;
        readonly auditEvents: RequiredAuditEventsFor<"inference-send-started">;
      }
    | {
        readonly status: "not-sendable";
        readonly auditEvents: AuditEventsFor<"inference-send-started">;
      }
  >;
  recordForwardingAttemptOutcome<
    Outcome extends
      | { readonly status: "send-completed" }
      | {
          readonly status: "outcome-unknown";
          readonly reason: "broker-recovery" | "sidecar-disconnected";
        },
  >(input: {
    readonly context: BrokerServiceContext;
    readonly invocation: SendStartedProviderInvocation;
    readonly outcome: Outcome;
  }): Promise<{
    readonly auditEvents: Outcome extends { readonly status: "send-completed" }
      ? RequiredAuditEventsFor<"inference-send-completed">
      : RequiredAuditEventsFor<"inference-send-outcome-unknown">;
  }>;
  /**
   * Restart-only conservative closure for a durable send-started attempt whose
   * sealed in-memory invocation was lost with the broker runtime.
   */
  recordInterruptedForwardingOutcomeUnknown(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly forwardingAttemptId: InferenceForwardingAttemptId;
  }): Promise<{
    readonly auditEvents: RequiredAuditEventsFor<
      "inference-send-outcome-unknown"
    >;
  }>;
}

export type ForwardedInferenceSettlement =
  | {
      readonly kind: "observed-usage";
      readonly observation: Extract<ProviderUsageObservation, { readonly usage: unknown }>;
    }
  | {
      readonly kind: "charge-reservation";
      readonly reason:
        | "usage-unavailable"
        | "broker-recovery"
        | "cancelled-after-forward";
      readonly observedAt: IsoTimestamp;
    };

/** Settlement/release/charge always updates the matching reservation and ledger. */
export type InferenceSettlementResultFor<
  Settlement extends ForwardedInferenceSettlement,
> = {
  readonly reservationId: InferenceRequestReservationId;
  readonly auditEvents: Settlement extends { readonly kind: "observed-usage" }
    ? RequiredAuditEventsFor<"inference-settled">
    : RequiredAuditEventsFor<"inference-charged-reservation">;
};

export interface InferenceSettlementUnitOfWork {
  settleOrChargeForwardedInference<
    Settlement extends ForwardedInferenceSettlement,
  >(input: {
    readonly context: BrokerServiceContext;
    readonly forwardingAttemptId: InferenceForwardingAttemptId;
    readonly settlement: Settlement;
  }): Promise<InferenceSettlementResultFor<Settlement>>;
  releaseProvenUnforwardedReservation(input: {
    readonly context: BrokerServiceContext;
    readonly reservationId: InferenceRequestReservationId;
  }): Promise<
    | {
        readonly status: "released";
        readonly auditEvents: RequiredAuditEventsFor<"inference-released">;
      }
    | {
        readonly status: "not-releasable";
        readonly reason: "already-forwarded" | "already-settled" | "not-found";
        readonly auditEvents: RequiredAuditEventsFor<
          "inference-release-denied"
        >;
      }
  >;
}

/** Terminal result, finalized messages/events, and delivery outbox are inseparable. */
export interface TerminalizationAndDeliveryOutboxUnitOfWork {
  terminalizeTurnAndCreateDelivery(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly turnId: TurnId;
    readonly attemptId: AgentDispatchAttemptId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
    readonly result: TurnResult;
    readonly partialOutputAvailable: boolean;
    readonly finalizedMessages: readonly FinalizedTurnResponseMessage[];
  }): Promise<{
    readonly terminalResponse: TurnTerminalResponse;
    readonly delivery: TurnResponseDelivery;
    readonly runtime: TerminalTurnRuntimeState;
    readonly auditEvents: readonly [
      AuditEnvelopeFor<"turn-terminalized">,
      AuditEnvelopeFor<"response-delivery-created">,
      ...AuditEnvelopeFor<"turn-message-finalized">[],
    ];
  }>;
}

/**
 * The outgoing Turn must have no in-flight reservations before this operation
 * clears active ownership. The next head remains pending until a separate
 * queue-head claim transaction reauthorizes it.
 */
export interface QueueHandoffUnitOfWork {
  handoffCompletedTurnQueue(input: {
    readonly context: TurnCoordinatorServiceContext;
    readonly sessionId: SessionId;
    readonly completedTurnId: TurnId;
  }): Promise<
    | {
        readonly status: "handed-off";
        readonly nextTurnId?: TurnId;
        readonly auditEvents: readonly [
          AuditEnvelopeFor<"turn-queue-handoff-recorded">,
          ...AuditEnvelopeFor<"turn-state-transitioned">[],
        ];
      }
    | {
        readonly status: "blocked-by-inference";
        readonly auditEvents: AuditEventsFor<"turn-state-transitioned">;
      }
  >;
}

/**
 * Narrow observation from the external delivery transport. Trusted
 * persistence derives attempt timestamps, retry scheduling, deadline/max
 * attempt exhaustion, and every durable delivery state.
 */
export type DeliveryTransportOutcome =
  | { readonly status: "delivered" }
  | {
      readonly status: "transport-failed";
      readonly reason:
        | "client-disconnected"
        | "transport-unavailable"
        | "send-failed";
    };

/** Sealed immediately-before-send evidence that live delivery authority ended. */
export interface DeliveryAuthorizationRevocationEvidence {
  readonly [deliveryAuthorizationRevocationBrand]: true;
  readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
  readonly reason: "binding-inactive" | "recipient-no-longer-authorized";
}

export type DeliveryAttemptOutcomeResultFor<
  Outcome extends DeliveryTransportOutcome,
> = Outcome extends { readonly status: "delivered" }
  ? {
      readonly delivery: TurnResponseDelivery & {
        readonly state: Extract<
          TurnResponseDeliveryState,
          { readonly status: "delivered" }
        >;
      };
      readonly attempt: TurnResponseDeliveryAttempt & {
        readonly state: Extract<
          TurnResponseDeliveryAttemptState,
          { readonly status: "delivered" }
        >;
      };
      readonly auditEvents: RequiredAuditEventsFor<
        "response-delivery-attempt-recorded"
      >;
    }
  : {
      readonly delivery: TurnResponseDelivery & {
        readonly state: Extract<
          TurnResponseDeliveryState,
          { readonly status: "retryable-failure" | "failed" }
        >;
      };
      readonly attempt: TurnResponseDeliveryAttempt & {
        readonly state: Extract<
          TurnResponseDeliveryAttemptState,
          { readonly status: "retryable-failure" | "failed" }
        >;
      };
      readonly auditEvents: RequiredAuditEventsFor<
        "response-delivery-attempt-recorded"
      >;
    };

/** Attempts are created before send; authorization is repeated in that transaction. */
export interface DeliveryAttemptUnitOfWork {
  beginDeliveryAttempt(input: {
    readonly context: DeliveryServiceContext;
    readonly deliveryId: TurnResponseDeliveryId;
  }): Promise<
    | {
        readonly status: "ready";
        readonly attempt: TurnResponseDeliveryAttempt & {
          readonly state: { readonly status: "in-progress" };
        };
        readonly auditEvents: RequiredAuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
    | {
        readonly status: "suppressed";
        readonly delivery: TurnResponseDelivery & {
          readonly state: Extract<
            TurnResponseDeliveryState,
            { readonly status: "suppressed" }
          >;
        };
        readonly attempt: TurnResponseDeliveryAttempt & {
          readonly state: Extract<
            TurnResponseDeliveryAttemptState,
            { readonly status: "suppressed" }
          >;
        };
        readonly auditEvents: RequiredAuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
    | {
        readonly status: "expired";
        readonly delivery: TurnResponseDelivery & {
          readonly state: Extract<
            TurnResponseDeliveryState,
            { readonly status: "expired" }
          >;
        };
        readonly auditEvents: RequiredAuditEventsFor<"response-delivery-expired">;
      }
    | {
        readonly status: "not-deliverable";
        readonly delivery: TurnResponseDelivery & {
          readonly state: Exclude<
            TurnResponseDeliveryState,
            { readonly status: "pending" | "retryable-failure" }
          >;
        };
        readonly auditEvents: AuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
  >;
  recordDeliveryAttemptOutcome<Outcome extends DeliveryTransportOutcome>(input: {
    readonly context: DeliveryServiceContext;
    readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
    readonly outcome: Outcome;
  }): Promise<DeliveryAttemptOutcomeResultFor<Outcome>>;
  recordDeliveryAuthorizationRevoked(input: {
    readonly context: DeliveryServiceContext;
    readonly revocation: DeliveryAuthorizationRevocationEvidence;
  }): Promise<
    | {
        readonly status: "suppressed";
        readonly delivery: TurnResponseDelivery & {
          readonly state: Extract<
            TurnResponseDeliveryState,
            { readonly status: "suppressed" }
          >;
        };
        readonly attempt: TurnResponseDeliveryAttempt & {
          readonly state: Extract<
            TurnResponseDeliveryAttemptState,
            { readonly status: "suppressed" }
          >;
        };
        readonly auditEvents: RequiredAuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
    | {
        readonly status: "not-in-progress";
        readonly auditEvents: AuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
  >;
  /**
   * Restart-only closure for an attempt left in-progress when its external
   * transport observation was lost. Persistence derives retry scheduling or
   * exhaustion from its clock, deadline, and attempt count.
   */
  recoverInterruptedDeliveryAttempt(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
  }): Promise<
    | {
        readonly status: "retryable-failure";
        readonly delivery: TurnResponseDelivery & {
          readonly state: Extract<
            TurnResponseDeliveryState,
            { readonly status: "retryable-failure" }
          >;
        };
        readonly attempt: TurnResponseDeliveryAttempt & {
          readonly state: Extract<
            TurnResponseDeliveryAttemptState,
            { readonly status: "retryable-failure" }
          >;
        };
        readonly auditEvents: RequiredAuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
    | {
        readonly status: "failed";
        readonly delivery: TurnResponseDelivery & {
          readonly state: Extract<
            TurnResponseDeliveryState,
            { readonly status: "failed" }
          >;
        };
        readonly attempt: TurnResponseDeliveryAttempt & {
          readonly state: Extract<
            TurnResponseDeliveryAttemptState,
            { readonly status: "failed" }
          >;
        };
        readonly auditEvents: RequiredAuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
    | {
        readonly status: "not-in-progress";
        readonly auditEvents: AuditEventsFor<
          "response-delivery-attempt-recorded"
        >;
      }
  >;
}

export interface StartupRecoveryWork {
  readonly sessionsWithQueuedTurns: readonly SessionId[];
  readonly sandboxRecovery: readonly {
    readonly sessionId: SessionId;
    readonly lifecycle: SessionLifecycle;
    readonly runtime: SessionRuntimeState;
    readonly state: "unconfirmed-old-sandbox" | "quarantined";
  }[];
  readonly workerLeases: readonly {
    readonly lease: WorkerLease;
    readonly recoveryState: "current" | "expired" | "stale-fence";
  }[];
  readonly credentialLeases: readonly {
    readonly lease: CredentialLease;
    readonly recoveryState:
      | "current"
      | "expired"
      | "stale-worker-fence"
      | "orphaned-worker";
  }[];
  readonly resumeHandles: readonly {
    readonly handle: AgentResumeHandle;
    readonly recoveryState: "recoverable" | "expired" | "stale-worker-fence";
  }[];
  readonly interactionResponseDispatches: readonly (
    | (TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "ready" };
      })
    | (TurnInteractionResponseDispatch & {
        readonly state: { readonly status: "send-started" };
      })
  )[];
  readonly activeTurns: readonly (
    | {
        readonly sessionId: SessionId;
        readonly turnId: TurnId;
        readonly attemptId: AgentDispatchAttemptId;
        readonly lifecycle: "dispatching";
        readonly worker:
          | { readonly status: "not-issued" }
          | {
              readonly status: "issued";
              readonly workerLeaseId: WorkerLeaseId;
              readonly workerFencingToken: number;
            };
      }
    | {
        readonly sessionId: SessionId;
        readonly turnId: TurnId;
        readonly attemptId: AgentDispatchAttemptId;
        readonly workerLeaseId: WorkerLeaseId;
        readonly workerFencingToken: number;
        readonly resumeHandleId?: AgentResumeHandleId;
        readonly lifecycle:
          | "submission-armed"
          | "submitted-unconfirmed"
          | "accepted"
          | "running"
          | "waiting-for-approval"
          | "waiting-for-input"
          | "cancelling";
      }
  )[];
  readonly inference: readonly (
    | {
        readonly state: "authorized";
        readonly reservationId: InferenceRequestReservationId;
      }
    | {
        readonly state: "ready-for-one-send";
        readonly reservationId: InferenceRequestReservationId;
        readonly forwardingAttemptId: InferenceForwardingAttemptId;
      }
    | {
        readonly state: "send-started";
        readonly reservationId: InferenceRequestReservationId;
        readonly forwardingAttemptId: InferenceForwardingAttemptId;
      }
    | {
        readonly state: "send-completed";
        readonly reservationId: InferenceRequestReservationId;
        readonly forwardingAttemptId: InferenceForwardingAttemptId;
      }
    | {
        readonly state: "outcome-unknown";
        readonly reservationId: InferenceRequestReservationId;
        readonly forwardingAttemptId: InferenceForwardingAttemptId;
      }
  )[];
  readonly unfinishedDeliveries: readonly (
    | {
        readonly state: "pending" | "retryable-failure";
        readonly deliveryId: TurnResponseDeliveryId;
      }
    | {
        readonly state: "in-progress";
        readonly deliveryId: TurnResponseDeliveryId;
        readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
      }
  )[];
}

export type StartupRecoveryDecision =
  | {
      readonly kind: "turn-recovery";
      readonly recovery: TurnRecoveryRecord;
    }
  | {
      readonly kind: "block-session";
      readonly sessionId: SessionId;
      readonly reason:
        | "unconfirmed-old-sandbox"
        | "quarantined-runtime"
        | "stale-worker-fence";
    };

type ReconciledTurnRuntimeFor<
  Recovery extends TurnRecoveryRecord,
> = Recovery extends {
  readonly outcome: "reconciled-live";
  readonly observedState: {
    readonly status: infer Status extends TurnLifecycleState["status"];
  };
}
  ? TurnRuntimeAt<Status>
  : never;

export type StartupRecoveryResultFor<
  Decision extends StartupRecoveryDecision,
> = Decision extends { readonly kind: "block-session" }
  ? {
      readonly status: "session-blocked";
      readonly lifecycle: SessionLifecycle & { readonly status: "blocked" };
      readonly runtime: SessionRuntimeState & { readonly status: "error" };
      readonly auditEvents: readonly [
        AuditEnvelopeFor<"session-lifecycle-state-changed">,
        ...AuditEnvelopeFor<
          | "turn-state-transitioned"
          | "worker-lease-state-changed"
          | "credential-lease-state-changed"
          | "resume-handle-state-changed"
        >[],
      ];
    }
  : Decision extends {
        readonly kind: "turn-recovery";
        readonly recovery: infer Recovery extends TurnRecoveryRecord;
      }
    ? Recovery extends { readonly outcome: "retry-authorized" }
      ? {
          readonly status: "retry-authorized";
          readonly lifecycle: SessionLifecycle;
          readonly runtime: TurnRuntimeAt<"dispatching">;
          readonly auditEvents: RequiredAuditEventsFor<"turn-recovery-recorded">;
        }
      : Recovery extends { readonly outcome: "resumed" }
        ? {
            readonly status: "resumed";
            readonly lifecycle: SessionLifecycle;
            readonly runtime: NonterminalTurnRuntimeState;
            readonly auditEvents: readonly [
              AuditEnvelopeFor<"turn-recovery-recorded">,
              AuditEnvelopeFor<"resume-handle-state-changed">,
              ...AuditEnvelopeFor<
                | "worker-lease-state-changed"
                | "credential-lease-state-changed"
              >[],
            ];
          }
        : Recovery extends { readonly outcome: "reconciled-live" }
          ? {
              readonly status: "reconciled-live";
              readonly lifecycle: SessionLifecycle;
              readonly runtime: ReconciledTurnRuntimeFor<Recovery>;
              readonly auditEvents: readonly [
                AuditEnvelopeFor<"turn-recovery-recorded">,
                ...AuditEnvelopeFor<
                  | "worker-lease-state-changed"
                  | "credential-lease-state-changed"
                  | "resume-handle-state-changed"
                >[],
              ];
            }
          : {
              readonly status: "terminalized";
              readonly lifecycle: SessionLifecycle;
              readonly runtime: TerminalTurnRuntimeState;
              readonly terminalResponse: TurnTerminalResponse;
              readonly delivery: TurnResponseDelivery;
              readonly auditEvents: readonly [
                AuditEnvelopeFor<"turn-recovery-recorded">,
                AuditEnvelopeFor<"turn-terminalized">,
                AuditEnvelopeFor<"response-delivery-created">,
                ...AuditEnvelopeFor<
                  | "turn-state-transitioned"
                  | "worker-lease-state-changed"
                  | "credential-lease-state-changed"
                  | "resume-handle-state-changed"
                >[],
              ];
            }
    : never;

export interface StartupRecoveryUnitOfWork {
  loadStartupRecoveryWork(
    context: TrustedServiceAuthorizationContext<"recovery">,
  ): Promise<StartupRecoveryWork>;
  recordStartupRecovery<Decision extends StartupRecoveryDecision>(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly decision: Decision;
  }): Promise<StartupRecoveryResultFor<Decision>>;
}

/**
 * Complete first-slice semantic transaction vocabulary. Each method above is
 * the transaction boundary itself: there is no callback, generic CRUD handle,
 * or external-effect port that application code can run inside it.
 */
export interface FirstSliceTransactionPort {
  readonly bootstrapPublication: BootstrapPublicationUnitOfWork;
  readonly sessionCreation: SessionCreationUnitOfWork;
  readonly sessionStop: SessionStopUnitOfWork;
  readonly turnResultQuery: TurnResultQueryPort;
  readonly turnAdmission: TurnAdmissionUnitOfWork;
  readonly queueHeadClaim: QueueHeadClaimUnitOfWork;
  readonly queuedCancellation: QueuedCancellationUnitOfWork;
  readonly activeCancellation: ActiveCancellationUnitOfWork;
  readonly submissionArming: SubmissionArmingUnitOfWork;
  readonly protocolSubmissionOutcome: ProtocolSubmissionOutcomeUnitOfWork;
  readonly promptAcceptance: PromptAcceptanceUnitOfWork;
  readonly interactionCreation: InteractionCreationUnitOfWork;
  readonly interactionResolution: InteractionResolutionUnitOfWork;
  readonly workerLease: WorkerLeaseUnitOfWork;
  readonly credentialLease: CredentialLeaseUnitOfWork;
  readonly inferenceReservation: InferenceReservationUnitOfWork;
  readonly inferenceForwarding: InferenceForwardingUnitOfWork;
  readonly inferenceSettlement: InferenceSettlementUnitOfWork;
  readonly terminalizationAndDeliveryOutbox: TerminalizationAndDeliveryOutboxUnitOfWork;
  readonly queueHandoff: QueueHandoffUnitOfWork;
  readonly deliveryAttempt: DeliveryAttemptUnitOfWork;
  readonly startupRecovery: StartupRecoveryUnitOfWork;
}

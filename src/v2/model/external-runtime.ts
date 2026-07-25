/**
 * Compile-only first-slice external runtime and private-storage ports.
 *
 * These interfaces are intentionally outside the semantic database units in
 * application.ts. They accept only sealed, trusted projections and return
 * observations; persistence derives all durable timestamps and states.
 */

import type {
  AttachmentId,
  CredentialLeaseId,
  EndpointId,
  InferenceForwardingAttemptId,
  PrincipalId,
  ProviderConnectionId,
  SessionEndpointBindingId,
  SessionId,
  TurnResponseDeliveryAttemptId,
  WorkerLeaseId,
} from "./primitives.js";
import type { EndpointAddress } from "./endpoint-binding.js";
import type {
  AgentDriverCapabilities,
  AgentDriverDefinition,
  AgentRuntime,
  AgentTurnRun,
  SupervisorOwnedAgentProcess,
} from "./agent-runtime.js";
import type {
  BoundedConnectorImageUpload,
  DeliveryAuthorizationRevocationEvidence,
  DeliveryTransportOutcome,
  PreparedAttachmentAdmission,
  TrustedServiceAuthorizationContext,
  TurnAdmissionResult,
} from "./application.js";
import type {
  BrokeredInferenceInvocationResult,
  InferenceBridgeInboundRequest,
  ProviderRequestAuthorizationContext,
  ProviderRequestValidationResult,
  SendStartedProviderInvocation,
} from "./provider-broker.js";
import type {
  TurnResponseDeliveryAttempt,
  TurnTerminalResponse,
} from "./records.js";
import type {
  RuntimeBrokerCapability,
  SupervisorLaunchAuthorization,
} from "./runtime-security.js";

declare const attachmentStageBrand: unique symbol;
declare const attachmentRecoveryQuiescenceBrand: unique symbol;
declare const attachmentRecoveryCompletedBrand: unique symbol;
declare const orphanedAttachmentStageBrand: unique symbol;
declare const finalizeOrphanedAttachmentStageBrand: unique symbol;
declare const cleanupOrphanedAttachmentStageBrand: unique symbol;
declare const readySupervisorLaunchBrand: unique symbol;
declare const supervisorLaunchPayloadBrand: unique symbol;
declare const consumedSupervisorLaunchBrand: unique symbol;
declare const readyBrokerListenerBrand: unique symbol;
declare const brokerListenerPayloadBrand: unique symbol;
declare const consumedBrokerListenerBrand: unique symbol;
declare const readyNativeSidecarBrand: unique symbol;
declare const consumedNativeSidecarBrand: unique symbol;
declare const activeBrokerListenerBrand: unique symbol;
declare const authenticatedBrokerRequestBrand: unique symbol;
declare const nativeSidecarBrand: unique symbol;
declare const supervisorWorkerBrand: unique symbol;
declare const supervisorWorkerProcessBrand: unique symbol;
declare const readyDeliveryBrand: unique symbol;
declare const authorizedDeliveryRoutePayloadBrand: unique symbol;
declare const consumedDeliveryBrand: unique symbol;
declare const deliveryBindingGenerationBrand: unique symbol;
declare const nativeSidecarRecoveryBrand: unique symbol;
declare const brokerListenerRecoveryBrand: unique symbol;
declare const supervisorWorkerRecoveryBrand: unique symbol;
declare const piRuntimeAttachmentRecoveryBrand: unique symbol;

type DeliveryBindingGeneration = number & {
  readonly [deliveryBindingGenerationBrand]: true;
};

/** Installation-private destination resolved and reauthorized at send time. */
interface AuthorizedPrivateDeliveryRoute {
  readonly endpointBindingId: SessionEndpointBindingId;
  readonly endpointId: EndpointId;
  readonly recipientPrincipalId: PrincipalId;
  readonly address: EndpointAddress;
  /** Compared atomically with current binding state immediately before write. */
  readonly bindingGeneration: DeliveryBindingGeneration;
}

/**
 * Opaque Hitch-owned image stage. It contains a bounded, MIME-sniffed, hashed
 * private copy and the trusted Attachment ID allocated for possible admission.
 */
export interface StagedPrivateImageAttachment {
  readonly [attachmentStageBrand]: true;
  readonly preparedAdmission: PreparedAttachmentAdmission;
}

export type AttachmentStagingResult =
  | {
      readonly status: "staged";
      readonly stage: StagedPrivateImageAttachment;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "empty"
        | "byte-limit-exceeded"
        | "unsupported-image-type"
        | "mime-content-mismatch"
        | "private-storage-unavailable";
    };

export type AttachmentFinalizationResult =
  | { readonly status: "finalized"; readonly attachmentId: AttachmentId }
  | {
      readonly status: "finalization-failed";
      readonly reason: "private-storage-unavailable" | "integrity-mismatch";
    }
  | { readonly status: "already-resolved" };

export type AttachmentRollbackResult =
  | { readonly status: "rolled-back" }
  | { readonly status: "cleanup-failed" }
  | { readonly status: "already-resolved" };

/**
 * Startup-only proof that ingress is closed, every admission UoW has returned,
 * and all previously returned stage finalization/rollback promises have
 * completed. No new stage may be created until this proof is released.
 */
export interface AttachmentRecoveryQuiescence {
  readonly [attachmentRecoveryQuiescenceBrand]: true;
}

/** Store evidence that every claim under this quiescence was consumed. */
export interface CompletedAttachmentRecovery {
  readonly [attachmentRecoveryCompletedBrand]: true;
  readonly quiescence: AttachmentRecoveryQuiescence;
}

export interface AttachmentRecoveryQuiescencePort {
  enter(
    context: TrustedServiceAuthorizationContext<"recovery">,
  ): Promise<
    | {
        readonly status: "quiescent";
        readonly quiescence: AttachmentRecoveryQuiescence;
      }
    | {
        readonly status: "not-quiescent";
        readonly reason:
          | "ingress-still-open"
          | "admission-uow-in-flight"
          | "stage-resolution-in-flight";
      }
  >;
  /**
   * Ingress may reopen only with store-minted proof that no discovery claim or
   * resolution authorization remains outstanding.
   */
  release(
    completion: CompletedAttachmentRecovery,
  ): Promise<"released" | "already-released">;
}

/** Store-owned claimed generation; stale claims cannot mutate a newer stage. */
export interface OrphanedAttachmentStage {
  readonly [orphanedAttachmentStageBrand]: true;
  readonly attachmentId: AttachmentId;
}

export interface FinalizeOrphanedAttachmentStageAuthorization {
  readonly [finalizeOrphanedAttachmentStageBrand]: true;
  readonly orphan: OrphanedAttachmentStage;
}

export interface CleanupOrphanedAttachmentStageAuthorization {
  readonly [cleanupOrphanedAttachmentStageBrand]: true;
  readonly orphan: OrphanedAttachmentStage;
}

/**
 * A persistence read completes before either sealed storage effect is minted.
 * Discovery alone never authorizes deleting a stage that may already have a
 * committed Attachment record.
 */
export interface AttachmentStageRecoveryAuthorizationPort {
  authorizeResolution(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly quiescence: AttachmentRecoveryQuiescence;
    readonly orphan: OrphanedAttachmentStage;
  }): Promise<
    | {
        readonly status: "finalize";
        readonly authorization: FinalizeOrphanedAttachmentStageAuthorization;
      }
    | {
        readonly status: "cleanup";
        readonly authorization: CleanupOrphanedAttachmentStageAuthorization;
      }
    | {
        readonly status: "defer";
        readonly reason: "persistence-unavailable" | "admission-state-ambiguous";
      }
  >;
}

type AdmittedTurnWithImage = Extract<
  TurnAdmissionResult,
  { readonly status: "admitted" }
> & {
  readonly attachment: PreparedAttachmentAdmission["attachment"];
};

/**
 * The connector supplies only an already bounded opaque upload. The store
 * streams it into Hitch-owned storage; this boundary never accepts a host path
 * or an unbounded caller-owned byte array.
 */
export interface PrivateAttachmentStoragePort {
  stageBoundedImage(
    upload: BoundedConnectorImageUpload,
  ): Promise<AttachmentStagingResult>;

  /**
   * Finalization is valid only for a newly admitted Turn whose exact
   * Attachment matches the stage. Duplicate/denied admission rolls the new
   * stage back instead.
   */
  finalizeAdmittedImage(input: {
    readonly stage: StagedPrivateImageAttachment;
    readonly admission: AdmittedTurnWithImage;
  }): Promise<AttachmentFinalizationResult>;

  rollbackUnfinalizedImage(input: {
    readonly stage: StagedPrivateImageAttachment;
    readonly reason:
      | "duplicate-turn"
      | "admission-rejected"
      | "attachment-mismatch"
      | "application-aborted";
  }): Promise<AttachmentRollbackResult>;

  /**
   * Discovery atomically claims the store's current stage generation. Cleanup
   * later compare-and-swaps that exact claim; a stale claim is harmless.
   */
  discoverAndClaimOrphanedStages(
    quiescence: AttachmentRecoveryQuiescence,
  ): Promise<readonly OrphanedAttachmentStage[]>;
  /** `finalized` and `claim-stale` consume the claim; retry-required does not. */
  finalizeRecoveredStage(
    authorization: FinalizeOrphanedAttachmentStageAuthorization,
  ): Promise<
    | { readonly status: "finalized"; readonly attachmentId: AttachmentId }
    | { readonly status: "claim-stale" }
    | {
        readonly status: "retry-required";
        readonly reason: "private-storage-unavailable" | "integrity-mismatch";
      }
  >;
  /** Every result except `cleanup-failed` consumes the exact claimed generation. */
  cleanupProvenUnadmittedStage(
    authorization: CleanupOrphanedAttachmentStageAuthorization,
  ): Promise<
    "cleaned" | "already-absent" | "claim-stale" | "cleanup-failed"
  >;
  /**
   * Succeeds only after finalize/cleanup consumed every store claim. A failed
   * resolution or a minted-but-unused authorization keeps recovery quiesced.
   */
  completeRecovery(
    quiescence: AttachmentRecoveryQuiescence,
  ): Promise<
    | {
        readonly status: "all-claims-resolved";
        readonly completion: CompletedAttachmentRecovery;
      }
    | { readonly status: "claims-outstanding" }
  >;
}

/** Exact durable identity shared by external runtime discovery operations. */
export interface WorkerRuntimeIdentity {
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
}

export interface NativeSidecarRecoveryHandle extends WorkerRuntimeIdentity {
  readonly [nativeSidecarRecoveryBrand]: true;
}

export interface BrokerListenerRecoveryHandle extends WorkerRuntimeIdentity {
  readonly [brokerListenerRecoveryBrand]: true;
}

export interface SupervisorWorkerRecoveryHandle extends WorkerRuntimeIdentity {
  readonly [supervisorWorkerRecoveryBrand]: true;
}

export interface PiRuntimeAttachmentRecoveryHandle
  extends WorkerRuntimeIdentity {
  readonly [piRuntimeAttachmentRecoveryBrand]: true;
}

/**
 * Sealed one-use supervisor projection. Its full authorization is carried on
 * a non-exported symbol so application/driver code cannot inspect canonical
 * host paths or raw broker capability material.
 */
export interface ReadySupervisorLaunchAuthorization {
  readonly [readySupervisorLaunchBrand]: true;
  readonly [supervisorLaunchPayloadBrand]: SupervisorLaunchAuthorization;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
}

export interface ConsumedSupervisorLaunchAuthorization {
  readonly [consumedSupervisorLaunchBrand]: true;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
}

/** One-use registration for the worker's local broker listener/capability. */
export interface ReadyBrokerListenerAuthorization {
  readonly [readyBrokerListenerBrand]: true;
  readonly [brokerListenerPayloadBrand]: RuntimeBrokerCapability;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly providerConnectionId: ProviderConnectionId;
}

export interface ConsumedBrokerListenerAuthorization {
  readonly [consumedBrokerListenerBrand]: true;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly providerConnectionId: ProviderConnectionId;
}

/** One-use authorization to start the exact pinned Pi native sidecar. */
export interface ReadyNativeLibrarySidecarAuthorization {
  readonly [readyNativeSidecarBrand]: true;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly providerConnectionId: ProviderConnectionId;
}

export interface ConsumedNativeLibrarySidecarAuthorization {
  readonly [consumedNativeSidecarBrand]: true;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly providerConnectionId: ProviderConnectionId;
}

/** Coherent ephemeral projections assembled from one live state snapshot. */
export interface PreparedWorkerRuntimeAuthorizations {
  readonly supervisor: ReadySupervisorLaunchAuthorization;
  readonly brokerListener: ReadyBrokerListenerAuthorization;
  readonly nativeSidecar: ReadyNativeLibrarySidecarAuthorization;
}

export type RuntimeStartupResourceState =
  | {
      readonly stage: "authorizations-only";
      readonly authorizations: PreparedWorkerRuntimeAuthorizations;
    }
  | {
      readonly stage: "sidecar-running";
      readonly sidecar: RunningNativeLibrarySidecar;
      readonly brokerListener: ReadyBrokerListenerAuthorization;
      readonly supervisor: ReadySupervisorLaunchAuthorization;
    }
  | {
      readonly stage: "sidecar-recovery-required";
      readonly sidecarRecovery: NativeSidecarRecoveryHandle;
      readonly brokerListener: ReadyBrokerListenerAuthorization;
      readonly supervisor: ReadySupervisorLaunchAuthorization;
    }
  | {
      readonly stage: "listener-running";
      readonly sidecar: RunningNativeLibrarySidecar;
      readonly listener: ActiveBrokerListener;
      readonly supervisor: ReadySupervisorLaunchAuthorization;
    }
  | {
      readonly stage: "listener-recovery-required";
      readonly sidecar: RunningNativeLibrarySidecar;
      readonly listenerRecovery: BrokerListenerRecoveryHandle;
      readonly supervisor: ReadySupervisorLaunchAuthorization;
    }
  | {
      readonly stage: "worker-running";
      readonly sidecar: RunningNativeLibrarySidecar;
      readonly listener: ActiveBrokerListener;
      readonly worker: LaunchedSupervisorWorker;
    }
  | {
      readonly stage: "worker-recovery-required";
      readonly sidecar: RunningNativeLibrarySidecar;
      readonly listener: ActiveBrokerListener;
      readonly workerRecovery: SupervisorWorkerRecoveryHandle;
    };

export type RuntimeCleanupInstruction =
  | {
      readonly action: "discard-supervisor-authorization";
      readonly authorization: ReadySupervisorLaunchAuthorization;
    }
  | {
      readonly action: "discard-broker-listener-authorization";
      readonly authorization: ReadyBrokerListenerAuthorization;
    }
  | {
      readonly action: "discard-native-sidecar-authorization";
      readonly authorization: ReadyNativeLibrarySidecarAuthorization;
    }
  | {
      readonly action: "stop-sidecar";
      readonly sidecar: RunningNativeLibrarySidecar;
    }
  | {
      readonly action: "cleanup-sidecar-recovery";
      readonly recovery: NativeSidecarRecoveryHandle;
    }
  | {
      readonly action: "stop-listener";
      readonly listener: ActiveBrokerListener;
    }
  | {
      readonly action: "cleanup-listener-recovery";
      readonly recovery: BrokerListenerRecoveryHandle;
    }
  | {
      readonly action: "cleanup-worker";
      readonly worker: LaunchedSupervisorWorker;
    }
  | {
      readonly action: "cleanup-worker-recovery";
      readonly recovery: SupervisorWorkerRecoveryHandle;
    };

export type RuntimeStartupCleanupPlanFor<
  State extends RuntimeStartupResourceState,
> = State extends { readonly stage: "authorizations-only" }
  ? readonly [
      Extract<
        RuntimeCleanupInstruction,
        { readonly action: "discard-supervisor-authorization" }
      >,
      Extract<
        RuntimeCleanupInstruction,
        { readonly action: "discard-broker-listener-authorization" }
      >,
      Extract<
        RuntimeCleanupInstruction,
        { readonly action: "discard-native-sidecar-authorization" }
      >,
    ]
  : State extends { readonly stage: "sidecar-running" }
    ? readonly [
        Extract<
          RuntimeCleanupInstruction,
          { readonly action: "discard-supervisor-authorization" }
        >,
        Extract<
          RuntimeCleanupInstruction,
          { readonly action: "discard-broker-listener-authorization" }
        >,
        Extract<RuntimeCleanupInstruction, { readonly action: "stop-sidecar" }>,
      ]
    : State extends { readonly stage: "sidecar-recovery-required" }
      ? readonly [
          Extract<
            RuntimeCleanupInstruction,
            { readonly action: "discard-supervisor-authorization" }
          >,
          Extract<
            RuntimeCleanupInstruction,
            { readonly action: "discard-broker-listener-authorization" }
          >,
          Extract<
            RuntimeCleanupInstruction,
            { readonly action: "cleanup-sidecar-recovery" }
          >,
        ]
      : State extends { readonly stage: "listener-running" }
        ? readonly [
            Extract<
              RuntimeCleanupInstruction,
              { readonly action: "discard-supervisor-authorization" }
            >,
            Extract<
              RuntimeCleanupInstruction,
              { readonly action: "stop-listener" }
            >,
            Extract<
              RuntimeCleanupInstruction,
              { readonly action: "stop-sidecar" }
            >,
          ]
        : State extends { readonly stage: "listener-recovery-required" }
          ? readonly [
              Extract<
                RuntimeCleanupInstruction,
                { readonly action: "discard-supervisor-authorization" }
              >,
              Extract<
                RuntimeCleanupInstruction,
                { readonly action: "cleanup-listener-recovery" }
              >,
              Extract<
                RuntimeCleanupInstruction,
                { readonly action: "stop-sidecar" }
              >,
            ]
          : State extends { readonly stage: "worker-running" }
            ? readonly [
                Extract<
                  RuntimeCleanupInstruction,
                  { readonly action: "cleanup-worker" }
                >,
                Extract<
                  RuntimeCleanupInstruction,
                  { readonly action: "stop-listener" }
                >,
                Extract<
                  RuntimeCleanupInstruction,
                  { readonly action: "stop-sidecar" }
                >,
              ]
            : readonly [
                Extract<
                  RuntimeCleanupInstruction,
                  { readonly action: "cleanup-worker-recovery" }
                >,
                Extract<
                  RuntimeCleanupInstruction,
                  { readonly action: "stop-listener" }
                >,
                Extract<
                  RuntimeCleanupInstruction,
                  { readonly action: "stop-sidecar" }
                >,
              ];

export type WorkerRuntimeAuthorizationAssemblyResult =
  | {
      readonly status: "ready";
      readonly authorizations: PreparedWorkerRuntimeAuthorizations;
    }
  | {
      readonly status: "denied";
      readonly reason:
        | "session-inactive"
        | "worker-lease-not-current"
        | "credential-lease-not-current"
        | "first-slice-provider-cardinality-mismatch"
        | "configuration-authority-revoked"
        | "launch-verification-failed";
    };

/**
 * Resolves current grants/configuration, re-verifies mount identities and
 * builds the only ephemeral authorization that may reach the supervisor.
 */
export interface WorkerRuntimeAuthorizationAssemblyPort {
  assemble(input: {
    readonly supervisorContext: TrustedServiceAuthorizationContext<"supervisor">;
    readonly brokerContext: TrustedServiceAuthorizationContext<"broker">;
    readonly sessionId: SessionId;
    readonly workerLeaseId: WorkerLeaseId;
    readonly workerFencingToken: number;
  }): Promise<WorkerRuntimeAuthorizationAssemblyResult>;
  planCleanup<State extends RuntimeStartupResourceState>(
    state: State,
  ): RuntimeStartupCleanupPlanFor<State>;
  /** Consumes one exact still-ready token; aggregate partial state is impossible. */
  discardAuthorization(
    authorization:
      | ReadySupervisorLaunchAuthorization
      | ReadyBrokerListenerAuthorization
      | ReadyNativeLibrarySidecarAuthorization,
  ): Promise<"discarded" | "already-consumed-or-discarded">;
}

/** Opaque running trusted sidecar; it exposes no credential or origin control. */
export interface RunningNativeLibrarySidecar {
  readonly [nativeSidecarBrand]: true;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly providerConnectionId: ProviderConnectionId;
}

export type LiveExternalStartRejectionReason =
  | "session-inactive"
  | "worker-lease-not-current"
  | "worker-fence-mismatch"
  | "credential-lease-not-current"
  | "configuration-authority-revoked";

export type NativeSidecarStartResult =
  | {
      readonly status: "started";
      readonly authorization: ConsumedNativeLibrarySidecarAuthorization;
      readonly sidecar: RunningNativeLibrarySidecar;
    }
  | {
      /** Idempotent duplicate returns the exact already-running sidecar. */
      readonly status: "already-running";
      readonly authorization: ConsumedNativeLibrarySidecarAuthorization;
      readonly sidecar: RunningNativeLibrarySidecar;
    }
  | {
      /** Replay after a prior non-running outcome never repeats startup I/O. */
      readonly status: "replay-rejected";
      readonly authorization: ConsumedNativeLibrarySidecarAuthorization;
      readonly externalEffect: "not-started";
    }
  | {
      /** Live authority is rechecked as the linearization before process I/O. */
      readonly status: "rejected";
      readonly authorization: ConsumedNativeLibrarySidecarAuthorization;
      readonly reason: LiveExternalStartRejectionReason;
      readonly externalEffect: "not-started";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "failed-absent";
      readonly authorization: ConsumedNativeLibrarySidecarAuthorization;
      readonly reason:
        | "pinned-native-stack-unavailable"
        | "catalog-integrity-mismatch"
        | "credential-store-unavailable"
        | "egress-boundary-unavailable";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "recovery-required";
      readonly authorization: ConsumedNativeLibrarySidecarAuthorization;
      readonly reason:
        | "readiness-timeout"
        | "startup-outcome-unknown"
        | "live-authority-rejected-with-existing-resource";
      readonly recovery: NativeSidecarRecoveryHandle;
    };

export type NativeSidecarDiscoveryResult =
  | { readonly status: "found"; readonly sidecar: RunningNativeLibrarySidecar }
  | { readonly status: "confirmed-absent" }
  | {
      readonly status: "unknown";
      readonly recovery: NativeSidecarRecoveryHandle;
    };

export type NativeSidecarShutdownResult =
  | { readonly status: "confirmed-stopped" }
  | {
      readonly status: "recovery-required";
      readonly reason: "deadline-elapsed" | "inspection-failed";
      readonly recovery: NativeSidecarRecoveryHandle;
    };

/**
 * The implementation reuses Pi's pinned ModelRuntime/provider stack. It never
 * accepts a provider URL, raw credential, provider-specific Hitch adapter, or
 * an invocation that has not durably reached send-started.
 */
export interface NativeLibrarySidecarPort {
  start(input: {
    readonly context: TrustedServiceAuthorizationContext<"broker">;
    readonly authorization: ReadyNativeLibrarySidecarAuthorization;
  }): Promise<NativeSidecarStartResult>;

  discover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly identity: WorkerRuntimeIdentity;
  }): Promise<NativeSidecarDiscoveryResult>;

  recover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: NativeSidecarRecoveryHandle;
  }): Promise<NativeSidecarDiscoveryResult>;

  /** Discovers and stops an uncertain sidecar as one recovery operation. */
  cleanupRecovery(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: NativeSidecarRecoveryHandle;
  }): Promise<NativeSidecarShutdownResult>;

  /**
   * Applies the existing version-pinned provider validation contract to one
   * capability-authenticated local request. The connection is resolved from
   * the sidecar authorization; the request cannot select one.
   */
  validateRequest(input: {
    readonly sidecar: RunningNativeLibrarySidecar;
    readonly request: AuthenticatedBrokerRequest;
  }): ProviderRequestValidationResult;

  invoke(input: {
    readonly sidecar: RunningNativeLibrarySidecar;
    readonly invocation: SendStartedProviderInvocation;
  }): Promise<NativeSidecarInvocationResult>;

  cancelInvocation(input: {
    readonly sidecar: RunningNativeLibrarySidecar;
    readonly forwardingAttemptId: InferenceForwardingAttemptId;
  }): Promise<"cancellation-requested" | "already-finished" | "not-found">;

  stop(
    sidecar: RunningNativeLibrarySidecar,
  ): Promise<NativeSidecarShutdownResult>;
}

/**
 * Correlation rejection is fail-closed and occurs before credential resolution,
 * native ModelRuntime invocation, or upstream I/O.
 */
export type NativeSidecarInvocationResult =
  | BrokeredInferenceInvocationResult
  | {
      readonly status: "correlation-rejected";
      readonly reason:
        | "worker-lease-mismatch"
        | "worker-fence-mismatch"
        | "provider-connection-mismatch";
      readonly externalEffect: "not-started";
    };

/** Capability-authenticated request emitted by the local broker listener. */
export interface AuthenticatedBrokerRequest {
  readonly [authenticatedBrokerRequestBrand]: true;
  readonly request: InferenceBridgeInboundRequest;
  readonly authorizationContext: ProviderRequestAuthorizationContext;
}

export interface ActiveBrokerListener {
  readonly [activeBrokerListenerBrand]: true;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly providerConnectionId: ProviderConnectionId;
  requests(): AsyncIterable<AuthenticatedBrokerRequest>;
}

export type BrokerListenerDiscoveryResult =
  | { readonly status: "found"; readonly listener: ActiveBrokerListener }
  | { readonly status: "confirmed-absent" }
  | {
      readonly status: "unknown";
      readonly recovery: BrokerListenerRecoveryHandle;
    };

export type BrokerListenerStartResult =
  | {
      readonly status: "listening";
      readonly authorization: ConsumedBrokerListenerAuthorization;
      readonly listener: ActiveBrokerListener;
    }
  | {
      readonly status: "already-listening";
      readonly authorization: ConsumedBrokerListenerAuthorization;
      readonly listener: ActiveBrokerListener;
    }
  | {
      /** Replay after a prior non-listening outcome never repeats startup I/O. */
      readonly status: "replay-rejected";
      readonly authorization: ConsumedBrokerListenerAuthorization;
      readonly externalEffect: "not-started";
    }
  | {
      /** Revalidated immediately before binding/registering the capability. */
      readonly status: "rejected";
      readonly authorization: ConsumedBrokerListenerAuthorization;
      readonly reason:
        | LiveExternalStartRejectionReason
        | "sidecar-correlation-mismatch";
      readonly externalEffect: "not-started";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "failed-absent";
      readonly authorization: ConsumedBrokerListenerAuthorization;
      readonly reason: "local-endpoint-unavailable";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "recovery-required";
      readonly authorization: ConsumedBrokerListenerAuthorization;
      readonly reason:
        | "capability-registration-failed"
        | "listener-startup-outcome-unknown"
        | "live-authority-rejected-with-existing-resource";
      readonly recovery: BrokerListenerRecoveryHandle;
    };

export type BrokerListenerShutdownResult =
  | { readonly status: "confirmed-stopped" }
  | {
      readonly status: "recovery-required";
      readonly reason: "deadline-elapsed" | "inspection-failed";
      readonly recovery: BrokerListenerRecoveryHandle;
    };

/**
 * The listener authenticates local capabilities before yielding a request.
 * Invalid/stale capabilities are denied internally and never become an
 * AuthenticatedBrokerRequest.
 */
export interface BrokerListenerPort {
  start(input: {
    readonly context: TrustedServiceAuthorizationContext<"broker">;
    readonly authorization: ReadyBrokerListenerAuthorization;
    readonly sidecar: RunningNativeLibrarySidecar;
  }): Promise<BrokerListenerStartResult>;
  discover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly identity: WorkerRuntimeIdentity;
  }): Promise<BrokerListenerDiscoveryResult>;
  recover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: BrokerListenerRecoveryHandle;
  }): Promise<BrokerListenerDiscoveryResult>;
  /** Discovers and stops an uncertain listener as one recovery operation. */
  cleanupRecovery(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: BrokerListenerRecoveryHandle;
  }): Promise<BrokerListenerShutdownResult>;
  stop(listener: ActiveBrokerListener): Promise<BrokerListenerShutdownResult>;
}

/** Opaque supervisor-owned sandbox/lifetime container. */
export interface LaunchedSupervisorWorker {
  readonly [supervisorWorkerBrand]: true;
  readonly [supervisorWorkerProcessBrand]: SupervisorOwnedAgentProcess;
  readonly sessionId: SessionId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
}

export type SupervisorWorkerLaunchResult =
  | {
      readonly status: "launched";
      readonly authorization: ConsumedSupervisorLaunchAuthorization;
      readonly worker: LaunchedSupervisorWorker;
    }
  | {
      readonly status: "already-running";
      readonly authorization: ConsumedSupervisorLaunchAuthorization;
      readonly worker: LaunchedSupervisorWorker;
    }
  | {
      /** Replay after a prior non-running outcome never repeats launch I/O. */
      readonly status: "replay-rejected";
      readonly authorization: ConsumedSupervisorLaunchAuthorization;
      readonly externalEffect: "not-started";
    }
  | {
      /** Revalidated immediately before sandbox/lifetime-container creation. */
      readonly status: "rejected";
      readonly authorization: ConsumedSupervisorLaunchAuthorization;
      readonly reason:
        | LiveExternalStartRejectionReason
        | "sidecar-correlation-mismatch"
        | "listener-correlation-mismatch";
      readonly externalEffect: "not-started";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "failed-absent";
      readonly authorization: ConsumedSupervisorLaunchAuthorization;
      readonly reason: "sandbox-preflight-failed";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "recovery-required";
      readonly authorization: ConsumedSupervisorLaunchAuthorization;
      readonly reason:
        | "old-sandbox-not-confirmed-dead"
        | "sandbox-launch-failed"
        | "worker-readiness-timeout"
        | "launch-outcome-unknown"
        | "live-authority-rejected-with-existing-resource";
      readonly recovery: SupervisorWorkerRecoveryHandle;
    };

export type SupervisorWorkerDiscoveryResult =
  | { readonly status: "found"; readonly worker: LaunchedSupervisorWorker }
  | { readonly status: "confirmed-absent" }
  | {
      readonly status: "unknown";
      readonly recovery: SupervisorWorkerRecoveryHandle;
    };

export type SupervisorWorkerInspection =
  | { readonly status: "running" }
  | { readonly status: "exited" }
  | { readonly status: "confirmed-absent" }
  | {
      readonly status: "unknown";
      readonly recovery: SupervisorWorkerRecoveryHandle;
    };

export type SupervisorCancellationReason =
  | "turn-cancelling"
  | "session-stopped"
  | "authority-revoked"
  | "shutdown"
  | "recovery";

export type SupervisorCancellationResult =
  | { readonly status: "requested" }
  | { readonly status: "already-exited" | "worker-not-found" }
  | { readonly status: "request-failed" };

export type SupervisorCleanupResult =
  | { readonly status: "confirmed-gone" }
  | {
      readonly status: "recovery-required";
      readonly reason:
        | "termination-deadline-elapsed"
        | "descendant-cleanup-failed"
        | "inspection-failed";
      readonly recovery: SupervisorWorkerRecoveryHandle;
    };

export type SupervisorTerminationResult =
  | { readonly status: "confirmed-stopped" }
  | {
      readonly status: "recovery-required";
      readonly reason: "deadline-elapsed" | "inspection-failed";
      readonly recovery: SupervisorWorkerRecoveryHandle;
    };

/**
 * Launch consumes each sealed authorization once and validates its sidecar and
 * listener correlation before process creation. Grace/deadline values come
 * from installation policy and are never caller input.
 */
export interface WorkerSupervisorPort {
  launch(input: {
    readonly context: TrustedServiceAuthorizationContext<"supervisor">;
    readonly authorization: ReadySupervisorLaunchAuthorization;
    readonly sidecar: RunningNativeLibrarySidecar;
    readonly brokerListener: ActiveBrokerListener;
  }): Promise<SupervisorWorkerLaunchResult>;
  discover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly identity: WorkerRuntimeIdentity;
  }): Promise<SupervisorWorkerDiscoveryResult>;
  recover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: SupervisorWorkerRecoveryHandle;
  }): Promise<SupervisorWorkerDiscoveryResult>;
  /** Discovers and cleans an uncertain worker/descendant tree to a safe result. */
  cleanupRecovery(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: SupervisorWorkerRecoveryHandle;
  }): Promise<SupervisorCleanupResult>;
  inspect(worker: LaunchedSupervisorWorker): Promise<SupervisorWorkerInspection>;
  requestCancellation(input: {
    readonly worker: LaunchedSupervisorWorker;
    readonly reason: SupervisorCancellationReason;
  }): Promise<SupervisorCancellationResult>;
  terminate(
    worker: LaunchedSupervisorWorker,
  ): Promise<SupervisorTerminationResult>;
  cleanup(worker: LaunchedSupervisorWorker): Promise<SupervisorCleanupResult>;
}

export type PiAgentDriverDefinition = AgentDriverDefinition & {
  readonly capabilities: AgentDriverCapabilities & {
    readonly protocol: "pi-rpc";
  };
};

export type PiAgentRuntimeConstructionResult =
  | { readonly status: "attached"; readonly runtime: AgentRuntime }
  | {
      readonly status: "already-attached" | "safely-reattached";
      readonly runtime: AgentRuntime;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | LiveExternalStartRejectionReason
        | "worker-process-correlation-mismatch";
      readonly externalEffect: "not-started";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "failed-unattached";
      readonly reason: "driver-mismatch" | "protocol-preflight-failed";
      readonly absence: "confirmed";
    }
  | {
      readonly status: "recovery-required";
      readonly reason:
        | "protocol-attach-outcome-unknown"
        | "live-authority-rejected-with-existing-attachment";
      readonly recovery: PiRuntimeAttachmentRecoveryHandle;
    };

export type PiRuntimeAttachmentDiscoveryResult =
  | { readonly status: "attached"; readonly runtime: AgentRuntime }
  | { readonly status: "confirmed-unattached" }
  | {
      readonly status: "unknown";
      readonly recovery: PiRuntimeAttachmentRecoveryHandle;
    };

/**
 * Constructs the existing AgentRuntime over the already launched,
 * supervisor-owned process. It receives no launch authorization or supervisor
 * process-control method, and AgentRuntime prepares existing AgentTurnRun.
 */
export interface PiAgentRuntimeConstructionPort {
  attach(input: {
    readonly context: TrustedServiceAuthorizationContext<"supervisor">;
    readonly driver: PiAgentDriverDefinition;
    readonly worker: LaunchedSupervisorWorker;
  }): Promise<PiAgentRuntimeConstructionResult>;
  discover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly identity: WorkerRuntimeIdentity;
  }): Promise<PiRuntimeAttachmentDiscoveryResult>;
  recover(input: {
    readonly context: TrustedServiceAuthorizationContext<"recovery">;
    readonly recovery: PiRuntimeAttachmentRecoveryHandle;
    readonly driver: PiAgentDriverDefinition;
    readonly worker: LaunchedSupervisorWorker;
  }): Promise<PiAgentRuntimeConstructionResult>;
}

/** Compile-only assertion surface: B2 does not replace either existing type. */
export interface ExistingPiRuntimeTypes {
  readonly runtime: AgentRuntime;
  readonly turnRun: AgentTurnRun;
}

/** One exact delivery, bound to the current private route and authority. */
export interface ReadyAuthorizedDelivery {
  readonly [readyDeliveryBrand]: true;
  readonly [authorizedDeliveryRoutePayloadBrand]: AuthorizedPrivateDeliveryRoute;
  readonly attempt: TurnResponseDeliveryAttempt & {
    readonly state: { readonly status: "in-progress" };
  };
  readonly terminalResponse: TurnTerminalResponse;
}

/** Fixture-visible proof that exposes neither the private key nor route value. */
export type ReadyAuthorizedDeliveryCarriesPrivateRoute =
  ReadyAuthorizedDelivery extends {
    readonly [authorizedDeliveryRoutePayloadBrand]: AuthorizedPrivateDeliveryRoute;
  }
    ? true
    : false;

export interface ConsumedAuthorizedDelivery {
  readonly [consumedDeliveryBrand]: true;
  readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
}

export type DeliveryInvocationAuthorizationResult =
  | { readonly status: "ready"; readonly delivery: ReadyAuthorizedDelivery }
  | {
      readonly status: "not-authorized";
      readonly revocation: DeliveryAuthorizationRevocationEvidence;
    }
  | {
      readonly status: "not-ready";
      readonly reason: "attempt-not-in-progress" | "terminal-response-mismatch";
    };

/**
 * Immediately-before-send authorization loads the immutable response and
 * current private route internally. No caller-provided destination crosses the
 * boundary.
 */
export interface DeliveryInvocationAuthorizationPort {
  authorize(input: {
    readonly context: TrustedServiceAuthorizationContext<"delivery">;
    /** Trusted storage loads and rechecks the attempt; callers supply no state. */
    readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
  }): Promise<DeliveryInvocationAuthorizationResult>;
}

export type AuthorizedDeliveryTransportResult =
  | {
      readonly status: "attempted";
      readonly authorization: ConsumedAuthorizedDelivery;
      readonly outcome: DeliveryTransportOutcome;
    }
  | {
      /**
       * Binding generation/authority changed after preparation. The transport
       * consumes the one-use delivery but writes no connector byte.
       */
      readonly status: "not-authorized";
      readonly authorization: ConsumedAuthorizedDelivery;
      readonly revocation: DeliveryAuthorizationRevocationEvidence;
      readonly externalEffect: "not-started";
    }
  | {
      readonly status: "duplicate-rejected";
      readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
    };

/**
 * Installation-private local delivery only. The sealed value contains the
 * authorized destination internally; callers cannot select a connector,
 * address, principal, or endpoint binding.
 */
export interface AuthorizedDeliveryTransportPort {
  /**
   * Linearization is the transport-owned atomic comparison of the hidden
   * binding generation and current authority while consuming `delivery`.
   * Only the successful branch may proceed to the first connector write.
   */
  deliver(input: {
    readonly context: TrustedServiceAuthorizationContext<"delivery">;
    readonly delivery: ReadyAuthorizedDelivery;
  }): Promise<AuthorizedDeliveryTransportResult>;
}

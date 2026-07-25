/** Compile-only negative and exact-boundary guards for V2-001B2. */

import type {
  ActiveBrokerListener,
  AttachmentRecoveryQuiescence,
  AttachmentRecoveryQuiescencePort,
  AttachmentStageRecoveryAuthorizationPort,
  AuthenticatedBrokerRequest,
  AuthorizedDeliveryTransportPort,
  BrokerListenerPort,
  BrokerListenerRecoveryHandle,
  CompletedAttachmentRecovery,
  DeliveryInvocationAuthorizationPort,
  LaunchedSupervisorWorker,
  NativeLibrarySidecarPort,
  NativeSidecarInvocationResult,
  NativeSidecarRecoveryHandle,
  OrphanedAttachmentStage,
  PiAgentRuntimeConstructionPort,
  PrivateAttachmentStoragePort,
  ReadyBrokerListenerAuthorization,
  ReadyNativeLibrarySidecarAuthorization,
  ReadyAuthorizedDelivery,
  ReadyAuthorizedDeliveryCarriesPrivateRoute,
  ReadySupervisorLaunchAuthorization,
  RuntimeStartupCleanupPlanFor,
  RuntimeStartupResourceState,
  RunningNativeLibrarySidecar,
  SupervisorCancellationReason,
  SupervisorWorkerRecoveryHandle,
  WorkerRuntimeIdentity,
  WorkerRuntimeAuthorizationAssemblyPort,
  WorkerSupervisorPort,
} from "./external-runtime.js";
import type {
  BoundProviderInvocation,
  ProviderRequestValidationResult,
  SendStartedProviderInvocation,
} from "./provider-broker.js";
import type {
  AgentRuntime,
  AgentTurnRun,
} from "./agent-runtime.js";
import type {
  BoundedConnectorImageUpload,
  DeliveryAuthorizationRevocationEvidence,
  FirstSliceTransactionPort,
  TrustedServiceAuthorizationContext,
} from "./application.js";
import type { SupervisorLaunchAuthorization } from "./runtime-security.js";

type Assert<Condition extends true> = Condition;
type HasKey<Record, Key extends PropertyKey> = Key extends keyof Record ? true : false;
type HasAnyKey<Record, Keys extends PropertyKey> =
  Extract<Keys, keyof Record> extends never ? false : true;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type AttachmentStageInput = Parameters<
  PrivateAttachmentStoragePort["stageBoundedImage"]
>[0];
type _AttachmentStageConsumesOnlyBoundedConnectorUpload = Assert<
  Equal<AttachmentStageInput, BoundedConnectorImageUpload>
>;
type _AttachmentStageCannotReceiveRawBytesOrPath = Assert<
  Equal<
    HasAnyKey<
      AttachmentStageInput,
      "bytes" | "stream" | "sourcePath" | "hostPath" | "attachmentId"
    >,
    false
  >
>;
type AttachmentFinalizationInput = Parameters<
  PrivateAttachmentStoragePort["finalizeAdmittedImage"]
>[0];
type _FinalizationRequiresAdmittedImage = Assert<
  Equal<
    AttachmentFinalizationInput["admission"]["status"],
    "admitted"
  >
>;
type _FinalizationRequiresMatchingAttachmentProjection = Assert<
  Equal<
    undefined extends AttachmentFinalizationInput["admission"]["attachment"]
      ? true
      : false,
    false
  >
>;
type OrphanCleanupInput = Parameters<
  PrivateAttachmentStoragePort["cleanupProvenUnadmittedStage"]
>[0];
type _OrphanDiscoveryAloneCannotAuthorizeDeletion = Assert<
  Equal<OrphanedAttachmentStage extends OrphanCleanupInput ? true : false, false>
>;
type _OrphanResolutionRequiresRecoveryAuthorization = Assert<
  Equal<
    Parameters<
      AttachmentStageRecoveryAuthorizationPort["authorizeResolution"]
    >[0]["orphan"],
    OrphanedAttachmentStage
  >
>;
type OrphanDiscoveryInput = Parameters<
  PrivateAttachmentStoragePort["discoverAndClaimOrphanedStages"]
>[0];
type _OrphanDiscoveryRequiresStartupQuiescence = Assert<
  Equal<OrphanDiscoveryInput, AttachmentRecoveryQuiescence>
>;
type OrphanAuthorizationInput = Parameters<
  AttachmentStageRecoveryAuthorizationPort["authorizeResolution"]
>[0];
type _PersistenceDecisionUsesSameQuiescence = Assert<
  Equal<
    OrphanAuthorizationInput["quiescence"],
    AttachmentRecoveryQuiescence
  >
>;
type _QuiescenceRequiresIngressAndAdmissionDrain = Assert<
  Equal<
    Awaited<
      ReturnType<AttachmentRecoveryQuiescencePort["enter"]>
    >["status"],
    "quiescent" | "not-quiescent"
  >
>;
type OrphanCleanupResult = Awaited<
  ReturnType<PrivateAttachmentStoragePort["cleanupProvenUnadmittedStage"]>
>;
type _StaleOrphanClaimIsFailClosed = Assert<
  Equal<"claim-stale" extends OrphanCleanupResult ? true : false, true>
>;
type _QuiescenceReleaseRequiresAllClaimsResolved = Assert<
  Equal<
    Parameters<AttachmentRecoveryQuiescencePort["release"]>[0],
    CompletedAttachmentRecovery
  >
>;
type RecoveryCompletion = Awaited<
  ReturnType<PrivateAttachmentStoragePort["completeRecovery"]>
>;
type _OutstandingClaimsCannotMintReleaseProof = Assert<
  Equal<
    HasKey<
      Extract<RecoveryCompletion, { readonly status: "claims-outstanding" }>,
      "completion"
    >,
    false
  >
>;

type _ReadyLaunchDoesNotExposePayload = Assert<
  Equal<
    HasAnyKey<
      ReadySupervisorLaunchAuthorization,
      | "authorization"
      | "mounts"
      | "canonicalHostPath"
      | "brokerCapability"
      | "credential"
    >,
    false
  >
>;
type SupervisorLaunchInput = Parameters<WorkerSupervisorPort["launch"]>[0];
type _SupervisorRequiresSealedLaunchAuthorization = Assert<
  Equal<
    SupervisorLaunchInput["authorization"],
    ReadySupervisorLaunchAuthorization
  >
>;
type _SupervisorLaunchRequiresReadySidecar = Assert<
  Equal<SupervisorLaunchInput["sidecar"], RunningNativeLibrarySidecar>
>;
type _SupervisorLaunchRequiresReadyBrokerListener = Assert<
  Equal<SupervisorLaunchInput["brokerListener"], ActiveBrokerListener>
>;
type _SupervisorHasNoCallerDeadline = Assert<
  Equal<
    HasAnyKey<
      Parameters<WorkerSupervisorPort["terminate"]>[0],
      "timeoutMs" | "deadlineAt" | "graceMs"
    >,
    false
  >
>;
type _SupervisorCancellationReasonIsClosed = Assert<
  Equal<string extends SupervisorCancellationReason ? true : false, false>
>;
type _SessionWorkerIsNotBoundToOneTurnAttempt = Assert<
  Equal<
    HasAnyKey<LaunchedSupervisorWorker, "turnId" | "attemptId">,
    false
  >
>;
type _ApplicationCannotWriteSupervisorProcessDirectly = Assert<
  Equal<HasKey<LaunchedSupervisorWorker, "agentProcess">, false>
>;
type RuntimeAssemblyInput = Parameters<
  WorkerRuntimeAuthorizationAssemblyPort["assemble"]
>[0];
type _RuntimeAssemblyRequiresSeparateSupervisorAndBrokerContexts = Assert<
  Equal<
    HasKey<RuntimeAssemblyInput, "supervisorContext"> &
      HasKey<RuntimeAssemblyInput, "brokerContext">,
    true
  >
>;
type _FirstSliceBrokerAuthorizationIsSingular = Assert<
  Equal<
    HasAnyKey<
      ReadyBrokerListenerAuthorization,
      "credentialLeaseIds" | "providerConnectionIds"
    >,
    false
  >
>;
type _FirstSliceSidecarAuthorizationIsSingular = Assert<
  Equal<
    HasKey<ReadyNativeLibrarySidecarAuthorization, "providerConnectionId">,
    true
  >
>;
type SidecarStart = Awaited<ReturnType<NativeLibrarySidecarPort["start"]>>;
type ListenerStart = Awaited<ReturnType<BrokerListenerPort["start"]>>;
type SupervisorStart = Awaited<ReturnType<WorkerSupervisorPort["launch"]>>;
type _SidecarStartRechecksTrustedContext = Assert<
  Equal<
    HasKey<Parameters<NativeLibrarySidecarPort["start"]>[0], "context">,
    true
  >
>;
type _ListenerStartRechecksTrustedContext = Assert<
  Equal<
    HasKey<Parameters<BrokerListenerPort["start"]>[0], "context">,
    true
  >
>;
type _SupervisorStartRechecksTrustedContext = Assert<
  Equal<
    HasKey<SupervisorLaunchInput, "context">,
    true
  >
>;
type _RejectedSidecarStartGuaranteesNoResource = Assert<
  Equal<
    Extract<SidecarStart, { readonly status: "rejected" }>["absence"],
    "confirmed"
  >
>;
type _ReplayedSidecarStartWritesNothing = Assert<
  Equal<
    Extract<
      SidecarStart,
      { readonly status: "replay-rejected" }
    >["externalEffect"],
    "not-started"
  >
>;
type _ReplayedListenerStartWritesNothing = Assert<
  Equal<
    Extract<
      ListenerStart,
      { readonly status: "replay-rejected" }
    >["externalEffect"],
    "not-started"
  >
>;
type _ReplayedSupervisorStartWritesNothing = Assert<
  Equal<
    Extract<
      SupervisorStart,
      { readonly status: "replay-rejected" }
    >["externalEffect"],
    "not-started"
  >
>;
type _UncertainSidecarStartReturnsRecovery = Assert<
  Equal<
    Extract<
      SidecarStart,
      { readonly status: "recovery-required" }
    >["recovery"],
    NativeSidecarRecoveryHandle
  >
>;
type _UncertainListenerStartReturnsRecovery = Assert<
  Equal<
    Extract<
      ListenerStart,
      { readonly status: "recovery-required" }
    >["recovery"],
    BrokerListenerRecoveryHandle
  >
>;
type _UncertainSupervisorStartReturnsRecovery = Assert<
  Equal<
    Extract<
      SupervisorStart,
      { readonly status: "recovery-required" }
    >["recovery"],
    SupervisorWorkerRecoveryHandle
  >
>;
type _SidecarDiscoveryUsesExactWorkerIdentity = Assert<
  Equal<
    Parameters<NativeLibrarySidecarPort["discover"]>[0]["identity"],
    WorkerRuntimeIdentity
  >
>;
type _ListenerDiscoveryUsesExactWorkerIdentity = Assert<
  Equal<
    Parameters<BrokerListenerPort["discover"]>[0]["identity"],
    WorkerRuntimeIdentity
  >
>;
type _WorkerDiscoveryUsesExactWorkerIdentity = Assert<
  Equal<
    Parameters<WorkerSupervisorPort["discover"]>[0]["identity"],
    WorkerRuntimeIdentity
  >
>;
type _SidecarCleanupAcceptsOnlyItsRecoveryHandle = Assert<
  Equal<
    Parameters<NativeLibrarySidecarPort["cleanupRecovery"]>[0]["recovery"],
    NativeSidecarRecoveryHandle
  >
>;
type _ListenerCleanupAcceptsOnlyItsRecoveryHandle = Assert<
  Equal<
    Parameters<BrokerListenerPort["cleanupRecovery"]>[0]["recovery"],
    BrokerListenerRecoveryHandle
  >
>;
type _WorkerCleanupAcceptsOnlyItsRecoveryHandle = Assert<
  Equal<
    Parameters<WorkerSupervisorPort["cleanupRecovery"]>[0]["recovery"],
    SupervisorWorkerRecoveryHandle
  >
>;
type _NoVaguePartialDiscard = Assert<
  Equal<
    HasKey<WorkerRuntimeAuthorizationAssemblyPort, "discardUnconsumed">,
    false
  >
>;
type _ExactAuthorizationDiscardHasNoPartialResult = Assert<
  Equal<
    Awaited<
      ReturnType<
        WorkerRuntimeAuthorizationAssemblyPort["discardAuthorization"]
      >
    >,
    "discarded" | "already-consumed-or-discarded"
  >
>;
type SidecarRecoveryState = Extract<
  RuntimeStartupResourceState,
  { readonly stage: "sidecar-recovery-required" }
>;
type SidecarRecoveryCleanupPlan =
  RuntimeStartupCleanupPlanFor<SidecarRecoveryState>;
type _SidecarRecoveryPlanIsExactAndOrdered = Assert<
  Equal<
    readonly [
      SidecarRecoveryCleanupPlan[0]["action"],
      SidecarRecoveryCleanupPlan[1]["action"],
      SidecarRecoveryCleanupPlan[2]["action"],
    ],
    readonly [
      "discard-supervisor-authorization",
      "discard-broker-listener-authorization",
      "cleanup-sidecar-recovery",
    ]
  >
>;

type SidecarInvocationInput = Parameters<
  NativeLibrarySidecarPort["invoke"]
>[0]["invocation"];
type _SidecarRequiresSendStartedEvidence = Assert<
  Equal<SidecarInvocationInput, SendStartedProviderInvocation>
>;
type _ReadyForwardingAggregateCannotInvokeSidecar = Assert<
  Equal<
    BoundProviderInvocation extends SidecarInvocationInput ? true : false,
    false
  >
>;
type _SidecarCorrelationFailureIsNoIo = Assert<
  Equal<
    Extract<
      NativeSidecarInvocationResult,
      { readonly status: "correlation-rejected" }
    >["externalEffect"],
    "not-started"
  >
>;
type _SidecarCorrelationFailureReasonsAreClosed = Assert<
  Equal<
    string extends Extract<
      NativeSidecarInvocationResult,
      { readonly status: "correlation-rejected" }
    >["reason"]
      ? true
      : false,
    false
  >
>;
type SidecarStartInput = Parameters<
  NativeLibrarySidecarPort["start"]
>[0];
type _SidecarStartCannotChooseOriginOrCredential = Assert<
  Equal<
    HasAnyKey<
      SidecarStartInput,
      "origin" | "baseUrl" | "apiKey" | "oauthToken" | "credential"
    >,
    false
  >
>;
type SidecarValidationInput = Parameters<
  NativeLibrarySidecarPort["validateRequest"]
>[0];
type _SidecarValidationRequiresAuthenticatedRequest = Assert<
  Equal<SidecarValidationInput["request"], AuthenticatedBrokerRequest>
>;
type _SidecarReusesPreparedRequestValidationResult = Assert<
  Equal<
    ReturnType<NativeLibrarySidecarPort["validateRequest"]>,
    ProviderRequestValidationResult
  >
>;

type BrokerRequest = Awaited<
  ReturnType<ActiveBrokerListener["requests"]>
> extends AsyncIterable<infer Request>
  ? Request
  : never;
type _ListenerYieldsOnlyAuthenticatedRequests = Assert<
  Equal<BrokerRequest, AuthenticatedBrokerRequest>
>;
type BrokerListenerStartInput = Parameters<BrokerListenerPort["start"]>[0];
type _BrokerListenerCannotAcceptArbitraryEndpoint = Assert<
  Equal<
    HasAnyKey<
      BrokerListenerStartInput,
      "endpoint" | "socketPath" | "host" | "port"
    >,
    false
  >
>;

type PiAttachInput = Parameters<PiAgentRuntimeConstructionPort["attach"]>[0];
type _PiAttachesOnlySupervisorWorker = Assert<
  Equal<PiAttachInput["worker"], LaunchedSupervisorWorker>
>;
type _PiConstructionReturnsExistingRuntime = Assert<
  Equal<
    Extract<
      Awaited<ReturnType<PiAgentRuntimeConstructionPort["attach"]>>,
      { readonly status: "attached" }
    >["runtime"],
    AgentRuntime
  >
>;
type PiAttachResult = Awaited<
  ReturnType<PiAgentRuntimeConstructionPort["attach"]>
>;
type _PiDuplicateAttachReturnsExistingOrSafelyReattachedRuntime = Assert<
  Equal<
    Extract<
      PiAttachResult,
      { readonly status: "already-attached" | "safely-reattached" }
    >["runtime"],
    AgentRuntime
  >
>;
type _PiAttachRechecksTrustedContext = Assert<
  Equal<HasKey<PiAttachInput, "context">, true>
>;
type _ExistingRuntimeStillOwnsTurnRun = Assert<
  Equal<
    Awaited<ReturnType<AgentRuntime["prepareTurn"]>>,
    AgentTurnRun
  >
>;

type DeliveryInput = Parameters<
  AuthorizedDeliveryTransportPort["deliver"]
>[0];
type _DeliveryTransportRequiresSealedAuthorization = Assert<
  Equal<DeliveryInput["delivery"], ReadyAuthorizedDelivery>
>;
type _DeliveryAttemptMustBeInProgress = Assert<
  Equal<ReadyAuthorizedDelivery["attempt"]["state"]["status"], "in-progress">
>;
type _DeliveryCannotChooseDestination = Assert<
  Equal<
    HasAnyKey<
      ReadyAuthorizedDelivery,
      "destination" | "endpointId" | "endpointBindingId" | "address" | "principalId"
    >,
    false
  >
>;
type _SealedDeliveryContainsHiddenRoutePayload = Assert<
  Equal<ReadyAuthorizedDeliveryCarriesPrivateRoute, true>
>;
type DeliveryAuthorizationInput = Parameters<
  DeliveryInvocationAuthorizationPort["authorize"]
>[0];
type _DeliveryAuthorizationLoadsStateByAttemptId = Assert<
  Equal<HasKey<DeliveryAuthorizationInput, "deliveryAttemptId">, true>
>;
type _DeliveryAuthorizationRejectsCallerAuthoredAttemptState = Assert<
  Equal<HasKey<DeliveryAuthorizationInput, "attempt">, false>
>;
type _LateDeliveryDenialReturnsSealedSuppressionEvidence = Assert<
  Equal<
    Extract<
      Awaited<
        ReturnType<DeliveryInvocationAuthorizationPort["authorize"]>
      >,
      { readonly status: "not-authorized" }
    >["revocation"],
    DeliveryAuthorizationRevocationEvidence
  >
>;
type LateTransportDenial = Extract<
  Awaited<ReturnType<AuthorizedDeliveryTransportPort["deliver"]>>,
  { readonly status: "not-authorized" }
>;
type _TransportLinearizationConsumesDeniedDelivery = Assert<
  Equal<HasKey<LateTransportDenial, "authorization">, true>
>;
type _TransportLinearizationReturnsSealedRevocation = Assert<
  Equal<
    LateTransportDenial["revocation"],
    DeliveryAuthorizationRevocationEvidence
  >
>;
type _TransportLinearizationDenialWritesNothing = Assert<
  Equal<LateTransportDenial["externalEffect"], "not-started">
>;

type _ExternalPortsDoNotAcceptTransactionPort = Assert<
  Equal<
    FirstSliceTransactionPort extends Parameters<
      WorkerSupervisorPort["launch"]
    >[0]
      ? true
      : false,
    false
  >
>;

declare const rawLaunchAuthorization: SupervisorLaunchAuthorization;
declare const sidecar: RunningNativeLibrarySidecar;
declare const listener: ActiveBrokerListener;
declare const supervisor: WorkerSupervisorPort;
declare const supervisorContext: TrustedServiceAuthorizationContext<"supervisor">;
void supervisor.launch({
  context: supervisorContext,
  // @ts-expect-error Raw structural authorization is not one-use launch evidence.
  authorization: rawLaunchAuthorization,
  sidecar,
  brokerListener: listener,
});

// @ts-expect-error Authenticated broker requests require the listener's private brand.
const forgedBrokerRequest: AuthenticatedBrokerRequest = {
  request: {} as AuthenticatedBrokerRequest["request"],
  authorizationContext:
    {} as AuthenticatedBrokerRequest["authorizationContext"],
};
void forgedBrokerRequest;

/** Compile-only guards for V2-001B1 command trust and transaction boundaries. */

import type {
  AuthenticatedConnectorContext,
  AuditEnvelopeFor,
  AgentProfileResourceIdentity,
  BootstrapPublicationRecords,
  ConnectorCommandResponse,
  ConnectorCommand,
  DeliveryAttemptUnitOfWork,
  FirstSliceTransactionPort,
  IdSource,
  InferenceForwardingUnitOfWork,
  InferenceSettlementUnitOfWork,
  InferenceSettlementResultFor,
  InteractionResolutionUnitOfWork,
  PromptAcceptanceResultFor,
  ProtocolSubmissionResultFor,
  PreparedAttachmentAdmission,
  SessionCreationUnitOfWork,
  SessionStopUnitOfWork,
  StartupRecoveryDecision,
  StartupRecoveryResultFor,
  StartupRecoveryWork,
  SubmitTurnConnectorCommand,
  CreateSessionConnectorCommand,
  TurnAdmissionUnitOfWork,
  WorkspaceResourceIdentity,
} from "./application.js";
import type {
  AgentPromptAcceptanceOutcome,
  AgentTurnRun,
  ProtocolPromptSubmissionOutcome,
  SendStartedAgentInteractionResponse,
} from "./agent-runtime.js";
import type { AuthenticatedPrincipal } from "./identity-access.js";
import type {
  BoundProviderInvocation,
  BrokeredInferenceTransportBridge,
  SendStartedProviderInvocation,
} from "./provider-broker.js";
import type { TurnRecoveryRecord } from "./records.js";
import type { ToolInvocationId } from "./primitives.js";

type Assert<Condition extends true> = Condition;
type HasKey<Record, Key extends PropertyKey> = Key extends keyof Record ? true : false;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type IsNever<Value> = [Value] extends [never] ? true : false;

type _ConnectorCommandCannotChoosePrincipal = Assert<
  Equal<HasKey<ConnectorCommand, "principalId">, false>
>;
type _ConnectorCommandCannotChooseBinding = Assert<
  Equal<HasKey<ConnectorCommand, "identityBindingId">, false>
>;
type _ConnectorCommandCannotForgeOrigin = Assert<
  Equal<HasKey<ConnectorCommand, "origin">, false>
>;
type _ConnectorCommandCannotForgeSessionSpec = Assert<
  Equal<HasKey<ConnectorCommand, "sessionSpec">, false>
>;
type _ConnectorCommandCannotCarryAuthorization = Assert<
  Equal<HasKey<ConnectorCommand, "authorization">, false>
>;
type _PromptHasOnlyTrustedAttachmentReference = Assert<
  Equal<HasKey<SubmitTurnConnectorCommand, "sourcePath">, false>
>;
type _PromptCannotChooseAttachmentId = Assert<
  Equal<HasKey<SubmitTurnConnectorCommand, "attachmentId">, false>
>;
type ConnectorImageInput = NonNullable<SubmitTurnConnectorCommand["image"]>;
type _PromptCannotCarryUnboundedBytes = Assert<
  Equal<HasKey<ConnectorImageInput, "bytes">, false>
>;
type _PromptAcceptsSessionIdOrName = Assert<
  Equal<
    SubmitTurnConnectorCommand["session"]["kind"],
    "session-id" | "session-name"
  >
>;
type _OnlyPromptSuccessCarriesAttachedStream = Assert<
  Equal<
    HasKey<
      Extract<
        ConnectorCommandResponse<SubmitTurnConnectorCommand>,
        { readonly status: "succeeded" }
      >,
      "responseEvents"
    >,
    true
  >
>;
type _SessionCreationHasNoAttachedTurnStream = Assert<
  Equal<
    HasKey<
      Extract<
        ConnectorCommandResponse<CreateSessionConnectorCommand>,
        { readonly status: "succeeded" }
      >,
      "responseEvents"
    >,
    false
  >
>;

/** A structural principal alone cannot become an application request context. */
declare const principal: AuthenticatedPrincipal;
// @ts-expect-error AuthenticationContext has a private authentication brand.
const forgedAuthenticationContext: AuthenticatedConnectorContext = { actor: principal };
void forgedAuthenticationContext;

declare const transactions: FirstSliceTransactionPort;
type _TransactionPortHasNoGenericCommit = Assert<
  Equal<HasKey<FirstSliceTransactionPort, "commit">, false>
>;
type _TransactionPortHasNoCallbackRunner = Assert<
  Equal<HasKey<FirstSliceTransactionPort, "runInTransaction">, false>
>;
type _SubmissionBoundaryIsNamedUnit = Assert<
  Equal<
    HasKey<typeof transactions.submissionArming, "armProtocolSubmission">,
    true
  >
>;
type _SessionStopBoundaryIsNamedUnit = Assert<
  Equal<HasKey<FirstSliceTransactionPort, "sessionStop">, true>
>;
type _TurnResultQueryBoundaryIsNamedUnit = Assert<
  Equal<HasKey<FirstSliceTransactionPort, "turnResultQuery">, true>
>;

type SessionCreationInput = Parameters<
  SessionCreationUnitOfWork["createPrivateSession"]
>[0];
type _WriteAcceptsContextNotDecision = Assert<
  Equal<HasKey<SessionCreationInput, "context">, true>
>;
type _WriteRejectsReusableAuthorization = Assert<
  Equal<HasKey<SessionCreationInput, "authorization">, false>
>;
type _SessionCreationResolvesProfileReferenceInsideTransaction = Assert<
  Equal<HasKey<SessionCreationInput, "profileReference">, true>
>;
type _SessionCreationResolvesWorkspaceReferenceInsideTransaction = Assert<
  Equal<HasKey<SessionCreationInput, "workspaceReference">, true>
>;
type _SessionCreationDoesNotAcceptPreResolvedProfileId = Assert<
  Equal<HasKey<SessionCreationInput, "profileId">, false>
>;
type _SessionCreationDoesNotAcceptPreResolvedWorkspaceId = Assert<
  Equal<HasKey<SessionCreationInput, "workspaceId">, false>
>;
type SessionCreationResult = Awaited<
  ReturnType<SessionCreationUnitOfWork["createPrivateSession"]>
>;
type _SessionCreationHasExpectedMissingReferenceResult = Assert<
  Equal<
    Extract<SessionCreationResult, { readonly status: "not-found" }>["missing"],
    "profile" | "workspace"
  >
>;
type RevokedConfigurationUse = Extract<
  SessionCreationResult,
  {
    readonly status: "denied";
    readonly reason: "required-configuration-use-revoked";
  }
>;
type _SessionCreationCoversEveryConfigurationGrantKind = Assert<
  Equal<
    RevokedConfigurationUse["resourceKind"],
    | "agent-profile"
    | "workspace"
    | "execution-policy"
    | "turn-policy"
    | "extension"
    | "provider-credential-binding"
  >
>;
type SessionStopResult = Awaited<
  ReturnType<SessionStopUnitOfWork["stopPrivateSession"]>
>;
type _IdleSessionStopHasNoActiveCancellation = Assert<
  Equal<
    HasKey<
      Extract<SessionStopResult, { readonly status: "stop-recorded-idle" }>,
      "activeCancellation"
    >,
    false
  >
>;
type _StoppingSessionStopRequiresActiveCancellation = Assert<
  Equal<
    HasKey<
      Extract<SessionStopResult, { readonly status: "stop-recorded-stopping" }>,
      "activeCancellation"
    >,
    true
  >
>;
type _SessionCreationAuditIsActionSpecific = Assert<
  Equal<AuditEnvelopeFor<"session-created">["action"], "session-created">
>;
type TurnAdmissionInput = Parameters<TurnAdmissionUnitOfWork["admitTurn"]>[0];
type _TurnAdmissionConsumesPreparedAttachmentNotCallerId = Assert<
  Equal<HasKey<TurnAdmissionInput, "preparedAttachment">, true>
>;
type _TurnAdmissionResolvesSessionSelectorInTransaction = Assert<
  Equal<HasKey<TurnAdmissionInput, "session">, true>
>;
type _TurnAdmissionRejectsPreResolvedSessionId = Assert<
  Equal<HasKey<TurnAdmissionInput, "sessionId">, false>
>;

type ForwardingResult = Awaited<
  ReturnType<InferenceForwardingUnitOfWork["markReservationForwarding"]>
>["authorizationResult"];
type AuthorizedForwardingResult = Extract<
  ForwardingResult,
  { readonly authorized: true }
>;
type _ForwardingReturnsBoundInvocation = Assert<
  Equal<
    AuthorizedForwardingResult["invocation"] extends BoundProviderInvocation
      ? true
      : false,
    true
  >
>;
type SendStartedForwardingResult = Extract<
  Awaited<
    ReturnType<
      InferenceForwardingUnitOfWork["consumeReadyForwardingAttempt"]
    >
  >,
  { readonly status: "send-started" }
>;
type _ForwardingCasReturnsDistinctSendStartedInvocation = Assert<
  Equal<
    SendStartedForwardingResult["invocation"] extends SendStartedProviderInvocation
      ? true
      : false,
    true
  >
>;
type _ReadyInvocationCannotReachTransport = Assert<
  Equal<
    Parameters<BrokeredInferenceTransportBridge["invoke"]>,
    [invocation: SendStartedProviderInvocation]
  >
>;
type _ReadyAndSendStartedInvocationsAreNotInterchangeable = Assert<
  Equal<
    BoundProviderInvocation extends SendStartedProviderInvocation ? true : false,
    false
  >
>;
type _BrokerRecoveryHasConservativeUnknownClosure = Assert<
  Equal<
    HasKey<
      InferenceForwardingUnitOfWork,
      "recordInterruptedForwardingOutcomeUnknown"
    >,
    true
  >
>;
type _ProviderBridgeReportsDuplicateReplay = Assert<
  Equal<
    Awaited<
      ReturnType<BrokeredInferenceTransportBridge["invoke"]>
    >["status"],
    "started" | "duplicate-rejected"
  >
>;

type ResolvedInteraction = Extract<
  Awaited<
    ReturnType<
      InteractionResolutionUnitOfWork["resolveInteractionAndAuthorizeDriverResponse"]
    >
  >,
  { readonly status: "resolved-running" | "resolved-cancelling" }
>;
type _ResolutionDoesNotReturnReusableRawDriverResponse = Assert<
  Equal<HasKey<ResolvedInteraction, "driverResponse">, false>
>;
type _ResolvedRunningTransitionIsAtomic = Assert<
  Equal<
    Extract<
      ResolvedInteraction,
      { readonly status: "resolved-running" }
    >["runtime"]["state"]["status"],
    "running"
  >
>;
type _ResolvedCancellingTransitionIsAtomic = Assert<
  Equal<
    Extract<
      ResolvedInteraction,
      { readonly status: "resolved-cancelling" }
    >["runtime"]["state"]["status"],
    "cancelling"
  >
>;
type ConsumedInteractionResponse = Extract<
  Awaited<
    ReturnType<
      InteractionResolutionUnitOfWork["consumeDriverResponseAuthorization"]
    >
  >,
  { readonly status: "send-started" }
>["response"];
type _InteractionResponseCasReturnsSendStartedEvidence = Assert<
  Equal<
    ConsumedInteractionResponse extends SendStartedAgentInteractionResponse
      ? true
      : false,
    true
  >
>;
type _DriverRejectsRawInteractionResponses = Assert<
  Equal<
    Parameters<AgentTurnRun["respondToInteraction"]>,
    [response: SendStartedAgentInteractionResponse]
  >
>;
type _DriverRejectsDuplicateInteractionResponseDispatch = Assert<
  Equal<
    Awaited<ReturnType<AgentTurnRun["respondToInteraction"]>>["kind"],
    "delivered" | "outcome-unknown" | "duplicate-rejected"
  >
>;
type _InteractionRecoveryHasConservativeUnknownClosure = Assert<
  Equal<
    HasKey<
      InteractionResolutionUnitOfWork,
      "recordInterruptedDriverResponseOutcomeUnknown"
    >,
    true
  >
>;
type _InteractionRecoveryCanReauthorizeUnsentReadyResponse = Assert<
  Equal<
    HasKey<
      InteractionResolutionUnitOfWork,
      "reauthorizeRecoveredReadyDriverResponse"
    >,
    true
  >
>;

type DeliveryOutcomeInput = Parameters<
  DeliveryAttemptUnitOfWork["recordDeliveryAttemptOutcome"]
>[0]["outcome"];
type _DeliveryTransportCannotAuthorSuppression = Assert<
  Equal<"suppressed" extends DeliveryOutcomeInput["status"] ? true : false, false>
>;
type _DeliveryTransportCannotAuthorEndTime = Assert<
  Equal<HasKey<DeliveryOutcomeInput, "endedAt">, false>
>;
type _DeliveryTransportCannotAuthorRetrySchedule = Assert<
  Equal<HasKey<DeliveryOutcomeInput, "nextAttemptAt">, false>
>;

type _BootstrapPublishesStableWorkspaceIdentity = Assert<
  Equal<HasKey<BootstrapPublicationRecords, "workspace">, true>
>;
type _BootstrapPublishesStableProfileIdentity = Assert<
  Equal<HasKey<BootstrapPublicationRecords, "agentProfile">, true>
>;
type _StableWorkspaceHasNormalizedReference = Assert<
  Equal<HasKey<WorkspaceResourceIdentity, "reference">, true>
>;
type _StableProfileHasNormalizedReference = Assert<
  Equal<HasKey<AgentProfileResourceIdentity, "reference">, true>
>;
type _BootstrapPublishesStablePolicyIdentities = Assert<
  Equal<
    HasKey<BootstrapPublicationRecords, "executionPolicy"> &
      HasKey<BootstrapPublicationRecords, "turnPolicy">,
    true
  >
>;

type _RecoveryLoadsWorkerLeaseStates = Assert<
  Equal<HasKey<StartupRecoveryWork, "workerLeases">, true>
>;
type _RecoveryLoadsCredentialLeaseStates = Assert<
  Equal<HasKey<StartupRecoveryWork, "credentialLeases">, true>
>;
type _RecoveryLoadsResumeHandleStates = Assert<
  Equal<HasKey<StartupRecoveryWork, "resumeHandles">, true>
>;
type _RecoveryLoadsSandboxFenceStates = Assert<
  Equal<HasKey<StartupRecoveryWork, "sandboxRecovery">, true>
>;
type _RecoveryLoadsInteractionResponseDispatches = Assert<
  Equal<HasKey<StartupRecoveryWork, "interactionResponseDispatches">, true>
>;
type _RecoveryLoadsActiveDeliveryAttemptIds = Assert<
  Equal<
    IsNever<
      Extract<
        StartupRecoveryWork["unfinishedDeliveries"][number],
        { readonly state: "in-progress" }
      >["deliveryAttemptId"]
    >,
    false
  >
>;
type _DeliveryRecoveryHasInterruptedAttemptClosure = Assert<
  Equal<
    HasKey<DeliveryAttemptUnitOfWork, "recoverInterruptedDeliveryAttempt">,
    true
  >
>;
type _RecoveryIncludesReadyInteractionResponseDispatch = Assert<
  Equal<
    IsNever<
      Extract<
        StartupRecoveryWork["interactionResponseDispatches"][number],
        { readonly state: { readonly status: "ready" } }
      >
    >,
    false
  >
>;
type _RecoveryIncludesCompletedUnsettledInference = Assert<
  Equal<
    IsNever<
      Extract<
        StartupRecoveryWork["inference"][number],
        { readonly state: "send-completed" }
      >
    >,
    false
  >
>;

type SubmittedProtocolOutcome = Extract<
  ProtocolPromptSubmissionOutcome,
  { readonly kind: "submitted" }
>;
type _SubmittedProtocolCannotReturnRetry = Assert<
  Equal<
    ProtocolSubmissionResultFor<SubmittedProtocolOutcome>["status"],
    "submitted"
  >
>;
type AcceptedPromptOutcome = Extract<
  AgentPromptAcceptanceOutcome,
  { readonly kind: "accepted" }
>;
type _AcceptedPromptCannotReturnRejection = Assert<
  Equal<PromptAcceptanceResultFor<AcceptedPromptOutcome>["status"], "accepted">
>;

type BlockSessionRecoveryDecision = Extract<
  StartupRecoveryDecision,
  { readonly kind: "block-session" }
>;
type _BlockSessionDecisionCannotReturnTurnRetry = Assert<
  Equal<
    StartupRecoveryResultFor<BlockSessionRecoveryDecision>["status"],
    "session-blocked"
  >
>;

type ReconciledRecoveryAt<
  Status extends
    | "submitted-unconfirmed"
    | "accepted"
    | "running"
    | "waiting-for-approval"
    | "waiting-for-input"
    | "cancelling",
> = Extract<
  TurnRecoveryRecord,
  {
    readonly outcome: "reconciled-live";
    readonly observedState: { readonly status: Status };
  }
>;
type ReconciledRuntimeStatusFor<
  Recovery extends TurnRecoveryRecord,
> = StartupRecoveryResultFor<{
  readonly kind: "turn-recovery";
  readonly recovery: Recovery;
}>["runtime"]["state"]["status"];
type _ReconciledSubmittedRuntimeIsExact = Assert<
  Equal<
    ReconciledRuntimeStatusFor<
      ReconciledRecoveryAt<"submitted-unconfirmed">
    >,
    "submitted-unconfirmed"
  >
>;
type _ReconciledAcceptedRuntimeIsExact = Assert<
  Equal<ReconciledRuntimeStatusFor<ReconciledRecoveryAt<"accepted">>, "accepted">
>;
type _ReconciledRunningRuntimeIsExact = Assert<
  Equal<ReconciledRuntimeStatusFor<ReconciledRecoveryAt<"running">>, "running">
>;
type _ReconciledApprovalWaitRuntimeIsExact = Assert<
  Equal<
    ReconciledRuntimeStatusFor<ReconciledRecoveryAt<"waiting-for-approval">>,
    "waiting-for-approval"
  >
>;
type _ReconciledInputWaitRuntimeIsExact = Assert<
  Equal<
    ReconciledRuntimeStatusFor<ReconciledRecoveryAt<"waiting-for-input">>,
    "waiting-for-input"
  >
>;
type _ReconciledCancellingRuntimeIsExact = Assert<
  Equal<
    ReconciledRuntimeStatusFor<ReconciledRecoveryAt<"cancelling">>,
    "cancelling"
  >
>;

type ObservedSettlementResult = InferenceSettlementResultFor<{
  readonly kind: "observed-usage";
  readonly observation: never;
}>;
type _ObservedUsageCannotReturnChargeAudit = Assert<
  Equal<
    ObservedSettlementResult["auditEvents"][number]["action"],
    "inference-settled"
  >
>;
type InferenceReleaseResult = Awaited<
  ReturnType<
    InferenceSettlementUnitOfWork["releaseProvenUnforwardedReservation"]
  >
>;
type _InferenceReleaseFailureHasDenialAudit = Assert<
  Equal<
    Extract<
      InferenceReleaseResult,
      { readonly status: "not-releasable" }
    >["auditEvents"][number]["action"],
    "inference-release-denied"
  >
>;

type AttachmentIdInput = PreparedAttachmentAdmission["attachment"]["id"];
type _PreparedAttachmentRetainsTrustedId = Assert<
  Equal<AttachmentIdInput extends string ? true : false, true>
>;

declare const idSource: IdSource;
type _IdSourceAllocatesExactToolInvocation = Assert<
  Equal<
    ReturnType<typeof idSource.next<"ToolInvocation">>,
    ToolInvocationId
  >
>;

/** Compile-only guards for V2-001A's deliberately secret-free durable records. */

import type {
  Attachment,
  AuditEnvelope,
  HitchV2ServiceSchemaIdentity,
  InferenceForwardingAttempt,
  PrivateBlobReference,
  TurnRecoveryRecord,
  TurnResponseDelivery,
  TurnResponseDeliveryState,
} from "./records.js";
import type { AuditActorRef } from "./identity-access.js";
import type {
  BoundProviderInvocation,
  BrokeredInferenceTransportBridge,
  InferenceControlAuthorizationBoundary,
  PreparedProviderInferenceRequest,
  ProviderRequestAuthorizationContext,
  ProviderReservationAuthorization,
} from "./provider-broker.js";
import type { InferenceRequestReservationState } from "./turn.js";

type Assert<Condition extends true> = Condition;
type HasKey<Record, Key extends PropertyKey> = Key extends keyof Record ? true : false;
type HasAnyKey<Record, Keys extends PropertyKey> =
  Extract<Keys, keyof Record> extends never ? false : true;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type _AttachmentHasNoHostSource = Assert<
  Equal<
    HasAnyKey<
      Attachment,
      "canonicalHostPath" | "hostPath" | "sourcePath" | "sourceFilename"
    >,
    false
  >
>;
type _PrivateBlobHasNoStorageLocator = Assert<
  Equal<
    HasAnyKey<PrivateBlobReference, "path" | "hostPath" | "storageLocator">,
    false
  >
>;
type _AuditHasNoFreeformPayload = Assert<
  Equal<
    HasAnyKey<
      AuditEnvelope,
      "details" | "detailsJson" | "prompt" | "rawPayload" | "reasoning"
    >,
    false
  >
>;
type _AuditHasNoGenericCorrelationBag = Assert<
  HasKey<AuditEnvelope, "correlation"> extends false ? true : false
>;
type _ForwardingAttemptReferencesCanonicalReservation = Assert<
  HasKey<InferenceForwardingAttempt, "reservationId"> extends true ? true : false
>;
type _ForwardingAttemptDoesNotDuplicateRequest = Assert<
  HasKey<InferenceForwardingAttempt, "request"> extends false ? true : false
>;
type _DeliveryDoesNotContainResponseBody = Assert<
  HasKey<TurnResponseDelivery, "response"> extends false ? true : false
>;
type _DeliveryPinsRetryBound = Assert<
  Equal<HasKey<TurnResponseDelivery, "maximumAttempts">, true>
>;

type _SchemaVersionIsExact = Assert<
  Equal<HitchV2ServiceSchemaIdentity["schemaVersion"], 1>
>;
type _ApplicationIdIsExact = Assert<
  Equal<HitchV2ServiceSchemaIdentity["sqliteApplicationId"], 0x48495432>
>;

type ForwardingReservation = Extract<
  InferenceRequestReservationState,
  { readonly status: "forwarding" }
>;
type AuthorizedReservation = Extract<
  InferenceRequestReservationState,
  { readonly status: "authorized" }
>;
type _ForwardingReservationRequiresAttempt = Assert<
  Equal<HasKey<ForwardingReservation, "forwardingAttemptId">, true>
>;
type _AuthorizedReservationForbidsAttempt = Assert<
  Equal<HasKey<AuthorizedReservation, "forwardingAttemptId">, false>
>;
type _ForwardingWithoutAttemptIsRejected = Assert<
  {
    readonly status: "forwarding";
    readonly forwardingAt: ForwardingReservation["forwardingAt"];
  } extends InferenceRequestReservationState
    ? false
    : true
>;

type RetryableDelivery = Extract<
  TurnResponseDeliveryState,
  { readonly status: "retryable-failure" }
>;
type _RetryableDeliveryRetainsAttempt = Assert<
  Equal<HasKey<RetryableDelivery, "attemptId">, true>
>;
type _RetryableDeliveryHasNextAttemptTime = Assert<
  Equal<HasKey<RetryableDelivery, "nextAttemptAt">, true>
>;
type _RetryableDeliveryWithoutAttemptIsRejected = Assert<
  Omit<RetryableDelivery, "attemptId"> extends TurnResponseDeliveryState
    ? false
    : true
>;

type ForwardingAudit = Extract<
  AuditEnvelope,
  { readonly action: "inference-forwarding-recorded" }
>;
type _ForwardingAuditRequiresReservation = Assert<
  Equal<HasKey<ForwardingAudit, "reservationId">, true>
>;
type _ForwardingAuditRequiresAttempt = Assert<
  Equal<HasKey<ForwardingAudit, "forwardingAttemptId">, true>
>;
type _ForwardingAuditRequiresCredentialLease = Assert<
  Equal<HasKey<ForwardingAudit, "credentialLeaseId">, true>
>;
type _ForwardingAuditRequiresSession = Assert<
  Equal<HasKey<ForwardingAudit, "sessionId">, true>
>;
type _ForwardingAuditWithoutAttemptIsRejected = Assert<
  Omit<ForwardingAudit, "forwardingAttemptId"> extends AuditEnvelope
    ? false
    : true
>;
type SendStartedAudit = Extract<
  AuditEnvelope,
  { readonly action: "inference-send-started" }
>;
type _SendStartedAuditCarriesReplayBoundary = Assert<
  Equal<
    HasKey<SendStartedAudit, "forwardingAttemptId"> extends true
      ? HasKey<SendStartedAudit, "reservationId">
      : false,
    true
  >
>;
type ChargedAudit = Extract<
  AuditEnvelope,
  { readonly action: "inference-charged-reservation" }
>;
type _ChargedAuditRequiresAttempt = Assert<
  Equal<HasKey<ChargedAudit, "forwardingAttemptId">, true>
>;
type ReleasedAudit = Extract<
  AuditEnvelope,
  { readonly action: "inference-released" }
>;
type _ReleasedAuditForbidsAttempt = Assert<
  Equal<HasKey<ReleasedAudit, "forwardingAttemptId">, false>
>;

type SystemAuditActor = Extract<AuditActorRef, { readonly kind: "system" }>;
type _SystemAuditComponentIsClosed = Assert<
  Equal<string extends SystemAuditActor["component"] ? true : false, false>
>;

type DispatchRetryRecovery = Extract<
  TurnRecoveryRecord,
  {
    readonly outcome: "retry-authorized";
    readonly previousLifecycleStatus: "dispatching";
  }
>;
type _DispatchRetryHasExactProof = Assert<
  Equal<DispatchRetryRecovery["proof"], "dispatch-not-started">
>;
type UnknownRecovery = Extract<
  TurnRecoveryRecord,
  { readonly outcome: "terminal-unknown" }
>;
type _UnknownRecoveryCannotFollowDispatching = Assert<
  Equal<
    "dispatching" extends UnknownRecovery["previousLifecycleStatus"]
      ? true
      : false,
    false
  >
>;
type RecoveryCommon = Pick<
  TurnRecoveryRecord,
  | "sessionId"
  | "turnId"
  | "attemptId"
  | "workerLeaseId"
  | "workerFencingToken"
  | "recoveredAt"
>;
type _RetryAfterRunningIsRejected = Assert<
  RecoveryCommon & {
    readonly outcome: "retry-authorized";
    readonly previousLifecycleStatus: "running";
    readonly proof: "driver-proved-no-protocol-byte";
  } extends TurnRecoveryRecord
    ? false
    : true
>;
type _RunningCannotReconcileBackward = Assert<
  RecoveryCommon & {
    readonly outcome: "reconciled-live";
    readonly previousLifecycleStatus: "running";
    readonly observedState: { readonly status: "submitted-unconfirmed" };
  } extends TurnRecoveryRecord
    ? false
    : true
>;
type _WaitingCannotLoseInteractionState = Assert<
  RecoveryCommon & {
    readonly outcome: "reconciled-live";
    readonly previousLifecycleStatus: "waiting-for-approval";
    readonly observedState: {
      readonly status: "running";
      readonly acceptanceEvidence: never;
    };
  } extends TurnRecoveryRecord
    ? false
    : true
>;

type ForwardingAttemptState = InferenceForwardingAttempt["state"];
type ReadyForSend = Extract<
  ForwardingAttemptState,
  { readonly status: "ready-for-one-send" }
>;
type StartedSend = Extract<
  ForwardingAttemptState,
  { readonly status: "send-started" }
>;
type _ReadyStateHasNoStartTime = Assert<
  Equal<HasKey<ReadyForSend, "startedAt">, false>
>;
type _StartedStateRequiresStartTime = Assert<
  Equal<HasKey<StartedSend, "startedAt">, true>
>;

type _BridgeAcceptsOnlyBoundInvocation = Assert<
  Equal<
    Parameters<BrokeredInferenceTransportBridge["invoke"]>,
    [invocation: BoundProviderInvocation]
  >
>;
type _ForwardingBoundaryBindsRequestAndReservation = Assert<
  Equal<
    Parameters<InferenceControlAuthorizationBoundary["markForwarding"]>,
    [
      prepared: PreparedProviderInferenceRequest,
      reservation: ProviderReservationAuthorization,
    ]
  >
>;
type _ReservationBoundaryAcceptsBoundEstimate = Assert<
  Equal<
    Parameters<InferenceControlAuthorizationBoundary["reserveRequest"]>,
    [
      prepared: PreparedProviderInferenceRequest,
      authorization: ProviderRequestAuthorizationContext,
    ]
  >
>;

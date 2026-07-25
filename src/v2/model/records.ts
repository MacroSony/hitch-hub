/**
 * Compile-only durable records not owned by a particular runtime adapter.
 *
 * These records deliberately describe metadata, protected references, and
 * allowlisted outcomes. They never carry a host path, broker capability,
 * upstream credential, raw prompt, raw reasoning, or raw tool I/O.
 */

import type {
  AccessGrantId,
  AgentDispatchAttemptId,
  AgentDriverId,
  AgentResumeHandleId,
  AttachmentId,
  AuditEnvelopeId,
  AuthenticationRequestId,
  CredentialLeaseId,
  InferenceForwardingAttemptId,
  InferenceRequestReservationId,
  InstallationId,
  IdentityBindingId,
  IntegrityDigest,
  IsoTimestamp,
  PrivateBlobId,
  PrincipalId,
  SessionEndpointBindingId,
  SessionId,
  SessionSpecId,
  TurnId,
  TurnInteractionId,
  TurnMessageId,
  TurnResponseDeliveryAttemptId,
  TurnResponseDeliveryId,
  TurnTerminalResponseId,
  WorkerLeaseId,
} from "./primitives.js";
import type {
  AuditActorRef,
  AuthenticationAssurance,
} from "./identity-access.js";
import type {
  PromptAcceptanceEvidence,
  TurnContentBlock,
  TurnResult,
} from "./turn.js";

/**
 * Explicit v2 service and schema marker. Root opening must require exact
 * equality for every identity field; it must never infer or migrate a
 * legacy/unknown root.
 */
export interface HitchV2ServiceSchemaIdentity {
  readonly service: "hitch";
  readonly generation: "v2";
  readonly schemaVersion: 1;
  /** ASCII `HIT2`; root opening requires exact equality. */
  readonly sqliteApplicationId: 0x48495432;
  readonly schemaDigest: IntegrityDigest;
}

/**
 * Mandatory live limits. They may narrow an immutable SessionSpec/Turn policy
 * at admission, dispatch, and privileged boundaries, but never broaden it.
 */
export interface InstallationHardCeilings {
  readonly maximumQueuedTurnsPerSession: number;
  readonly maximumActiveWorkMs: number;
  readonly maximumInteractionWaitMs: number;
  readonly maximumBeforeAcceptanceAttempts: number;
  readonly maximumProviderRequestsPerTurn: number;
  readonly maximumTotalInferenceTokensPerTurn: number;
  readonly maximumOutputTokensPerInferenceRequest: number;
  readonly maximumImageBytesPerAttachment: number;
  readonly maximumBrokerRequestBytes: number;
  readonly maximumConcurrentBrokerRequests: number;
  readonly maximumMemoryBytes: number;
  readonly maximumProcesses: number;
  readonly maximumTemporaryStorageBytes: number;
  readonly maximumAgentOutputBytes: number;
}

/** One immutable installation record with mutable current hard ceilings. */
export interface Installation {
  readonly id: InstallationId;
  readonly serviceSchema: HitchV2ServiceSchemaIdentity;
  readonly hardCeilings: InstallationHardCeilings;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Opaque Hitch-owned private storage reference. It intentionally does not
 * expose an absolute path, filename, encryption key, or storage locator.
 */
export interface PrivateBlobReference {
  readonly storage: "installation-private";
  readonly blobId: PrivateBlobId;
}

/** A private reference whose bytes must match an independently retained digest. */
export interface ProtectedBlobReference extends PrivateBlobReference {
  readonly integrityDigest: IntegrityDigest;
}

/** Immutable first-slice image attachment copied into Hitch-owned storage. */
export interface Attachment {
  readonly id: AttachmentId;
  readonly installationId: InstallationId;
  readonly mediaType: "image";
  readonly mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  readonly byteLength: number;
  readonly integrityDigest: IntegrityDigest;
  readonly blob: PrivateBlobReference;
  /** Provenance is domain correlation only; the caller's source path is absent. */
  readonly admittedFrom: {
    readonly kind: "local-cli";
    readonly authenticationRequestId: AuthenticationRequestId;
  };
  readonly createdAt: IsoTimestamp;
}

/**
 * Retained trusted evidence for one authentication decision. The local socket
 * adapter records verified endpoint security, not raw peer credentials, socket
 * paths, supplied principal IDs, or reusable authentication material.
 */
export type AuthenticationRequestEvidence = {
  readonly kind: "local-peer-owner-socket";
  readonly socketSecurity: "service-owned-0700-parent-and-0600-socket";
};

export type AuthenticationRequestOutcome =
  | {
      readonly status: "authenticated";
      readonly principalId: PrincipalId;
      readonly identityBindingId: IdentityBindingId;
      readonly assurance: AuthenticationAssurance;
    }
  | {
      readonly status: "rejected";
      readonly reason: "unknown-binding" | "binding-revoked" | "principal-disabled";
    };

export interface AuthenticationRequest {
  readonly id: AuthenticationRequestId;
  readonly installationId: InstallationId;
  readonly evidence: AuthenticationRequestEvidence;
  readonly outcome: AuthenticationRequestOutcome;
  readonly decidedAt: IsoTimestamp;
}

/** One finalized assistant message included in a terminal response projection. */
export interface FinalizedTurnResponseMessage {
  readonly messageId: TurnMessageId;
  readonly sequence: number;
  readonly content: readonly TurnContentBlock[];
}

/**
 * Immutable query/delivery projection built with the terminal Turn result.
 * It is authoritative independently of any local-client delivery attempt.
 */
export interface TurnTerminalResponse {
  readonly id: TurnTerminalResponseId;
  readonly turnId: TurnId;
  readonly result: TurnResult;
  readonly partialOutputAvailable: boolean;
  readonly finalizedMessages: readonly FinalizedTurnResponseMessage[];
  readonly finalizedAt: IsoTimestamp;
}

export type TurnResponseDeliveryAttemptState =
  | { readonly status: "in-progress" }
  | {
      readonly status: "delivered";
      readonly endedAt: IsoTimestamp;
    }
  | {
      readonly status: "retryable-failure";
      readonly endedAt: IsoTimestamp;
      readonly reason:
        | "client-disconnected"
        | "transport-unavailable"
        | "send-failed";
      readonly nextAttemptAt: IsoTimestamp;
    }
  | {
      readonly status: "failed";
      readonly endedAt: IsoTimestamp;
      readonly reason: "maximum-attempts-reached" | "delivery-deadline-elapsed";
    }
  | {
      readonly status: "suppressed";
      readonly endedAt: IsoTimestamp;
      readonly reason: "binding-inactive" | "recipient-no-longer-authorized";
    };

/**
 * One numbered, independently retained delivery attempt. A repository creates
 * it before send-time reauthorization and never reuses its ID or number.
 */
export interface TurnResponseDeliveryAttempt {
  readonly id: TurnResponseDeliveryAttemptId;
  readonly deliveryId: TurnResponseDeliveryId;
  readonly attemptNumber: number;
  readonly startedAt: IsoTimestamp;
  readonly state: TurnResponseDeliveryAttemptState;
}

export type TurnResponseDeliveryState =
  | { readonly status: "pending" }
  | {
      readonly status: "delivering";
      readonly attemptId: TurnResponseDeliveryAttemptId;
      readonly startedAt: IsoTimestamp;
    }
  | {
      readonly status: "delivered";
      readonly attemptId: TurnResponseDeliveryAttemptId;
      readonly deliveredAt: IsoTimestamp;
    }
  | {
      readonly status: "retryable-failure";
      readonly attemptId: TurnResponseDeliveryAttemptId;
      readonly failedAt: IsoTimestamp;
      readonly reason:
        | "client-disconnected"
        | "transport-unavailable"
        | "send-failed";
      readonly nextAttemptAt: IsoTimestamp;
    }
  | {
      readonly status: "failed";
      readonly attemptId: TurnResponseDeliveryAttemptId;
      readonly failedAt: IsoTimestamp;
      readonly reason: "maximum-attempts-reached" | "delivery-deadline-elapsed";
    }
  | {
      readonly status: "suppressed";
      readonly attemptId: TurnResponseDeliveryAttemptId;
      readonly suppressedAt: IsoTimestamp;
      readonly reason: "binding-inactive" | "recipient-no-longer-authorized";
    }
  | {
      readonly status: "expired";
      readonly expiredAt: IsoTimestamp;
      readonly reason: "delivery-deadline-elapsed";
    };

/**
 * Independent local response-delivery lifecycle. Delivery reauthorizes the
 * binding and recipient when it attempts a send; no state here can mutate the
 * referenced immutable terminal response.
 */
export interface TurnResponseDelivery {
  readonly id: TurnResponseDeliveryId;
  readonly terminalResponseId: TurnTerminalResponseId;
  readonly turnId: TurnId;
  readonly endpointBindingId: SessionEndpointBindingId;
  readonly recipientPrincipalId: PrincipalId;
  readonly deadlineAt: IsoTimestamp;
  readonly maximumAttempts: number;
  readonly attemptCount: number;
  readonly state: TurnResponseDeliveryState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Closed audit correlations. Every action carries exactly the domain IDs
 * required to interpret it; there is no generic optional correlation bag.
 */
export type AuditEvent =
  | { readonly action: "installation-published" }
  | {
      readonly action: "authentication-recorded";
      readonly authenticationRequestId: AuthenticationRequestId;
    }
  | {
      readonly action: "identity-binding-state-changed";
      readonly identityBindingId: IdentityBindingId;
    }
  | {
      readonly action: "configuration-grant-state-changed";
      readonly accessGrantId: AccessGrantId;
    }
  | {
      readonly action: "session-created";
      readonly sessionId: SessionId;
      readonly sessionSpecId: SessionSpecId;
      readonly endpointBindingId: SessionEndpointBindingId;
    }
  | {
      readonly action: "attachment-admitted";
      readonly attachmentId: AttachmentId;
      readonly authenticationRequestId: AuthenticationRequestId;
    }
  | {
      readonly action: "turn-admitted";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }
  | {
      readonly action: "turn-state-transitioned";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }
  | {
      readonly action: "turn-dispatched";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly attemptId: AgentDispatchAttemptId;
    }
  | {
      readonly action: "turn-recovery-recorded";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly attemptId: AgentDispatchAttemptId;
      readonly workerLeaseId: WorkerLeaseId;
    }
  | {
      readonly action: "turn-message-finalized";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly messageId: TurnMessageId;
    }
  | {
      readonly action: "interaction-recorded";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly interactionId: TurnInteractionId;
    }
  | {
      readonly action: "interaction-resolved";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly interactionId: TurnInteractionId;
    }
  | {
      readonly action: "worker-lease-state-changed";
      readonly sessionId: SessionId;
      readonly workerLeaseId: WorkerLeaseId;
    }
  | {
      readonly action: "credential-lease-state-changed";
      readonly sessionId: SessionId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
    }
  | {
      readonly action: "resume-handle-state-changed";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly resumeHandleId: AgentResumeHandleId;
    }
  | {
      readonly action: "inference-reserved";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
    }
  | {
      readonly action: "inference-forwarding-recorded";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
      readonly forwardingAttemptId: InferenceForwardingAttemptId;
    }
  | {
      readonly action: "inference-send-started";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
      readonly forwardingAttemptId: InferenceForwardingAttemptId;
    }
  | {
      readonly action: "inference-send-completed";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
      readonly forwardingAttemptId: InferenceForwardingAttemptId;
    }
  | {
      readonly action: "inference-send-outcome-unknown";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
      readonly forwardingAttemptId: InferenceForwardingAttemptId;
    }
  | {
      readonly action: "inference-settled";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
      readonly forwardingAttemptId: InferenceForwardingAttemptId;
    }
  | {
      readonly action: "inference-charged-reservation";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
      readonly forwardingAttemptId: InferenceForwardingAttemptId;
    }
  | {
      readonly action: "inference-released";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly workerLeaseId: WorkerLeaseId;
      readonly credentialLeaseId: CredentialLeaseId;
      readonly reservationId: InferenceRequestReservationId;
    }
  | {
      readonly action: "turn-terminalized";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
    }
  | {
      readonly action: "response-delivery-created";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly deliveryId: TurnResponseDeliveryId;
    }
  | {
      readonly action: "response-delivery-attempt-recorded";
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly deliveryId: TurnResponseDeliveryId;
      readonly deliveryAttemptId: TurnResponseDeliveryAttemptId;
    };

export type AuditAction = AuditEvent["action"];

/**
 * An allowlisted operational audit envelope. It contains domain IDs and fixed
 * outcome codes only, never prompts, secrets, host paths, reasoning, or raw
 * tool payloads.
 */
export type AuditEnvelope = {
  readonly id: AuditEnvelopeId;
  readonly installationId: InstallationId;
  readonly actor: AuditActorRef;
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly occurredAt: IsoTimestamp;
} & AuditEvent;

/**
 * Protected metadata for a driver-issued exact recovery handle. The protected
 * value itself is stored behind an opaque private reference and is never sent
 * to a connector, persisted in an audit envelope, or exposed to an agent.
 */
export interface AgentResumeHandle {
  readonly id: AgentResumeHandleId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly attemptId: AgentDispatchAttemptId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly driverId: AgentDriverId;
  readonly protectedHandle: ProtectedBlobReference;
  readonly expiresAt: IsoTimestamp;
  readonly state:
    | { readonly status: "active" }
    | {
        readonly status: "retired";
        readonly retiredAt: IsoTimestamp;
        readonly reason:
          | "consumed"
          | "expired"
          | "lease-ended"
          | "replaced"
          | "recovery-terminal";
      };
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

type PossiblySubmittedLifecycleStatus =
  | "submission-armed"
  | "submitted-unconfirmed"
  | "accepted"
  | "running"
  | "waiting-for-approval"
  | "waiting-for-input"
  | "cancelling";

type TurnRecoveryRecordBase = {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly attemptId: AgentDispatchAttemptId;
  /** The stale or lost lease whose work is being reconciled. */
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly recoveredAt: IsoTimestamp;
};

/** Exact, conservative conclusion recorded for one dispatch attempt. */
export type TurnRecoveryRecord = TurnRecoveryRecordBase &
  (
    | {
        readonly outcome: "retry-authorized";
        readonly previousLifecycleStatus: "dispatching";
        readonly proof: "dispatch-not-started";
      }
    | {
        readonly outcome: "retry-authorized";
        readonly previousLifecycleStatus: "submission-armed";
        readonly proof: "driver-proved-no-protocol-byte";
      }
    | {
        readonly outcome: "resumed";
        readonly previousLifecycleStatus: PossiblySubmittedLifecycleStatus;
        readonly resumeHandleId: AgentResumeHandleId;
      }
    | {
        readonly outcome: "reconciled-live";
        readonly previousLifecycleStatus:
          | "submission-armed"
          | "submitted-unconfirmed";
        readonly observedState: { readonly status: "submitted-unconfirmed" };
      }
    | {
        readonly outcome: "reconciled-live";
        readonly previousLifecycleStatus:
          | "submission-armed"
          | "submitted-unconfirmed"
          | "accepted";
        readonly observedState: {
          readonly status: "accepted";
          readonly acceptanceEvidence: PromptAcceptanceEvidence;
        };
      }
    | {
        readonly outcome: "reconciled-live";
        readonly previousLifecycleStatus:
          | "submission-armed"
          | "submitted-unconfirmed"
          | "accepted"
          | "running";
        readonly observedState: {
          readonly status: "running";
          readonly acceptanceEvidence: PromptAcceptanceEvidence;
        };
      }
    | {
        readonly outcome: "reconciled-live";
        readonly previousLifecycleStatus: "waiting-for-approval";
        readonly observedState: {
          readonly status: "waiting-for-approval";
          readonly interactionId: TurnInteractionId;
        };
      }
    | {
        readonly outcome: "reconciled-live";
        readonly previousLifecycleStatus: "waiting-for-input";
        readonly observedState: {
          readonly status: "waiting-for-input";
          readonly interactionId: TurnInteractionId;
        };
      }
    | {
        readonly outcome: "reconciled-live";
        readonly previousLifecycleStatus: "cancelling";
        readonly observedState: { readonly status: "cancelling" };
      }
    | {
        readonly outcome: "reconciled-terminal";
        readonly previousLifecycleStatus: PossiblySubmittedLifecycleStatus;
        readonly result: TurnResult;
        readonly partialOutputAvailable: boolean;
      }
    | {
        readonly outcome: "terminal-unknown";
        readonly previousLifecycleStatus: PossiblySubmittedLifecycleStatus;
        readonly reason: "worker-lost-after-dispatch";
      }
  );

/**
 * Durable evidence of the one forwarding transition for one reservation.
 * The reservation is the sole durable owner of the normalized request tuple.
 * Before invocation, the bridge must compare-and-swap `ready-for-one-send` to
 * `send-started`; no other state permits native invocation or upstream I/O.
 */
export interface InferenceForwardingAttempt {
  readonly id: InferenceForwardingAttemptId;
  readonly reservationId: InferenceRequestReservationId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly createdAt: IsoTimestamp;
  readonly state:
    | { readonly status: "ready-for-one-send" }
    | {
        readonly status: "send-started";
        readonly startedAt: IsoTimestamp;
      }
    | {
        readonly status: "send-completed";
        readonly startedAt: IsoTimestamp;
        readonly completedAt: IsoTimestamp;
      }
    | {
        readonly status: "outcome-unknown";
        readonly startedAt: IsoTimestamp;
        readonly observedAt: IsoTimestamp;
        readonly reason: "broker-recovery" | "sidecar-disconnected";
      };
  readonly updatedAt: IsoTimestamp;
}

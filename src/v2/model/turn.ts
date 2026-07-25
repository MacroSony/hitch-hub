/**
 * Compile-only v2 turn and dispatch model.
 *
 * A Turn is Hitch's immutable, durable unit of requested work. Agent protocol
 * requests are runtime projections of a Turn and never replace its identity,
 * lifecycle, authorization, idempotency, or queue semantics.
 */

import type {
  AccessGrantId,
  AgentDispatchAttemptId,
  AgentDriverPermissionMediationId,
  AgentProtocolInteractionId,
  AgentProtocolInteractionOptionId,
  AgentProtocolMessageId,
  AgentProtocolPermissionOptionKind,
  AgentProtocolToolCallId,
  AttachmentId,
  AuthenticationRequestId,
  CredentialLeaseId,
  EndpointId,
  ExecutionPolicySnapshotId,
  IdentityBindingId,
  InferenceRequestReservationId,
  IsoTimestamp,
  JsonObject,
  OriginMessageId,
  PrincipalId,
  SandboxPath,
  SessionEndpointBindingId,
  SessionId,
  ToolInvocationId,
  TurnEventId,
  TurnId,
  TurnIdempotencyKey,
  TurnInputSnapshotId,
  TurnInteractionId,
  TurnInteractionOptionId,
  TurnInteractionResponseId,
  TurnMessageId,
  TurnPolicyId,
  TurnPolicySnapshotId,
  WorkerLeaseId,
  WorkspaceResourceId,
} from "./primitives.js";
import type { AuditActorRef, AuthenticatedPrincipal } from "./identity-access.js";
import type {
  ModelRef,
  TurnExecutionOptions,
  TurnReasoningSelection,
} from "./session.js";

export type TurnBusyBehavior = "reject" | "bounded-fifo";

export interface TurnAdmissionPolicy {
  readonly whenBusy: TurnBusyBehavior;
  readonly maxQueuedTurns: number;
}

export interface TurnTimingPolicy {
  /** Initial active agent-work budget before tool-based extensions. */
  readonly initialActiveWorkMs: number;
  /** Active-work time added by each distinct tool invocation. */
  readonly toolExtensionMs: number;
  /** Hard cap for the dynamically extended active-work budget. */
  readonly maximumActiveWorkMs: number;
  /** Deadline for resolving each approval or structured-input interaction. */
  readonly interactionWaitMs: number;
}

export interface TurnInteractionPolicy {
  readonly approval: "deny" | "policy-only" | "ask-authorized-approver";
  readonly onApprovalTimeout: "deny";
  readonly inputRequests: "deny" | "ask-originator";
  readonly onInputTimeout: "no-input";
}

export interface TurnRetryPolicy {
  /** Applies only while the driver can prove the prompt was not accepted. */
  readonly maximumBeforeAcceptanceAttempts: number;
  /** Replaying a possibly accepted prompt is never automatic. */
  readonly afterPossibleAcceptance: "never";
}

export interface TurnOutputPolicy {
  readonly progressDelivery: "none" | "checkpoints" | "stream";
  readonly checkpointIntervalMs: number;
  readonly maximumCheckpointCharacters: number;
  readonly persistFinalMessages: true;
  readonly persistRawReasoning: false;
  readonly persistRawToolInputOutput: false;
}

/**
 * Finite broker-enforced ceilings for one Turn in a brokered inference mode.
 * Runtime codecs require positive safe integers. Installation ceilings may
 * only narrow these values. Agent-native usage observations do not satisfy
 * these hard reservation guarantees.
 */
export interface TurnInferencePolicy {
  readonly maximumProviderRequests: number;
  readonly maximumTotalTokens: number;
  readonly maximumOutputTokensPerRequest: number;
}

/**
 * Append-only orchestration policy. Installation hard ceilings are revalidated
 * at admission, dispatch, and each privileged runtime boundary and may only
 * narrow this snapshot.
 */
export interface TurnPolicySnapshot {
  readonly id: TurnPolicySnapshotId;
  readonly policyId: TurnPolicyId;
  readonly revision: number;
  readonly admission: TurnAdmissionPolicy;
  readonly timing: TurnTimingPolicy;
  readonly interaction: TurnInteractionPolicy;
  readonly retry: TurnRetryPolicy;
  readonly inference: TurnInferencePolicy;
  readonly output: TurnOutputPolicy;
  readonly createdAt: IsoTimestamp;
}

export type TurnContentBlock =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "attachment";
      readonly attachmentId: AttachmentId;
      readonly mediaType: "image" | "audio" | "file";
      readonly mimeType: string;
      readonly displayName?: string;
    }
  | {
      /**
       * Validated path inside an authorized workspace resource. It is never a
       * caller-supplied host path.
       */
      readonly kind: "workspace-resource-link";
      readonly resourceId: WorkspaceResourceId;
      readonly sandboxPath: SandboxPath;
      readonly mimeType?: string;
    };

/** Exact immutable private-endpoint prompt admitted for a turn. */
export interface TurnInputSnapshot {
  readonly id: TurnInputSnapshotId;
  readonly triggeringContent: readonly TurnContentBlock[];
  readonly createdAt: IsoTimestamp;
}

export interface TurnRequester {
  readonly principalId: PrincipalId;
  readonly identityBindingId: IdentityBindingId;
  readonly authenticationRequestId: AuthenticationRequestId;
}

export interface EndpointTurnOrigin {
  readonly kind: "endpoint";
  readonly endpointId: EndpointId;
  readonly endpointBindingId: SessionEndpointBindingId;
  readonly originMessageId: OriginMessageId;
}

/**
 * Initial structured turns originate at an endpoint. Future schedules and
 * service triggers must add explicit authenticated origin variants.
 */
export type TurnOrigin = EndpointTurnOrigin;

/**
 * Immutable accepted work. The idempotency tuple is scoped by the origin
 * endpoint and key.
 */
export interface Turn {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly requester: TurnRequester;
  readonly origin: TurnOrigin;
  readonly inputSnapshotId: TurnInputSnapshotId;
  readonly turnPolicySnapshotId: TurnPolicySnapshotId;
  readonly execution: TurnExecutionOptions;
  readonly idempotencyKey: TurnIdempotencyKey;
  readonly createdAt: IsoTimestamp;
}

/**
 * Immutable actual inference behavior for a Turn. Resolved-model Turns record
 * it at admission. Agent-selected Turns record it atomically with the first
 * broker request reservation. Exactly one resolution may exist per Turn.
 *
 * `agent-default` means the provider request contains no reasoning override.
 */
export interface TurnInferenceResolution {
  readonly turnId: TurnId;
  readonly model: ModelRef;
  readonly reasoning: TurnReasoningSelection;
  readonly resolvedBy: "hitch" | "agent";
  readonly resolvedAt: IsoTimestamp;
}

export interface InferenceTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type InferenceRequestReservationState =
  | { readonly status: "authorized" }
  | {
      /**
       * Persisted before network I/O. The upstream may have accepted the
       * request, so recovery must never release this reservation as unspent.
       */
      readonly status: "forwarding";
      readonly forwardingAt: IsoTimestamp;
    }
  | {
      readonly status: "settled";
      readonly settledAt: IsoTimestamp;
      readonly usage: InferenceTokenUsage;
    }
  | {
      /** Usage was unavailable after forwarding; charge the full reservation. */
      readonly status: "charged-reservation";
      readonly endedAt: IsoTimestamp;
      readonly reason:
        | "usage-unavailable"
        | "broker-recovery"
        | "cancelled-after-forward";
    }
  | {
      /** Allowed only when the broker proves no upstream I/O occurred. */
      readonly status: "released";
      readonly releasedAt: IsoTimestamp;
      readonly reason: "not-forwarded";
    };

/**
 * Durable attribution and budget reservation for one provider request.
 * Authorization, the unique inference resolution when needed, and this record
 * are committed atomically before any upstream I/O.
 */
export interface InferenceRequestReservation {
  readonly id: InferenceRequestReservationId;
  readonly turnId: TurnId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly model: ModelRef;
  readonly reasoning: TurnReasoningSelection;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedTotalTokens: number;
  readonly authorizedAt: IsoTimestamp;
  readonly state: InferenceRequestReservationState;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Durable current aggregate updated in the same transaction as reservations.
 * Held values cover authorized requests not yet settled/released; charged
 * values are final. The repository rejects an increment that would exceed the
 * pinned Turn inference policy or a narrower live installation ceiling.
 */
export interface TurnInferenceUsageLedger {
  readonly turnId: TurnId;
  readonly heldRequests: number;
  readonly consumedRequests: number;
  readonly heldTokens: number;
  readonly chargedTokens: number;
  readonly inFlightRequests: number;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Minimal persisted session queue. `pendingTurnIds` is bounded by the pinned
 * admission policy and ordered oldest first. A repository must atomically claim
 * only the head, set it active, and record its dispatching lifecycle transition.
 * It must maintain at most one active turn.
 */
export interface TurnQueue {
  readonly sessionId: SessionId;
  readonly activeTurnId?: TurnId;
  readonly pendingTurnIds: readonly TurnId[];
  readonly updatedAt: IsoTimestamp;
}

export interface TurnQueueControls {
  readonly canCancel: boolean;
}

/** Actor-specific presentation projection returned after admission or listing. */
export interface TurnQueueView {
  readonly turnId: TurnId;
  readonly position: number;
  readonly requesterPrincipalId: PrincipalId;
  readonly controls: TurnQueueControls;
}

export type TurnReceipt =
  | {
      readonly turnId: TurnId;
      readonly status: "queued";
      readonly queue: TurnQueueView;
    }
  | {
      readonly turnId: TurnId;
      readonly status: "starting";
      readonly controls: TurnQueueControls;
    };

/**
 * Cancellation is response-idempotent by immutable Turn ID. In one transaction,
 * the repository removes a still-pending Turn, records its terminal cancelled
 * state/result, and appends the durable state/terminal events. Once claimed,
 * active turn cancellation uses session-control authority instead.
 */
export interface CancelQueuedTurnCommand {
  readonly kind: "cancel-queued-turn";
  readonly actor: AuthenticatedPrincipal;
  readonly turnId: TurnId;
}

export type CancelQueuedTurnResult =
  | {
      readonly status: "cancelled";
      readonly turnId: TurnId;
    }
  | {
      /** A retry after the original successful response was lost. */
      readonly status: "already-cancelled";
      readonly turnId: TurnId;
    }
  | {
      readonly status: "not-cancelled";
      readonly turnId: TurnId;
      readonly reason: "turn-not-queued";
    };

/**
 * Evidence that the agent, rather than merely the transport, observed a turn.
 * Session metadata, configuration, or unrelated usage updates are not evidence.
 */
export type PromptAcceptanceEvidence =
  | {
      readonly kind: "explicit-ack";
      readonly correlation: "dispatched-prompt-request";
    }
  | {
      readonly kind: "attributable-turn-event";
      readonly eventKind:
        | "user-message-recorded"
        | "agent-message"
        | "agent-progress"
        | "agent-plan"
        | "tool-call"
        | "interaction-request"
        | "state-running";
      /**
       * Session-level/background events count only when the driver can
       * causally attribute them to this exact dispatched Hitch Turn.
       */
      readonly correlation: "driver-guaranteed";
    }
  | {
      readonly kind: "terminal-response";
      readonly correlation: "dispatched-prompt-request";
    };

export type TurnCancellationReason =
  | "withdrawn-by-requester"
  | "cancelled-by-controller"
  | "authority-revoked"
  | "configuration-authority-revoked"
  | "credential-revoked"
  | "binding-revoked"
  | "unsafe-agent-permission-options"
  | "session-stopped"
  | "shutdown";

/**
 * Stall thresholds are supervisor safeguards in v2.0 rather than session
 * policy knobs, but their terminal outcomes remain explicit and auditable.
 */
export type TurnTimeoutReason = "active-work" | "agent-stall" | "tool-stall";

export interface TurnFailure {
  readonly code:
    | "sandbox-unavailable"
    | "credential-unavailable"
    | "driver-rejected"
    | "driver-error"
    | "worker-lost-before-dispatch"
    | "invalid-agent-event";
  readonly detail?: string;
}

export type TurnResult =
  | { readonly outcome: "completed" }
  | {
      readonly outcome: "limited";
      readonly reason: "max-tokens" | "max-model-requests" | "output-limit";
    }
  | { readonly outcome: "refused" }
  | {
      readonly outcome: "cancelled";
      readonly reason: TurnCancellationReason;
    }
  | {
      readonly outcome: "timed-out";
      readonly reason: TurnTimeoutReason;
    }
  | {
      readonly outcome: "policy-denied";
      readonly reason: string;
    }
  | {
      readonly outcome: "failed";
      readonly failure: TurnFailure;
    }
  | {
      /**
       * The prompt may have been accepted before the worker was lost. Automatic
       * replay is forbidden. Exact driver reconciliation is attempted before
       * recording this immutable result; later evidence cannot rewrite it.
       */
      readonly outcome: "unknown";
      readonly reason: "worker-lost-after-dispatch";
    };

export type TurnLifecycleState =
  | { readonly status: "queued" }
  | {
      readonly status: "dispatching";
      readonly attemptId: AgentDispatchAttemptId;
      readonly attempt: number;
      readonly startedAt: IsoTimestamp;
    }
  | {
      /**
       * Durably committed before a driver may attempt to submit protocol bytes.
       * The broker gate remains closed. Recovery assumes submission may have
       * occurred unless a live driver proves that no byte could have been sent.
       */
      readonly status: "submission-armed";
      readonly attemptId: AgentDispatchAttemptId;
      readonly attempt: number;
      readonly armedAt: IsoTimestamp;
    }
  | {
      /**
       * A complete protocol frame may have reached the agent, but no prompt
       * acceptance evidence exists.
       */
      readonly status: "submitted-unconfirmed";
      readonly attemptId: AgentDispatchAttemptId;
      readonly attempt: number;
      readonly submittedAt: IsoTimestamp;
    }
  | {
      readonly status: "accepted";
      readonly attemptId: AgentDispatchAttemptId;
      readonly acceptedAt: IsoTimestamp;
      readonly evidence: PromptAcceptanceEvidence;
    }
  | {
      readonly status: "running";
      readonly attemptId: AgentDispatchAttemptId;
      readonly startedAt: IsoTimestamp;
    }
  | {
      readonly status: "waiting-for-approval";
      readonly attemptId: AgentDispatchAttemptId;
      readonly interactionId: TurnInteractionId;
      readonly waitingSince: IsoTimestamp;
    }
  | {
      readonly status: "waiting-for-input";
      readonly attemptId: AgentDispatchAttemptId;
      readonly interactionId: TurnInteractionId;
      readonly waitingSince: IsoTimestamp;
    }
  | {
      readonly status: "cancelling";
      readonly attemptId: AgentDispatchAttemptId;
      readonly requestedAt: IsoTimestamp;
      readonly requestedBy: AuditActorRef;
      readonly reason: TurnCancellationReason;
    }
  | {
      readonly status: "terminal";
      readonly completedAt: IsoTimestamp;
      readonly result: TurnResult;
      readonly partialOutputAvailable: boolean;
    };

export type TurnLifecycleStatus = TurnLifecycleState["status"];

/** Mutable current projection; durable events preserve the transition history. */
export interface TurnRuntimeState {
  readonly turnId: TurnId;
  readonly state: TurnLifecycleState;
  readonly updatedAt: IsoTimestamp;
}

export type TurnPlanEntryStatus = "pending" | "in-progress" | "completed";
export type TurnPlanEntryPriority = "low" | "medium" | "high";

export interface TurnPlanEntry {
  readonly content: string;
  readonly status: TurnPlanEntryStatus;
  readonly priority: TurnPlanEntryPriority;
}

export type ActiveToolInvocationStatus = "pending" | "in-progress";
export type FinalToolInvocationStatus = "completed" | "failed" | "cancelled";

export interface TurnUsage {
  readonly scope: "turn" | "session";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly contextUsedTokens?: number;
  readonly contextSizeTokens?: number;
  readonly cost?: {
    readonly amount: number;
    readonly currency: string;
  };
}

/**
 * Driver-normalized semantic disposition of an option advertised by an agent.
 * Any scope broader than one tool invocation is persistent from Hitch's
 * perspective, even when the agent calls it "session" rather than "always".
 */
export type AgentPermissionOptionDisposition =
  | "allow-once"
  | "allow-persistent"
  | "deny-once"
  | "deny-persistent"
  | "unknown";

/** Sanitized but complete audit projection of an agent-advertised option. */
export interface AgentPermissionOption {
  readonly protocolOptionId: AgentProtocolInteractionOptionId;
  readonly protocolKind: AgentProtocolPermissionOptionKind;
  readonly sanitizedLabel: string;
  readonly advertisedDisposition: AgentPermissionOptionDisposition;
}

export type AgentAllowOncePermissionOption = AgentPermissionOption & {
  readonly advertisedDisposition: "allow-once";
};

export type AgentDenyOncePermissionOption = AgentPermissionOption & {
  readonly advertisedDisposition: "deny-once";
};

export type TurnApprovalAllowOnceAgentResponse =
  | {
      readonly kind: "select-advertised-option";
      readonly option: AgentAllowOncePermissionOption;
    }
  | {
      readonly kind: "driver-mediated";
      readonly mediationId: AgentDriverPermissionMediationId;
      readonly guaranteedDisposition: "allow-once";
      readonly guarantee: "one-tool-invocation";
    };

export type TurnApprovalDenyOnceAgentResponse =
  | {
      readonly kind: "select-advertised-option";
      readonly option: AgentDenyOncePermissionOption;
    }
  | {
      readonly kind: "driver-mediated";
      readonly mediationId: AgentDriverPermissionMediationId;
      readonly guaranteedDisposition: "deny-once";
      readonly guarantee: "one-tool-invocation";
    };

/**
 * A choice Hitch may safely offer or select. Persistent/unknown advertised
 * options can appear in the audit list but never in this selectable union.
 */
export type TurnApprovalOption =
  | {
      readonly id: TurnInteractionOptionId;
      readonly sanitizedLabel: string;
      readonly normalizedDecision: "allow-once";
      readonly agentResponse: TurnApprovalAllowOnceAgentResponse;
    }
  | {
      readonly id: TurnInteractionOptionId;
      readonly sanitizedLabel: string;
      readonly normalizedDecision: "deny";
      readonly agentResponse: TurnApprovalDenyOnceAgentResponse;
    };

export interface TurnApprovalInteractionRequest {
  readonly kind: "approval";
  readonly toolInvocationId: ToolInvocationId;
  readonly title: string;
  readonly sanitizedDescription?: string;
  /** Complete dispositions retained for audit, including filtered options. */
  readonly advertisedAgentOptions: readonly AgentPermissionOption[];
  /** Only one-operation options or explicitly safe driver mediation. */
  readonly options: readonly TurnApprovalOption[];
}

export interface TurnInputInteractionRequest {
  readonly kind: "input";
  readonly sanitizedPrompt: string;
  readonly responseSchema?: JsonObject;
}

export type TurnInteractionRequest =
  | TurnApprovalInteractionRequest
  | TurnInputInteractionRequest;

/** Evidence that a human interaction response passed Hitch authorization. */
export type TurnApprovalAuthorization =
  | {
      readonly basis: "session.approve";
      readonly decision: "allowed";
      readonly reason: "session-owner";
      readonly evaluatedAt: IsoTimestamp;
    }
  | {
      readonly basis: "session.approve";
      readonly decision: "allowed";
      readonly reason: "role-grant";
      readonly supportingGrantId: AccessGrantId;
      readonly evaluatedAt: IsoTimestamp;
    };

export interface TurnApprovalPrincipalResolver {
  readonly actor: AuthenticatedPrincipal;
  readonly authorization: TurnApprovalAuthorization;
}

export interface TurnInputPrincipalResolver {
  readonly actor: AuthenticatedPrincipal;
  readonly authorization: {
    readonly basis: "turn-requester";
    readonly decision: "allowed";
    readonly reason: "turn-requester";
    readonly evaluatedAt: IsoTimestamp;
  };
}

export type TurnApprovalInteractionResolution =
  | {
      readonly kind: "approval-by-policy";
      readonly executionPolicySnapshotId: ExecutionPolicySnapshotId;
      readonly selectedOption: TurnApprovalOption;
      readonly reason: string;
    }
  | {
      readonly kind: "approval-by-principal";
      readonly resolver: TurnApprovalPrincipalResolver;
      readonly selectedOption: TurnApprovalOption;
    }
  | {
      readonly kind: "approval-timed-out";
      readonly agentOutcome: "deny";
      readonly agentResponse: TurnApprovalDenyOnceAgentResponse;
    }
  | {
      readonly kind: "approval-cancelled";
      readonly reason: TurnCancellationReason;
    };

export type TurnInputInteractionResolution =
  | {
      readonly kind: "input-by-originator";
      readonly resolver: TurnInputPrincipalResolver;
      /** The response is retained separately under content access controls. */
      readonly responseId: TurnInteractionResponseId;
    }
  | {
      readonly kind: "input-timed-out";
      readonly agentOutcome: "no-input";
    }
  | {
      readonly kind: "input-cancelled";
      readonly reason: TurnCancellationReason;
    };

export type TurnInteractionResolution =
  | TurnApprovalInteractionResolution
  | TurnInputInteractionResolution;

export type TurnInteractionState<
  Resolution extends TurnInteractionResolution = TurnInteractionResolution,
> =
  | { readonly status: "pending" }
  | {
      readonly status: "resolved";
      readonly resolution: Resolution;
      readonly resolvedAt: IsoTimestamp;
    };

/**
 * Durable security/audit record for an approval or input request. It contains
 * only sanitized request metadata; raw tool arguments remain outside it.
 */
interface TurnInteractionBase {
  readonly id: TurnInteractionId;
  readonly turnId: TurnId;
  /** Agent/driver-local correlation only; Hitch still assigns `id`. */
  readonly protocolInteractionId: AgentProtocolInteractionId;
  readonly requestedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export type TurnInteraction =
  | (TurnInteractionBase & {
      readonly request: TurnApprovalInteractionRequest;
      readonly state: TurnInteractionState<TurnApprovalInteractionResolution>;
    })
  | (TurnInteractionBase & {
      readonly request: TurnInputInteractionRequest;
      readonly state: TurnInteractionState<TurnInputInteractionResolution>;
    });

/** Content record protected by the same access checks as the originating Turn. */
export interface TurnInteractionResponse {
  readonly id: TurnInteractionResponseId;
  readonly interactionId: TurnInteractionId;
  readonly content: readonly TurnContentBlock[];
  readonly createdAt: IsoTimestamp;
}

export type TransientTurnEventPayload =
  | {
      readonly kind: "agent-message-chunk";
      readonly messageId: TurnMessageId;
      readonly protocolMessageId?: AgentProtocolMessageId;
      readonly content: TurnContentBlock;
    }
  | {
      /** Transient progress only; it is never persisted as raw reasoning. */
      readonly kind: "agent-progress-chunk";
      readonly content: TurnContentBlock;
    };

export type CheckpointTurnEventPayload =
  | {
      readonly kind: "plan";
      readonly entries: readonly TurnPlanEntry[];
    }
  | {
      /**
       * Sanitized status only. Raw tool input/output remains outside the turn
       * event model because it may contain secrets.
       */
      readonly kind: "tool-invocation-update";
      readonly toolInvocationId: ToolInvocationId;
      readonly protocolToolCallId?: AgentProtocolToolCallId;
      readonly title: string;
      readonly status: ActiveToolInvocationStatus;
      readonly sanitizedSummary?: string;
    }
  | {
      readonly kind: "usage-update";
      readonly usage: TurnUsage;
    };

export type DurableTurnEventPayload =
  | {
      readonly kind: "state-transition";
      readonly from: TurnLifecycleState;
      readonly to: TurnLifecycleState;
    }
  | {
      /** Durable evidence retained after the current state advances to running. */
      readonly kind: "prompt-accepted";
      readonly evidence: PromptAcceptanceEvidence;
    }
  | {
      /**
       * Actual immutable model/reasoning choice. Required for agent-selected
       * Turns and recorded at admission for already-resolved Turns.
       */
      readonly kind: "inference-resolved";
      readonly resolution: TurnInferenceResolution;
    }
  | {
      readonly kind: "user-message-recorded";
      readonly protocolMessageId?: AgentProtocolMessageId;
    }
  | {
      readonly kind: "agent-message-finalized";
      readonly messageId: TurnMessageId;
      readonly content: readonly TurnContentBlock[];
    }
  | {
      /**
       * Sanitized final status. Raw tool input/output is never included.
       */
      readonly kind: "tool-invocation-finalized";
      readonly toolInvocationId: ToolInvocationId;
      readonly protocolToolCallId?: AgentProtocolToolCallId;
      readonly title: string;
      readonly status: FinalToolInvocationStatus;
      readonly sanitizedSummary?: string;
    }
  | {
      readonly kind: "interaction-requested";
      readonly interactionId: TurnInteractionId;
      readonly request: TurnInteractionRequest;
    }
  | {
      readonly kind: "interaction-resolved";
      readonly interactionId: TurnInteractionId;
      readonly interactionKind: "approval";
      readonly resolution: TurnApprovalInteractionResolution;
    }
  | {
      readonly kind: "interaction-resolved";
      readonly interactionId: TurnInteractionId;
      readonly interactionKind: "input";
      readonly resolution: TurnInputInteractionResolution;
    }
  | {
      readonly kind: "usage-finalized";
      readonly usage: TurnUsage;
    }
  | {
      readonly kind: "terminal";
      readonly result: TurnResult;
      readonly partialOutputAvailable: boolean;
    };

export type TurnEventVisibility = "internal" | "requester" | "session-readers";

/**
 * Hitch assigns IDs, sequence, and visibility after validating a driver event.
 * Driver-supplied IDs are optional correlation metadata and are never domain
 * identity. A driver never selects an event's audience.
 *
 * Durability is deliberately absent from the event. The storage boundary
 * derives transient/checkpoint/durable handling exhaustively from payload.kind,
 * so callers cannot persist raw progress merely by choosing a durability flag.
 */
export interface TurnEvent {
  readonly id: TurnEventId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly visibility: TurnEventVisibility;
  readonly occurredAt: IsoTimestamp;
  readonly payload: TurnEventPayload;
}

export type TurnEventPayload =
  | TransientTurnEventPayload
  | CheckpointTurnEventPayload
  | DurableTurnEventPayload;

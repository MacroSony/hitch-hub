/**
 * Compile-only v2 turn and dispatch model.
 *
 * A Turn is Hitch's immutable, durable unit of requested work. Agent protocol
 * requests are runtime projections of a Turn and never replace its identity,
 * lifecycle, authorization, idempotency, or queue semantics.
 */

import type {
  AccessGrantId,
  AgentDriverPermissionMediationId,
  AgentProtocolInteractionOptionId,
  AgentProtocolMessageId,
  AgentProtocolPermissionOptionKind,
  AgentProtocolToolCallId,
  AttachmentId,
  AuthenticationRequestId,
  EndpointBindingPolicySnapshotId,
  EndpointId,
  ExecutionPolicySnapshotId,
  IdentityBindingId,
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
  TurnQueueEntryId,
  TurnQueueMutationIdempotencyKey,
  WorkspaceResourceId,
} from "./primitives.js";
import type { AuditActorRef, AuthenticatedPrincipal } from "./identity-access.js";
import type { TurnExecutionOptions } from "./session.js";

export type TurnBusyBehavior =
  | "reject"
  | "bounded-fifo"
  | "replace-newest-own-pending";

export interface TurnAdmissionPolicy {
  readonly whenBusy: TurnBusyBehavior;
  readonly maxQueuedTurns: number;
}

export interface TurnTimingPolicy {
  /** Active agent work before tool-based extensions. */
  readonly initialActiveWorkMs: number;
  /** Active-work time added by each distinct tool invocation. */
  readonly toolExtensionMs: number;
  /** Hard cap for active work after all extensions. */
  readonly maximumActiveWorkMs: number;
  /** Absolute lifetime including time waiting for human interaction. */
  readonly maximumWallClockMs: number;
  readonly agentStallMs: number;
  readonly toolStallMs: number;
  readonly interactionWaitMs: number;
  readonly cancellationGraceMs: number;
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

/**
 * One audience-authorized, untrusted group-context contribution. Contributors
 * provide context only; they never lend authority to the triggering actor.
 */
export interface CapturedContextMessage {
  readonly originMessageId: OriginMessageId;
  readonly authorPrincipalId: PrincipalId;
  readonly sentAt: IsoTimestamp;
  readonly content: readonly TurnContentBlock[];
}

/** Exact immutable prompt and bounded group context admitted for a turn. */
export interface TurnInputSnapshot {
  readonly id: TurnInputSnapshotId;
  readonly triggeringContent: readonly TurnContentBlock[];
  readonly capturedContext: readonly CapturedContextMessage[];
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
  readonly bindingPolicySnapshotId: EndpointBindingPolicySnapshotId;
  readonly originMessageId: OriginMessageId;
}

/**
 * Initial structured turns originate at an endpoint. Future schedules and
 * service triggers must add explicit authenticated origin variants.
 */
export type TurnOrigin = EndpointTurnOrigin;

/**
 * Immutable accepted work. The idempotency tuple is scoped by the origin
 * endpoint and key. A replacement creates a new Turn and points back to the
 * superseded record rather than mutating it.
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
  readonly supersedesTurnId?: TurnId;
  readonly createdAt: IsoTimestamp;
}

export type TurnQueueEntryState =
  | { readonly status: "queued" }
  | {
      readonly status: "claimed";
      readonly claimedAt: IsoTimestamp;
    }
  | {
      readonly status: "closed";
      readonly closedAt: IsoTimestamp;
    };

/**
 * Stable FIFO slot. Replacing a queued turn atomically updates currentTurnId,
 * preserving ordinal while the old immutable Turn becomes superseded.
 */
export interface TurnQueueEntry {
  readonly id: TurnQueueEntryId;
  readonly sessionId: SessionId;
  readonly ordinal: number;
  /** Incremented on replacement, claim, and close. */
  readonly revision: number;
  readonly currentTurnId: TurnId;
  readonly state: TurnQueueEntryState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface TurnQueueControls {
  readonly canCancel: boolean;
  readonly canReplace: boolean;
}

/** Actor-specific presentation projection returned after admission or listing. */
export interface TurnQueueView {
  readonly queueEntryId: TurnQueueEntryId;
  readonly turnId: TurnId;
  /** Supplied back as part of a queue-mutation compare-and-swap. */
  readonly queueEntryRevision: number;
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
 * Every queued cancel/replace is a compare-and-swap over both the stable slot
 * and the immutable Turn currently occupying it. Checking only "queued" is
 * unsafe because replacement deliberately leaves the slot queued.
 */
export interface TurnQueueMutationPrecondition {
  readonly queueEntryId: TurnQueueEntryId;
  readonly expectedState: "queued";
  readonly expectedRevision: number;
  readonly expectedCurrentTurnId: TurnId;
}

interface TurnQueueMutationCommandBase {
  readonly actor: AuthenticatedPrincipal;
  /**
   * Unique within (actor principal, queue entry). Retrying an applied command
   * returns its original result and does not perform another mutation.
   */
  readonly idempotencyKey: TurnQueueMutationIdempotencyKey;
  readonly precondition: TurnQueueMutationPrecondition;
}

export interface CancelQueuedTurnCommand extends TurnQueueMutationCommandBase {
  readonly kind: "cancel-queued-turn";
}

/**
 * The replacement Turn and its snapshot are created in the same transaction
 * that validates the precondition and updates the stable queue slot.
 */
export interface ReplaceQueuedTurnCommand extends TurnQueueMutationCommandBase {
  readonly kind: "replace-queued-turn";
  /**
   * Only the trigger is replaceable. The service copies the original captured
   * context into a new snapshot inside the queue transaction.
   */
  readonly replacementTriggeringContent: readonly TurnContentBlock[];
  readonly replacementExecution: TurnExecutionOptions;
  readonly replacementTurnIdempotencyKey: TurnIdempotencyKey;
}

export type TurnQueueMutationCommand =
  | CancelQueuedTurnCommand
  | ReplaceQueuedTurnCommand;

export type TurnQueueMutationResult =
  | {
      readonly status: "applied";
      readonly operation: "cancel";
      readonly queueEntryId: TurnQueueEntryId;
      readonly previousTurnId: TurnId;
      readonly queueEntryRevision: number;
    }
  | {
      readonly status: "applied";
      readonly operation: "replace";
      readonly queueEntryId: TurnQueueEntryId;
      readonly previousTurnId: TurnId;
      readonly currentTurnId: TurnId;
      readonly queueEntryRevision: number;
    }
  | {
      readonly status: "conflict";
      readonly reason:
        | "idempotency-key-reused"
        | "turn-already-started"
        | "turn-already-closed"
        | "stale-current-turn"
        | "stale-revision";
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
  | "superseded"
  | "authority-revoked"
  | "configuration-authority-revoked"
  | "credential-revoked"
  | "binding-revoked"
  | "binding-policy-changed"
  | "unsafe-agent-permission-options"
  | "session-stopped"
  | "shutdown";

export type TurnTimeoutReason =
  | "active-work"
  | "wall-clock"
  | "agent-stall"
  | "tool-stall"
  | "cancellation-grace";

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
  | {
      readonly status: "queued";
      readonly queueEntryId: TurnQueueEntryId;
    }
  | {
      readonly status: "dispatching";
      readonly attempt: number;
      readonly startedAt: IsoTimestamp;
    }
  | {
      /** Transport write succeeded, but no agent acceptance evidence exists. */
      readonly status: "submitted-unconfirmed";
      readonly attempt: number;
      readonly submittedAt: IsoTimestamp;
    }
  | {
      readonly status: "accepted";
      readonly acceptedAt: IsoTimestamp;
      readonly evidence: PromptAcceptanceEvidence;
    }
  | {
      readonly status: "running";
      readonly startedAt: IsoTimestamp;
    }
  | {
      readonly status: "waiting-for-approval";
      readonly interactionId: TurnInteractionId;
      readonly waitingSince: IsoTimestamp;
    }
  | {
      readonly status: "waiting-for-input";
      readonly interactionId: TurnInteractionId;
      readonly waitingSince: IsoTimestamp;
    }
  | {
      readonly status: "cancelling";
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

export type TurnEventDurability = "transient" | "checkpoint" | "durable";
export type TurnEventVisibility = "internal" | "requester" | "session-readers";

/**
 * Hitch assigns IDs and sequence after validating a driver event. Driver-
 * supplied IDs are optional correlation metadata and are never domain identity.
 * The discriminated union prevents privacy/audit invariants from being weakened
 * by assigning arbitrary durability to a payload.
 */
interface TurnEventEnvelope {
  readonly id: TurnEventId;
  readonly turnId: TurnId;
  readonly sequence: number;
  readonly visibility: TurnEventVisibility;
  readonly occurredAt: IsoTimestamp;
}

export type TransientTurnEvent = TurnEventEnvelope & {
  readonly durability: "transient";
  readonly payload: TransientTurnEventPayload;
};

export type CheckpointTurnEvent = TurnEventEnvelope & {
  readonly durability: "checkpoint";
  readonly payload: CheckpointTurnEventPayload;
};

export type DurableTurnEvent = TurnEventEnvelope & {
  readonly durability: "durable";
  readonly payload: DurableTurnEventPayload;
};

export type TurnEvent =
  | TransientTurnEvent
  | CheckpointTurnEvent
  | DurableTurnEvent;

export type TurnEventPayload = TurnEvent["payload"];

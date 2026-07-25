/**
 * Compile-only v2 AgentDriver and AgentRuntime contract.
 *
 * Drivers translate trusted Hitch domain inputs to one agent protocol. They do
 * not spawn or terminate processes, select sandboxes, resolve host paths,
 * authorize work, persist events, or deliver output.
 */

import type {
  AgentDispatchAttemptId,
  AgentDriverId,
  AgentDriverLaunchProfileId,
  AgentImageMimeType,
  AgentProtocolInteractionId,
  AgentProtocolMessageId,
  AgentProtocolToolCallId,
  AgentResumeHandleId,
  Base64Payload,
  IsoTimestamp,
  JsonObject,
  SandboxPath,
  TurnId,
} from "./primitives.js";
import type { InferenceExecutionMode } from "./provider-broker.js";
import type {
  AgentRuntimeResource,
  AgentTurnInferenceConfiguration,
  SanitizedAgentProfileConfiguration,
  SanitizedAgentRuntimeConfiguration,
} from "./runtime-security.js";
import type { AgentProfileRevision } from "./session.js";
import type {
  ActiveToolInvocationStatus,
  AgentPermissionOption,
  FinalToolInvocationStatus,
  PromptAcceptanceEvidence,
  TurnApprovalAllowOnceAgentResponse,
  TurnApprovalDenyOnceAgentResponse,
  TurnPlanEntry,
} from "./turn.js";

declare const armedProtocolSubmissionBrand: unique symbol;

export interface AgentDriverCapabilities {
  readonly protocol: "pi-rpc" | "acp" | "other";
  readonly promptAcceptance:
    | "explicit-protocol-ack"
    | "first-causally-attributable-event"
    | "terminal-response-only";
  readonly eventCorrelation: "prepared-turn-run";
  readonly resume: "opaque-handle" | "unsupported";
  readonly reconciliation: "exact-turn-handle" | "live-runtime-only" | "unsupported";
  readonly interactions: {
    readonly approval: "safe-once" | "unsupported";
    readonly structuredInput: "supported" | "unsupported";
  };
  readonly inference: {
    readonly executionModes: readonly [
      InferenceExecutionMode,
      ...InferenceExecutionMode[],
    ];
    /**
     * Whether the driver can project a secret-free native provider bridge into
     * the worker. Pi supports this through an exact generated provider
     * extension; other drivers may expose only wire or agent-native modes.
     */
    readonly credentialFreeNativeBridge: "supported" | "unsupported";
  };
  readonly resources: {
    readonly skills: "explicit-pinned" | "unsupported";
    readonly promptTemplates: "explicit-pinned" | "unsupported";
    readonly themes: "explicit-pinned" | "unsupported";
    readonly extensions: "explicit-granted" | "unsupported";
    readonly projectAutoDiscovery: false;
    readonly hotReload: false;
  };
}

export type AgentProfileValidationResult =
  | {
      readonly accepted: true;
      readonly configuration: SanitizedAgentProfileConfiguration;
    }
  | {
      readonly accepted: false;
      readonly issues: readonly {
        readonly path: string;
        readonly code: string;
        readonly message: string;
      }[];
    };

export type AgentLaunchMode =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "resume";
      readonly resumeHandleId: AgentResumeHandleId;
    };

/**
 * Semantic launch projection consumed by a supervisor-owned, driver-specific
 * launch renderer. `launchProfileId` resolves to a reviewed executable and
 * fixed base argument set; it is not a caller-supplied command.
 */
export interface AgentLaunchProjection {
  readonly launchProfileId: AgentDriverLaunchProfileId;
  readonly mode: AgentLaunchMode;
  readonly workingDirectory: SandboxPath;
  readonly configurationFiles: readonly {
    readonly sandboxPath: SandboxPath;
    readonly content: JsonObject;
  }[];
  readonly resources: readonly AgentRuntimeResource[];
}

export interface AgentProcessExit {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly observedAt: IsoTimestamp;
}

export type AgentTransportWriteResult =
  | {
      readonly kind: "complete";
      readonly completedAt: IsoTimestamp;
    }
  | {
      /** The supervisor proves that no byte was written to the agent. */
      readonly kind: "definitely-not-written";
      readonly failedAt: IsoTimestamp;
      readonly reason: string;
    }
  | {
      /** A partial or complete frame may have reached the agent. */
      readonly kind: "write-uncertain";
      readonly failedAt: IsoTimestamp;
      readonly reason: string;
    };

/**
 * Process I/O owned and lifecycle-controlled by the trusted supervisor. The
 * driver can speak its protocol but cannot spawn, signal, or outlive the
 * supervisor's worker lease.
 */
export interface SupervisorOwnedAgentProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  writeStdin(frame: Uint8Array): Promise<AgentTransportWriteResult>;
  observeExit(): Promise<AgentProcessExit>;
}

export interface AgentRuntimeReadyState {
  readonly resumeHandleId?: AgentResumeHandleId;
  readonly observedAt: IsoTimestamp;
}

/**
 * Fully resolved prompt projection. Attachment storage and host paths never
 * cross the driver boundary. The first Pi slice admits text plus one validated
 * image format supported by the selected model.
 */
export interface AgentPromptImage {
  readonly mimeType: AgentImageMimeType;
  readonly byteLength: number;
  readonly base64Data: Base64Payload;
}

/** Exact first-slice prompt shape: required text and at most one image. */
export interface AgentTurnPrompt {
  readonly text: string;
  readonly image?: AgentPromptImage;
}

export interface AgentTurnPreparation {
  readonly attemptId: AgentDispatchAttemptId;
  readonly attempt: number;
  readonly turnId: TurnId;
  readonly prompt: AgentTurnPrompt;
  readonly inference: AgentTurnInferenceConfiguration;
}

/**
 * Repository-issued evidence that `submission-armed` is durable. A driver must
 * reject `submitProtocolPrompt` without this exact Turn/attempt authorization.
 */
export interface ArmedProtocolPromptSubmission {
  readonly [armedProtocolSubmissionBrand]: true;
  readonly attemptId: AgentDispatchAttemptId;
  readonly turnId: TurnId;
  readonly armedAt: IsoTimestamp;
}

export type ProtocolPromptSubmissionOutcome =
  | {
      /**
       * The complete agent-protocol frame was written. This is submission, not
       * prompt acceptance.
       */
      readonly kind: "submitted";
      readonly submittedAt: IsoTimestamp;
    }
  | {
      /** Safe to retry only after the repository leaves the armed attempt. */
      readonly kind: "definitely-not-submitted";
      readonly failedAt: IsoTimestamp;
      readonly reason: string;
    }
  | {
      /** No automatic replay: some or all protocol bytes may have arrived. */
      readonly kind: "submission-unknown";
      readonly failedAt: IsoTimestamp;
      readonly reason: string;
    };

export type AgentPromptAcceptanceOutcome =
  | {
      /**
       * The agent runtime accepted responsibility for this Turn. Extensions
       * may transform the model-facing prompt, but the Hitch input snapshot is
       * unchanged and the normal agent loop must still run.
       */
      readonly kind: "accepted";
      readonly acceptedAt: IsoTimestamp;
      readonly evidence: PromptAcceptanceEvidence;
    }
  | {
      /** A correlated protocol response rejected the prompt before acceptance. */
      readonly kind: "rejected";
      readonly rejectedAt: IsoTimestamp;
      readonly reason: string;
    }
  | {
      /** Connection/process loss prevents an exact acceptance determination. */
      readonly kind: "unknown";
      readonly observedAt: IsoTimestamp;
      readonly reason: string;
    };

export type AgentDriverTerminalOutcome =
  | { readonly outcome: "completed" }
  | { readonly outcome: "output-limit" }
  | { readonly outcome: "refused" }
  | { readonly outcome: "cancelled" }
  | {
      readonly outcome: "failed";
      readonly code: "agent-error" | "protocol-error";
      readonly sanitizedDetail?: string;
    };

/**
 * Driver-normalized observations deliberately use only protocol-local
 * correlation. The application allocates every Hitch message, tool, and
 * interaction ID while converting these into TurnEventPayload values.
 */
export type AgentDriverTurnEventPayload =
  | {
      readonly kind: "user-message-recorded";
      readonly protocolMessageId?: AgentProtocolMessageId;
    }
  | {
      readonly kind: "agent-message-chunk";
      readonly protocolMessageId: AgentProtocolMessageId;
      readonly text: string;
    }
  | {
      readonly kind: "agent-progress-chunk";
      readonly text: string;
    }
  | {
      readonly kind: "plan";
      readonly entries: readonly TurnPlanEntry[];
    }
  | {
      readonly kind: "tool-invocation-update";
      readonly protocolToolCallId: AgentProtocolToolCallId;
      readonly title: string;
      readonly status: ActiveToolInvocationStatus;
      readonly sanitizedSummary?: string;
    }
  | {
      readonly kind: "agent-message-finalized";
      readonly protocolMessageId: AgentProtocolMessageId;
      readonly text: string;
    }
  | {
      readonly kind: "tool-invocation-finalized";
      readonly protocolToolCallId: AgentProtocolToolCallId;
      readonly title: string;
      readonly status: FinalToolInvocationStatus;
      readonly sanitizedSummary?: string;
    }
  | {
      readonly kind: "interaction-requested";
      readonly protocolInteractionId: AgentProtocolInteractionId;
      readonly request:
        | {
            readonly kind: "approval";
            readonly protocolToolCallId: AgentProtocolToolCallId;
            readonly title: string;
            readonly sanitizedDescription?: string;
            readonly options: readonly AgentPermissionOption[];
          }
        | {
            readonly kind: "input";
            readonly sanitizedPrompt: string;
            readonly responseSchema?: JsonObject;
          };
    }
  | {
      readonly kind: "terminal";
      readonly terminal: AgentDriverTerminalOutcome;
      readonly partialOutputAvailable: boolean;
    };

/**
 * A normalized event has no Hitch Turn ID, sequence, visibility, or durability
 * selector. Its containing AgentTurnRun supplies causal Turn attribution; the
 * application validates it and assigns all domain metadata.
 */
export interface AgentDriverTurnEvent {
  readonly observedAt: IsoTimestamp;
  readonly payload: AgentDriverTurnEventPayload;
}

export type AgentInteractionResponse =
  | {
      readonly kind: "approval";
      readonly protocolInteractionId: AgentProtocolInteractionId;
      readonly response:
        | TurnApprovalAllowOnceAgentResponse
        | TurnApprovalDenyOnceAgentResponse;
    }
  | {
      readonly kind: "input";
      readonly protocolInteractionId: AgentProtocolInteractionId;
      readonly text: string;
    }
  | {
      readonly kind: "no-input";
      readonly protocolInteractionId: AgentProtocolInteractionId;
    };

export type AgentTurnReconciliation =
  | {
      readonly kind: "definitely-not-submitted";
      readonly attemptId: AgentDispatchAttemptId;
    }
  | {
      readonly kind: "live";
      readonly attemptId: AgentDispatchAttemptId;
      readonly state: "submitted-unconfirmed" | "accepted" | "running";
      readonly acceptanceEvidence?: PromptAcceptanceEvidence;
    }
  | {
      readonly kind: "terminal";
      readonly attemptId: AgentDispatchAttemptId;
      readonly terminal: AgentDriverTerminalOutcome;
      readonly partialOutputAvailable: boolean;
    }
  | {
      readonly kind: "unknown";
      readonly attemptId: AgentDispatchAttemptId;
      readonly reason: string;
    };

/**
 * One prepared Turn scope. `submitProtocolPrompt` is the only method allowed to
 * emit the prompt command. Event correlation is structural: an event from this
 * object belongs to this Turn/attempt or is rejected by the driver.
 */
export interface AgentTurnRun {
  readonly attemptId: AgentDispatchAttemptId;
  readonly turnId: TurnId;
  submitProtocolPrompt(
    authorization: ArmedProtocolPromptSubmission,
  ): Promise<ProtocolPromptSubmissionOutcome>;
  awaitPromptAcceptance(): Promise<AgentPromptAcceptanceOutcome>;
  events(): AsyncIterable<AgentDriverTurnEvent>;
  respondToInteraction(response: AgentInteractionResponse): Promise<void>;
  cancel(reason: string): Promise<void>;
  reconcile(): Promise<AgentTurnReconciliation>;
}

export interface AgentRuntime {
  initialize(): Promise<AgentRuntimeReadyState>;
  inspect(): Promise<"idle" | "running" | "waiting" | "closed" | "unknown">;
  /**
   * Preparation may perform protocol-neutral validation and configuration but
   * must not emit a prompt command or cause inference.
   */
  prepareTurn(preparation: AgentTurnPreparation): Promise<AgentTurnRun>;
  closeProtocol(): Promise<void>;
}

/**
 * Static trusted adapter definition. The supervisor supplies an already
 * launched process to `attach`; drivers never receive process-spawn authority.
 */
export interface AgentDriverDefinition {
  readonly id: AgentDriverId;
  readonly capabilities: AgentDriverCapabilities;
  validateProfile(profile: AgentProfileRevision): AgentProfileValidationResult;
  projectLaunch(
    configuration: SanitizedAgentRuntimeConfiguration,
    mode: AgentLaunchMode,
  ): AgentLaunchProjection;
  attach(process: SupervisorOwnedAgentProcess): Promise<AgentRuntime>;
}

import type { AuditActorRef, AuthenticatedPrincipal } from "../model/identity-access.js";
import type {
  AgentDriverTerminalOutcome,
  AgentDriverTurnEvent,
  AgentDriverTurnEventPayload,
} from "../model/agent-runtime.js";
import type {
  AgentPermissionOption,
  PromptAcceptanceEvidence,
  TurnApprovalAllowOnceAgentResponse,
  TurnApprovalAuthorization,
  TurnApprovalDenyOnceAgentResponse,
  TurnApprovalInteractionRequest,
  TurnApprovalInteractionResolution,
  TurnApprovalOption,
  TurnContentBlock,
  TurnEvent,
  TurnEventPayload,
  TurnFailure,
  TurnInferenceResolution,
  TurnInputInteractionRequest,
  TurnInputInteractionResolution,
  TurnInteractionRequest,
  TurnLifecycleState,
  TurnPlanEntry,
  TurnResult,
  TurnUsage,
} from "../model/turn.js";
import type { TurnReasoningSelection } from "../model/session.js";
import type { JsonObject } from "../model/primitives.js";
import { codecFail, type CodecPath } from "./errors.js";
import { encodeCanonicalJson } from "./json.js";
import {
  decodeAgentImageMimeType,
  decodeBoundedArray,
  decodeBoundedString,
  decodeIsoTimestamp,
  decodeMimeType,
  decodeNonNegativeSafeInteger,
  decodePositiveSafeInteger,
  decodeSandboxPath,
  decodeServiceId,
} from "./primitives.js";
import {
  assertSecretFreeJsonValue,
  decodeSecretFreeJsonObject,
} from "./projections.js";
import {
  at,
  decodeBoolean,
  decodeEnum,
  decodeLiteral,
  decodePlainObject,
  decodeString,
  requireExactFields,
} from "./structure.js";

type Decoder<Value> = (input: unknown, path?: CodecPath) => Value;

/**
 * Absolute decoder safety caps for a single event record.  These are measured
 * in JavaScript string code units / item counts, not UTF-8 bytes and not an
 * installation's runtime output policy.  Later admission and driver resource
 * policies may only narrow them; byte ceilings are enforced at the streaming
 * resource boundary rather than by this structural codec.
 */
export const TURN_EVENT_STRUCTURAL_CODEC_CAPS = Object.freeze({
  maximumTextCharacters: 65_536,
  maximumShortTextCharacters: 4_096,
  maximumContentBlocks: 256,
  maximumPlanEntries: 128,
  maximumInteractionOptions: 64,
});

const MAX_TEXT_CHARACTERS = TURN_EVENT_STRUCTURAL_CODEC_CAPS.maximumTextCharacters;
const MAX_SHORT_TEXT_CHARACTERS =
  TURN_EVENT_STRUCTURAL_CODEC_CAPS.maximumShortTextCharacters;
const MAX_CONTENT_BLOCKS = TURN_EVENT_STRUCTURAL_CODEC_CAPS.maximumContentBlocks;
const MAX_PLAN_ENTRIES = TURN_EVENT_STRUCTURAL_CODEC_CAPS.maximumPlanEntries;
const MAX_INTERACTION_OPTIONS =
  TURN_EVENT_STRUCTURAL_CODEC_CAPS.maximumInteractionOptions;

function optional<Value>(
  object: Record<string, unknown>,
  field: string,
  decode: (input: unknown, path: CodecPath) => Value,
  path: CodecPath,
): Value | undefined {
  return Object.hasOwn(object, field)
    ? decode(object[field], at(path, field))
    : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function decodeProtocolString(
  input: unknown,
  path: CodecPath,
): string {
  const value = decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: 256,
      pattern:
        /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,254}[A-Za-z0-9])?$/u,
      label: "protocol identifier",
    },
    path,
  );
  assertSecretFreeJsonValue(value, { forbiddenPaths: "all" }, path);
  return value;
}

function decodeSanitizedString(
  input: unknown,
  options: {
    readonly minimumLength?: number;
    readonly maximumLength: number;
    readonly label: string;
  },
  path: CodecPath,
): string {
  const value = decodeBoundedString(input, options, path);
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    codecFail(path, "invalid-format", `${options.label} contains a control character`);
  }
  assertSecretFreeJsonValue(value, { forbiddenPaths: "all" }, path);
  return value;
}

function decodeDisplayName(input: unknown, path: CodecPath): string {
  const value = decodeSanitizedString(
    input,
    { minimumLength: 1, maximumLength: 255, label: "display name" },
    path,
  );
  if (
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    codecFail(path, "forbidden-path", "display name must be a basename, not a path");
  }
  return value;
}

export function decodeTurnContentBlock(
  input: unknown,
  path: CodecPath = [],
): TurnContentBlock {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "text":
      requireExactFields(object, ["kind", "text"], [], path);
      return {
        kind,
        text: decodeBoundedString(
          object.text,
          { maximumLength: MAX_TEXT_CHARACTERS, label: "Turn text" },
          at(path, "text"),
        ),
      };
    case "attachment":
      requireExactFields(
        object,
        ["kind", "attachmentId", "mediaType", "mimeType"],
        ["displayName"],
        path,
      );
      return compact({
        kind,
        attachmentId: decodeServiceId(
          "Attachment",
          object.attachmentId,
          at(path, "attachmentId"),
        ),
        mediaType: decodeLiteral(
          object.mediaType,
          "image",
          at(path, "mediaType"),
        ),
        mimeType: decodeAgentImageMimeType(
          object.mimeType,
          at(path, "mimeType"),
        ),
        displayName: optional(
          object,
          "displayName",
          (value, fieldPath) =>
            decodeDisplayName(value, fieldPath),
          path,
        ),
      }) as TurnContentBlock;
    case "workspace-resource-link":
      requireExactFields(
        object,
        ["kind", "resourceId", "sandboxPath"],
        ["mimeType"],
        path,
      );
      return compact({
        kind,
        resourceId: decodeServiceId(
          "WorkspaceResource",
          object.resourceId,
          at(path, "resourceId"),
        ),
        sandboxPath: decodeSandboxPath(object.sandboxPath, at(path, "sandboxPath")),
        mimeType: optional(
          object,
          "mimeType",
          (value, fieldPath) =>
            decodeMimeType(value, fieldPath),
          path,
        ),
      }) as TurnContentBlock;
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported Turn content kind ${JSON.stringify(kind)}`,
      );
  }
}

function decodeContentBlocks(
  input: unknown,
  path: CodecPath,
): readonly TurnContentBlock[] {
  return decodeBoundedArray(
    input,
    decodeTurnContentBlock,
    { maximumItems: MAX_CONTENT_BLOCKS },
    path,
  );
}

function decodePlanEntry(
  input: unknown,
  path: CodecPath = [],
): TurnPlanEntry {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["content", "status", "priority"], [], path);
  return {
    content: decodeBoundedString(
      object.content,
      {
        minimumLength: 1,
        maximumLength: MAX_SHORT_TEXT_CHARACTERS,
        label: "plan entry",
      },
      at(path, "content"),
    ),
    status: decodeEnum(
      object.status,
      ["pending", "in-progress", "completed"] as const,
      at(path, "status"),
    ),
    priority: decodeEnum(
      object.priority,
      ["low", "medium", "high"] as const,
      at(path, "priority"),
    ),
  };
}

function decodeTurnUsage(
  input: unknown,
  path: CodecPath = [],
): TurnUsage {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["scope"],
    [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "contextUsedTokens",
      "contextSizeTokens",
      "cost",
    ],
    path,
  );
  const cost = optional(
    object,
    "cost",
    (value, costPath) => {
      const costObject = decodePlainObject(value, costPath);
      requireExactFields(costObject, ["amount", "currency"], [], costPath);
      if (
        typeof costObject.amount !== "number" ||
        !Number.isFinite(costObject.amount) ||
        costObject.amount < 0
      ) {
        codecFail(at(costPath, "amount"), "out-of-range", "cost must be finite and non-negative");
      }
      return {
        // Preserve canonical JSON numeric semantics: `-0` is represented as 0
        // at every persisted/event boundary.
        amount: Object.is(costObject.amount, -0) ? 0 : costObject.amount,
        currency: decodeBoundedString(
          costObject.currency,
          {
            minimumLength: 3,
            maximumLength: 3,
            pattern: /^[A-Z]{3}$/u,
            label: "currency",
          },
          at(costPath, "currency"),
        ),
      };
    },
    path,
  );
  return compact({
    scope: decodeEnum(object.scope, ["turn", "session"] as const, at(path, "scope")),
    inputTokens: optional(object, "inputTokens", decodeNonNegativeSafeInteger, path),
    outputTokens: optional(object, "outputTokens", decodeNonNegativeSafeInteger, path),
    totalTokens: optional(object, "totalTokens", decodeNonNegativeSafeInteger, path),
    contextUsedTokens: optional(
      object,
      "contextUsedTokens",
      decodeNonNegativeSafeInteger,
      path,
    ),
    contextSizeTokens: optional(
      object,
      "contextSizeTokens",
      decodeNonNegativeSafeInteger,
      path,
    ),
    cost,
  }) as TurnUsage;
}

function decodePromptAcceptanceEvidence(
  input: unknown,
  path: CodecPath = [],
): PromptAcceptanceEvidence {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (kind === "explicit-ack" || kind === "terminal-response") {
    requireExactFields(object, ["kind", "correlation"], [], path);
    return {
      kind,
      correlation: decodeLiteral(
        object.correlation,
        "dispatched-prompt-request",
        at(path, "correlation"),
      ),
    };
  }
  if (kind === "attributable-turn-event") {
    requireExactFields(object, ["kind", "eventKind", "correlation"], [], path);
    return {
      kind,
      eventKind: decodeEnum(
        object.eventKind,
        [
          "user-message-recorded",
          "agent-message",
          "agent-progress",
          "agent-plan",
          "tool-call",
          "interaction-request",
          "state-running",
        ] as const,
        at(path, "eventKind"),
      ),
      correlation: decodeLiteral(
        object.correlation,
        "driver-guaranteed",
        at(path, "correlation"),
      ),
    };
  }
  codecFail(
    at(path, "kind"),
    "unsupported-discriminant",
    `unsupported prompt evidence ${JSON.stringify(kind)}`,
  );
}

const CANCELLATION_REASONS = [
  "withdrawn-by-requester",
  "cancelled-by-controller",
  "authority-revoked",
  "configuration-authority-revoked",
  "credential-revoked",
  "binding-revoked",
  "unsafe-agent-permission-options",
  "session-stopped",
  "shutdown",
] as const;

function decodeAuditActorRef(
  input: unknown,
  path: CodecPath = [],
): AuditActorRef {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "bootstrap":
      requireExactFields(object, ["kind"], [], path);
      return { kind };
    case "principal":
      requireExactFields(object, ["kind", "principalId"], [], path);
      return {
        kind,
        principalId: decodeServiceId(
          "Principal",
          object.principalId,
          at(path, "principalId"),
        ),
      };
    case "system":
      requireExactFields(object, ["kind", "component"], [], path);
      return {
        kind,
        component: decodeEnum(
          object.component,
          [
            "application",
            "authorization",
            "bootstrap",
            "broker",
            "delivery",
            "local-connector",
            "recovery",
            "sidecar",
            "supervisor",
            "turn-coordinator",
          ] as const,
          at(path, "component"),
        ),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported audit actor ${JSON.stringify(kind)}`,
      );
  }
}

function decodeAuthenticatedPrincipal(
  input: unknown,
  path: CodecPath = [],
): AuthenticatedPrincipal {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    [
      "kind",
      "principalId",
      "identityBindingId",
      "method",
      "assurance",
      "requestId",
      "authenticatedAt",
    ],
    [],
    path,
  );
  return {
    kind: decodeLiteral(
      object.kind,
      "authenticated-principal",
      at(path, "kind"),
    ),
    principalId: decodeServiceId(
      "Principal",
      object.principalId,
      at(path, "principalId"),
    ),
    identityBindingId: decodeServiceId(
      "IdentityBinding",
      object.identityBindingId,
      at(path, "identityBindingId"),
    ),
    method: decodeEnum(
      object.method,
      ["connector", "local-peer"] as const,
      at(path, "method"),
    ),
    assurance: decodeEnum(
      object.assurance,
      ["normal", "elevated"] as const,
      at(path, "assurance"),
    ),
    requestId: decodeServiceId(
      "AuthenticationRequest",
      object.requestId,
      at(path, "requestId"),
    ),
    authenticatedAt: decodeIsoTimestamp(
      object.authenticatedAt,
      at(path, "authenticatedAt"),
    ),
  };
}

function decodeTurnFailure(
  input: unknown,
  path: CodecPath = [],
): TurnFailure {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["code"], ["detail"], path);
  return compact({
    code: decodeEnum(
      object.code,
      [
        "sandbox-unavailable",
        "credential-unavailable",
        "driver-rejected",
        "driver-error",
        "worker-lost-before-dispatch",
        "invalid-agent-event",
      ] as const,
      at(path, "code"),
    ),
    detail: optional(
      object,
      "detail",
      (value, fieldPath) =>
        decodeSanitizedString(
          value,
          {
            minimumLength: 1,
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "failure detail",
          },
          fieldPath,
        ),
      path,
    ),
  }) as TurnFailure;
}

export function decodeTurnResult(
  input: unknown,
  path: CodecPath = [],
): TurnResult {
  const object = decodePlainObject(input, path);
  const outcome = decodeString(object.outcome, at(path, "outcome"));
  switch (outcome) {
    case "completed":
    case "refused":
      requireExactFields(object, ["outcome"], [], path);
      return { outcome };
    case "limited":
      requireExactFields(object, ["outcome", "reason"], [], path);
      return {
        outcome,
        reason: decodeEnum(
          object.reason,
          ["max-tokens", "max-model-requests", "output-limit"] as const,
          at(path, "reason"),
        ),
      };
    case "cancelled":
      requireExactFields(object, ["outcome", "reason"], [], path);
      return {
        outcome,
        reason: decodeEnum(object.reason, CANCELLATION_REASONS, at(path, "reason")),
      };
    case "timed-out":
      requireExactFields(object, ["outcome", "reason"], [], path);
      return {
        outcome,
        reason: decodeEnum(
          object.reason,
          ["active-work", "agent-stall", "tool-stall"] as const,
          at(path, "reason"),
        ),
      };
    case "policy-denied":
      requireExactFields(object, ["outcome", "reason"], [], path);
      return {
        outcome,
        reason: decodeBoundedString(
          object.reason,
          {
            minimumLength: 1,
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "denial reason",
          },
          at(path, "reason"),
        ),
      };
    case "failed":
      requireExactFields(object, ["outcome", "failure"], [], path);
      return {
        outcome,
        failure: decodeTurnFailure(object.failure, at(path, "failure")),
      };
    case "unknown":
      requireExactFields(object, ["outcome", "reason"], [], path);
      return {
        outcome,
        reason: decodeLiteral(
          object.reason,
          "worker-lost-after-dispatch",
          at(path, "reason"),
        ),
      };
    default:
      codecFail(
        at(path, "outcome"),
        "unsupported-discriminant",
        `unsupported Turn result ${JSON.stringify(outcome)}`,
      );
  }
}

function decodeTurnLifecycleState(
  input: unknown,
  path: CodecPath = [],
): TurnLifecycleState {
  const object = decodePlainObject(input, path);
  const status = decodeString(object.status, at(path, "status"));
  switch (status) {
    case "queued":
      requireExactFields(object, ["status"], [], path);
      return { status };
    case "dispatching":
      requireExactFields(
        object,
        ["status", "attemptId", "attempt", "startedAt"],
        [],
        path,
      );
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        attempt: decodePositiveSafeInteger(object.attempt, at(path, "attempt")),
        startedAt: decodeIsoTimestamp(object.startedAt, at(path, "startedAt")),
      };
    case "submission-armed":
      requireExactFields(
        object,
        ["status", "attemptId", "attempt", "armedAt"],
        [],
        path,
      );
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        attempt: decodePositiveSafeInteger(object.attempt, at(path, "attempt")),
        armedAt: decodeIsoTimestamp(object.armedAt, at(path, "armedAt")),
      };
    case "submitted-unconfirmed":
      requireExactFields(
        object,
        ["status", "attemptId", "attempt", "submittedAt"],
        [],
        path,
      );
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        attempt: decodePositiveSafeInteger(object.attempt, at(path, "attempt")),
        submittedAt: decodeIsoTimestamp(
          object.submittedAt,
          at(path, "submittedAt"),
        ),
      };
    case "accepted":
      requireExactFields(
        object,
        ["status", "attemptId", "acceptedAt", "evidence"],
        [],
        path,
      );
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        acceptedAt: decodeIsoTimestamp(object.acceptedAt, at(path, "acceptedAt")),
        evidence: decodePromptAcceptanceEvidence(
          object.evidence,
          at(path, "evidence"),
        ),
      };
    case "running":
      requireExactFields(object, ["status", "attemptId", "startedAt"], [], path);
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        startedAt: decodeIsoTimestamp(object.startedAt, at(path, "startedAt")),
      };
    case "waiting-for-approval":
    case "waiting-for-input":
      requireExactFields(
        object,
        ["status", "attemptId", "interactionId", "waitingSince"],
        [],
        path,
      );
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        interactionId: decodeServiceId(
          "TurnInteraction",
          object.interactionId,
          at(path, "interactionId"),
        ),
        waitingSince: decodeIsoTimestamp(
          object.waitingSince,
          at(path, "waitingSince"),
        ),
      };
    case "cancelling":
      requireExactFields(
        object,
        ["status", "attemptId", "requestedAt", "requestedBy", "reason"],
        [],
        path,
      );
      return {
        status,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          object.attemptId,
          at(path, "attemptId"),
        ),
        requestedAt: decodeIsoTimestamp(
          object.requestedAt,
          at(path, "requestedAt"),
        ),
        requestedBy: decodeAuditActorRef(
          object.requestedBy,
          at(path, "requestedBy"),
        ),
        reason: decodeEnum(object.reason, CANCELLATION_REASONS, at(path, "reason")),
      };
    case "terminal":
      requireExactFields(
        object,
        ["status", "completedAt", "result", "partialOutputAvailable"],
        [],
        path,
      );
      return {
        status,
        completedAt: decodeIsoTimestamp(
          object.completedAt,
          at(path, "completedAt"),
        ),
        result: decodeTurnResult(object.result, at(path, "result")),
        partialOutputAvailable: decodeBoolean(
          object.partialOutputAvailable,
          at(path, "partialOutputAvailable"),
        ),
      };
    default:
      codecFail(
        at(path, "status"),
        "unsupported-discriminant",
        `unsupported Turn lifecycle status ${JSON.stringify(status)}`,
      );
  }
}

function decodeTurnReasoningSelection(
  input: unknown,
  path: CodecPath = [],
): TurnReasoningSelection {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (kind === "agent-default") {
    requireExactFields(object, ["kind"], [], path);
    return { kind };
  }
  if (kind === "effort") {
    requireExactFields(object, ["kind", "effort"], [], path);
    return {
      kind,
      effort: decodeEnum(
        object.effort,
        ["none", "low", "medium", "high"] as const,
        at(path, "effort"),
      ),
    };
  }
  codecFail(
    at(path, "kind"),
    "unsupported-discriminant",
    `unsupported reasoning selection ${JSON.stringify(kind)}`,
  );
}

function decodeTurnInferenceResolution(
  input: unknown,
  path: CodecPath = [],
): TurnInferenceResolution {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["turnId", "model", "reasoning", "resolvedBy", "resolvedAt"],
    [],
    path,
  );
  const model = decodePlainObject(object.model, at(path, "model"));
  requireExactFields(
    model,
    ["providerId", "modelId"],
    [],
    at(path, "model"),
  );
  return {
    turnId: decodeServiceId("Turn", object.turnId, at(path, "turnId")),
    model: {
      providerId: decodeServiceId(
        "Provider",
        model.providerId,
        at(at(path, "model"), "providerId"),
      ),
      modelId: decodeServiceId(
        "Model",
        model.modelId,
        at(at(path, "model"), "modelId"),
      ),
    },
    reasoning: decodeTurnReasoningSelection(
      object.reasoning,
      at(path, "reasoning"),
    ),
    resolvedBy: decodeEnum(
      object.resolvedBy,
      ["hitch", "agent"] as const,
      at(path, "resolvedBy"),
    ),
    resolvedAt: decodeIsoTimestamp(object.resolvedAt, at(path, "resolvedAt")),
  };
}

function decodeAgentPermissionOption(
  input: unknown,
  path: CodecPath = [],
): AgentPermissionOption {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    [
      "protocolOptionId",
      "protocolKind",
      "sanitizedLabel",
      "advertisedDisposition",
    ],
    [],
    path,
  );
  return {
    protocolOptionId: decodeProtocolString(
      object.protocolOptionId,
      at(path, "protocolOptionId"),
    ) as AgentPermissionOption["protocolOptionId"],
    protocolKind: decodeProtocolString(
      object.protocolKind,
      at(path, "protocolKind"),
    ) as AgentPermissionOption["protocolKind"],
    sanitizedLabel: decodeSanitizedString(
      object.sanitizedLabel,
      {
        minimumLength: 1,
        maximumLength: 512,
        label: "sanitized option label",
      },
      at(path, "sanitizedLabel"),
    ),
    advertisedDisposition: decodeEnum(
      object.advertisedDisposition,
      [
        "allow-once",
        "allow-persistent",
        "deny-once",
        "deny-persistent",
        "unknown",
      ] as const,
      at(path, "advertisedDisposition"),
    ),
  };
}

function decodeAllowOnceResponse(
  input: unknown,
  path: CodecPath = [],
): TurnApprovalAllowOnceAgentResponse {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (kind === "select-advertised-option") {
    requireExactFields(object, ["kind", "option"], [], path);
    const option = decodeAgentPermissionOption(object.option, at(path, "option"));
    if (option.advertisedDisposition !== "allow-once") {
      codecFail(
        at(at(path, "option"), "advertisedDisposition"),
        "invalid-format",
        "allow-once response must select an allow-once option",
      );
    }
    return {
      kind,
      option: option as TurnApprovalAllowOnceAgentResponse extends {
        readonly kind: "select-advertised-option";
        readonly option: infer Option;
      }
        ? Option
        : never,
    };
  }
  if (kind === "driver-mediated") {
    requireExactFields(
      object,
      ["kind", "mediationId", "guaranteedDisposition", "guarantee"],
      [],
      path,
    );
    return {
      kind,
      mediationId: decodeServiceId(
        "AgentDriverPermissionMediation",
        object.mediationId,
        at(path, "mediationId"),
      ),
      guaranteedDisposition: decodeLiteral(
        object.guaranteedDisposition,
        "allow-once",
        at(path, "guaranteedDisposition"),
      ),
      guarantee: decodeLiteral(
        object.guarantee,
        "one-tool-invocation",
        at(path, "guarantee"),
      ),
    };
  }
  codecFail(
    at(path, "kind"),
    "unsupported-discriminant",
    `unsupported allow response ${JSON.stringify(kind)}`,
  );
}

function decodeDenyOnceResponse(
  input: unknown,
  path: CodecPath = [],
): TurnApprovalDenyOnceAgentResponse {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (kind === "select-advertised-option") {
    requireExactFields(object, ["kind", "option"], [], path);
    const option = decodeAgentPermissionOption(object.option, at(path, "option"));
    if (option.advertisedDisposition !== "deny-once") {
      codecFail(
        at(at(path, "option"), "advertisedDisposition"),
        "invalid-format",
        "deny response must select a deny-once option",
      );
    }
    return {
      kind,
      option: option as TurnApprovalDenyOnceAgentResponse extends {
        readonly kind: "select-advertised-option";
        readonly option: infer Option;
      }
        ? Option
        : never,
    };
  }
  if (kind === "driver-mediated") {
    requireExactFields(
      object,
      ["kind", "mediationId", "guaranteedDisposition", "guarantee"],
      [],
      path,
    );
    return {
      kind,
      mediationId: decodeServiceId(
        "AgentDriverPermissionMediation",
        object.mediationId,
        at(path, "mediationId"),
      ),
      guaranteedDisposition: decodeLiteral(
        object.guaranteedDisposition,
        "deny-once",
        at(path, "guaranteedDisposition"),
      ),
      guarantee: decodeLiteral(
        object.guarantee,
        "one-tool-invocation",
        at(path, "guarantee"),
      ),
    };
  }
  codecFail(
    at(path, "kind"),
    "unsupported-discriminant",
    `unsupported deny response ${JSON.stringify(kind)}`,
  );
}

function decodeTurnApprovalOption(
  input: unknown,
  path: CodecPath = [],
): TurnApprovalOption {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["id", "sanitizedLabel", "normalizedDecision", "agentResponse"],
    [],
    path,
  );
  const normalizedDecision = decodeEnum(
    object.normalizedDecision,
    ["allow-once", "deny"] as const,
    at(path, "normalizedDecision"),
  );
  const common = {
    id: decodeServiceId(
      "TurnInteractionOption",
      object.id,
      at(path, "id"),
    ),
    sanitizedLabel: decodeSanitizedString(
      object.sanitizedLabel,
      { minimumLength: 1, maximumLength: 512, label: "sanitized option label" },
      at(path, "sanitizedLabel"),
    ),
  };
  return normalizedDecision === "allow-once"
    ? {
        ...common,
        normalizedDecision,
        agentResponse: decodeAllowOnceResponse(
          object.agentResponse,
          at(path, "agentResponse"),
        ),
      }
    : {
        ...common,
        normalizedDecision,
        agentResponse: decodeDenyOnceResponse(
          object.agentResponse,
          at(path, "agentResponse"),
        ),
      };
}

function decodeApprovalRequest(
  object: Record<string, unknown>,
  path: CodecPath,
): TurnApprovalInteractionRequest {
  requireExactFields(
    object,
    [
      "kind",
      "toolInvocationId",
      "title",
      "advertisedAgentOptions",
      "options",
    ],
    ["sanitizedDescription"],
    path,
  );
  const advertisedAgentOptions = decodeBoundedArray(
    object.advertisedAgentOptions,
    decodeAgentPermissionOption,
    {
      maximumItems: MAX_INTERACTION_OPTIONS,
      uniqueBy: (option) => option.protocolOptionId,
    },
    at(path, "advertisedAgentOptions"),
  );
  const options = decodeBoundedArray(
    object.options,
    decodeTurnApprovalOption,
    {
      maximumItems: MAX_INTERACTION_OPTIONS,
      uniqueBy: (option) => option.id,
    },
    at(path, "options"),
  );
  const selectedProtocolOptionIds = new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    if (option.agentResponse.kind !== "select-advertised-option") continue;
    const selected = option.agentResponse.option;
    const advertised = advertisedAgentOptions.find(
      (candidate) => candidate.protocolOptionId === selected.protocolOptionId,
    );
    const selectionPath = at(
      at(at(path, "options"), index),
      "agentResponse",
    );
    if (
      advertised === undefined ||
      advertised.protocolKind !== selected.protocolKind ||
      advertised.sanitizedLabel !== selected.sanitizedLabel ||
      advertised.advertisedDisposition !== selected.advertisedDisposition
    ) {
      codecFail(
        at(selectionPath, "option"),
        "invalid-format",
        "selectable response must exactly match one advertised agent option",
      );
    }
    if (selectedProtocolOptionIds.has(selected.protocolOptionId)) {
      codecFail(
        at(selectionPath, "option"),
        "duplicate-item",
        "an advertised agent option may be selected only once",
      );
    }
    selectedProtocolOptionIds.add(selected.protocolOptionId);
  }
  return compact({
    kind: decodeLiteral(object.kind, "approval", at(path, "kind")),
    toolInvocationId: decodeServiceId(
      "ToolInvocation",
      object.toolInvocationId,
      at(path, "toolInvocationId"),
    ),
    title: decodeSanitizedString(
      object.title,
      { minimumLength: 1, maximumLength: 512, label: "interaction title" },
      at(path, "title"),
    ),
    sanitizedDescription: optional(
      object,
      "sanitizedDescription",
      (value, fieldPath) =>
        decodeSanitizedString(
          value,
          {
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "sanitized description",
          },
          fieldPath,
        ),
      path,
    ),
    advertisedAgentOptions,
    options,
  }) as TurnApprovalInteractionRequest;
}

function decodeInputRequest(
  object: Record<string, unknown>,
  path: CodecPath,
): TurnInputInteractionRequest {
  requireExactFields(
    object,
    ["kind", "sanitizedPrompt"],
    ["responseSchema"],
    path,
  );
  return compact({
    kind: decodeLiteral(object.kind, "input", at(path, "kind")),
    sanitizedPrompt: decodeSanitizedString(
      object.sanitizedPrompt,
      {
        minimumLength: 1,
        maximumLength: MAX_SHORT_TEXT_CHARACTERS,
        label: "input prompt",
      },
      at(path, "sanitizedPrompt"),
    ),
    responseSchema: optional(
      object,
      "responseSchema",
      (value, fieldPath) =>
        decodeSecretFreeJsonObject(
          value,
          { forbiddenPaths: "all" },
          fieldPath,
        ),
      path,
    ),
  }) as TurnInputInteractionRequest;
}

export function decodeTurnInteractionRequest(
  input: unknown,
  path: CodecPath = [],
): TurnInteractionRequest {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (kind === "approval") return decodeApprovalRequest(object, path);
  if (kind === "input") return decodeInputRequest(object, path);
  codecFail(
    at(path, "kind"),
    "unsupported-discriminant",
    `unsupported interaction request ${JSON.stringify(kind)}`,
  );
}

function decodeApprovalAuthorization(
  input: unknown,
  path: CodecPath,
): TurnApprovalAuthorization {
  const object = decodePlainObject(input, path);
  const reason = decodeEnum(
    object.reason,
    ["session-owner", "role-grant"] as const,
    at(path, "reason"),
  );
  requireExactFields(
    object,
    ["basis", "decision", "reason", "evaluatedAt"],
    reason === "role-grant" ? ["supportingGrantId"] : [],
    path,
  );
  if (reason === "role-grant" && !Object.hasOwn(object, "supportingGrantId")) {
    codecFail(
      at(path, "supportingGrantId"),
      "invalid-type",
      "role-grant authorization requires supportingGrantId",
    );
  }
  const common = {
    basis: decodeLiteral(object.basis, "session.approve", at(path, "basis")),
    decision: decodeLiteral(object.decision, "allowed", at(path, "decision")),
    evaluatedAt: decodeIsoTimestamp(
      object.evaluatedAt,
      at(path, "evaluatedAt"),
    ),
  };
  return reason === "role-grant"
    ? {
        ...common,
        reason,
        supportingGrantId: decodeServiceId(
          "AccessGrant",
          object.supportingGrantId,
          at(path, "supportingGrantId"),
        ),
      }
    : { ...common, reason };
}

function decodeApprovalResolution(
  input: unknown,
  path: CodecPath = [],
): TurnApprovalInteractionResolution {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "approval-by-policy":
      requireExactFields(
        object,
        ["kind", "executionPolicySnapshotId", "selectedOption", "reason"],
        [],
        path,
      );
      return {
        kind,
        executionPolicySnapshotId: decodeServiceId(
          "ExecutionPolicySnapshot",
          object.executionPolicySnapshotId,
          at(path, "executionPolicySnapshotId"),
        ),
        selectedOption: decodeTurnApprovalOption(
          object.selectedOption,
          at(path, "selectedOption"),
        ),
        reason: decodeBoundedString(
          object.reason,
          {
            minimumLength: 1,
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "approval reason",
          },
          at(path, "reason"),
        ),
      };
    case "approval-by-principal": {
      requireExactFields(
        object,
        ["kind", "resolver", "selectedOption"],
        [],
        path,
      );
      const resolverPath = at(path, "resolver");
      const resolver = decodePlainObject(object.resolver, resolverPath);
      requireExactFields(
        resolver,
        ["actor", "authorization"],
        [],
        resolverPath,
      );
      return {
        kind,
        resolver: {
          actor: decodeAuthenticatedPrincipal(
            resolver.actor,
            at(resolverPath, "actor"),
          ),
          authorization: decodeApprovalAuthorization(
            resolver.authorization,
            at(resolverPath, "authorization"),
          ),
        },
        selectedOption: decodeTurnApprovalOption(
          object.selectedOption,
          at(path, "selectedOption"),
        ),
      };
    }
    case "approval-timed-out":
      requireExactFields(
        object,
        ["kind", "agentOutcome", "agentResponse"],
        [],
        path,
      );
      return {
        kind,
        agentOutcome: decodeLiteral(
          object.agentOutcome,
          "deny",
          at(path, "agentOutcome"),
        ),
        agentResponse: decodeDenyOnceResponse(
          object.agentResponse,
          at(path, "agentResponse"),
        ),
      };
    case "approval-cancelled":
      requireExactFields(object, ["kind", "reason"], [], path);
      return {
        kind,
        reason: decodeEnum(object.reason, CANCELLATION_REASONS, at(path, "reason")),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported approval resolution ${JSON.stringify(kind)}`,
      );
  }
}

function decodeInputResolution(
  input: unknown,
  path: CodecPath = [],
): TurnInputInteractionResolution {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "input-by-originator": {
      requireExactFields(object, ["kind", "resolver", "responseId"], [], path);
      const resolverPath = at(path, "resolver");
      const resolver = decodePlainObject(object.resolver, resolverPath);
      requireExactFields(
        resolver,
        ["actor", "authorization"],
        [],
        resolverPath,
      );
      const authorizationPath = at(resolverPath, "authorization");
      const authorization = decodePlainObject(
        resolver.authorization,
        authorizationPath,
      );
      requireExactFields(
        authorization,
        ["basis", "decision", "reason", "evaluatedAt"],
        [],
        authorizationPath,
      );
      return {
        kind,
        resolver: {
          actor: decodeAuthenticatedPrincipal(
            resolver.actor,
            at(resolverPath, "actor"),
          ),
          authorization: {
            basis: decodeLiteral(
              authorization.basis,
              "turn-requester",
              at(authorizationPath, "basis"),
            ),
            decision: decodeLiteral(
              authorization.decision,
              "allowed",
              at(authorizationPath, "decision"),
            ),
            reason: decodeLiteral(
              authorization.reason,
              "turn-requester",
              at(authorizationPath, "reason"),
            ),
            evaluatedAt: decodeIsoTimestamp(
              authorization.evaluatedAt,
              at(authorizationPath, "evaluatedAt"),
            ),
          },
        },
        responseId: decodeServiceId(
          "TurnInteractionResponse",
          object.responseId,
          at(path, "responseId"),
        ),
      };
    }
    case "input-timed-out":
      requireExactFields(object, ["kind", "agentOutcome"], [], path);
      return {
        kind,
        agentOutcome: decodeLiteral(
          object.agentOutcome,
          "no-input",
          at(path, "agentOutcome"),
        ),
      };
    case "input-cancelled":
      requireExactFields(object, ["kind", "reason"], [], path);
      return {
        kind,
        reason: decodeEnum(object.reason, CANCELLATION_REASONS, at(path, "reason")),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported input resolution ${JSON.stringify(kind)}`,
      );
  }
}

function decodeMessageChunk(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "agent-message-chunk" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "messageId", "content"],
    ["protocolMessageId"],
    path,
  );
  return compact({
    kind: decodeLiteral(object.kind, "agent-message-chunk", at(path, "kind")),
    messageId: decodeServiceId(
      "TurnMessage",
      object.messageId,
      at(path, "messageId"),
    ),
    protocolMessageId: optional(
      object,
      "protocolMessageId",
      decodeProtocolString,
      path,
    ),
    content: decodeTurnContentBlock(object.content, at(path, "content")),
  }) as Extract<TurnEventPayload, { readonly kind: "agent-message-chunk" }>;
}

function decodeProgressChunk(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "agent-progress-chunk" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "content"], [], path);
  return {
    kind: decodeLiteral(object.kind, "agent-progress-chunk", at(path, "kind")),
    content: decodeTurnContentBlock(object.content, at(path, "content")),
  };
}

function decodePlan(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "plan" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "entries"], [], path);
  return {
    kind: decodeLiteral(object.kind, "plan", at(path, "kind")),
    entries: decodeBoundedArray(
      object.entries,
      decodePlanEntry,
      { maximumItems: MAX_PLAN_ENTRIES },
      at(path, "entries"),
    ),
  };
}

function decodeToolUpdate(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "tool-invocation-update" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "toolInvocationId", "title", "status"],
    ["protocolToolCallId", "sanitizedSummary"],
    path,
  );
  return compact({
    kind: decodeLiteral(
      object.kind,
      "tool-invocation-update",
      at(path, "kind"),
    ),
    toolInvocationId: decodeServiceId(
      "ToolInvocation",
      object.toolInvocationId,
      at(path, "toolInvocationId"),
    ),
    protocolToolCallId: optional(
      object,
      "protocolToolCallId",
      decodeProtocolString,
      path,
    ),
    title: decodeSanitizedString(
      object.title,
      { minimumLength: 1, maximumLength: 512, label: "tool title" },
      at(path, "title"),
    ),
    status: decodeEnum(
      object.status,
      ["pending", "in-progress"] as const,
      at(path, "status"),
    ),
    sanitizedSummary: optional(
      object,
      "sanitizedSummary",
      (value, fieldPath) =>
        decodeSanitizedString(
          value,
          {
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "sanitized tool summary",
          },
          fieldPath,
        ),
      path,
    ),
  }) as Extract<TurnEventPayload, { readonly kind: "tool-invocation-update" }>;
}

function decodeUsageUpdate(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "usage-update" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "usage"], [], path);
  return {
    kind: decodeLiteral(object.kind, "usage-update", at(path, "kind")),
    usage: decodeTurnUsage(object.usage, at(path, "usage")),
  };
}

function decodeStateTransition(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "state-transition" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "from", "to"], [], path);
  return {
    kind: decodeLiteral(object.kind, "state-transition", at(path, "kind")),
    from: decodeTurnLifecycleState(object.from, at(path, "from")),
    to: decodeTurnLifecycleState(object.to, at(path, "to")),
  };
}

function decodePromptAccepted(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "prompt-accepted" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "evidence"], [], path);
  return {
    kind: decodeLiteral(object.kind, "prompt-accepted", at(path, "kind")),
    evidence: decodePromptAcceptanceEvidence(
      object.evidence,
      at(path, "evidence"),
    ),
  };
}

function decodeInferenceResolved(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "inference-resolved" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "resolution"], [], path);
  return {
    kind: decodeLiteral(object.kind, "inference-resolved", at(path, "kind")),
    resolution: decodeTurnInferenceResolution(
      object.resolution,
      at(path, "resolution"),
    ),
  };
}

function decodeUserMessageRecorded(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "user-message-recorded" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind"], ["protocolMessageId"], path);
  return compact({
    kind: decodeLiteral(
      object.kind,
      "user-message-recorded",
      at(path, "kind"),
    ),
    protocolMessageId: optional(
      object,
      "protocolMessageId",
      decodeProtocolString,
      path,
    ),
  }) as Extract<TurnEventPayload, { readonly kind: "user-message-recorded" }>;
}

function decodeAgentMessageFinalized(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "agent-message-finalized" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "messageId", "content"], [], path);
  return {
    kind: decodeLiteral(
      object.kind,
      "agent-message-finalized",
      at(path, "kind"),
    ),
    messageId: decodeServiceId(
      "TurnMessage",
      object.messageId,
      at(path, "messageId"),
    ),
    content: decodeContentBlocks(object.content, at(path, "content")),
  };
}

function decodeToolFinalized(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "tool-invocation-finalized" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "toolInvocationId", "title", "status"],
    ["protocolToolCallId", "sanitizedSummary"],
    path,
  );
  return compact({
    kind: decodeLiteral(
      object.kind,
      "tool-invocation-finalized",
      at(path, "kind"),
    ),
    toolInvocationId: decodeServiceId(
      "ToolInvocation",
      object.toolInvocationId,
      at(path, "toolInvocationId"),
    ),
    protocolToolCallId: optional(
      object,
      "protocolToolCallId",
      decodeProtocolString,
      path,
    ),
    title: decodeSanitizedString(
      object.title,
      { minimumLength: 1, maximumLength: 512, label: "tool title" },
      at(path, "title"),
    ),
    status: decodeEnum(
      object.status,
      ["completed", "failed", "cancelled"] as const,
      at(path, "status"),
    ),
    sanitizedSummary: optional(
      object,
      "sanitizedSummary",
      (value, fieldPath) =>
        decodeSanitizedString(
          value,
          {
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "sanitized tool summary",
          },
          fieldPath,
        ),
      path,
    ),
  }) as Extract<TurnEventPayload, { readonly kind: "tool-invocation-finalized" }>;
}

function decodeInteractionRequested(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "interaction-requested" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "interactionId", "request"], [], path);
  return {
    kind: decodeLiteral(
      object.kind,
      "interaction-requested",
      at(path, "kind"),
    ),
    interactionId: decodeServiceId(
      "TurnInteraction",
      object.interactionId,
      at(path, "interactionId"),
    ),
    request: decodeTurnInteractionRequest(object.request, at(path, "request")),
  };
}

function decodeInteractionResolved(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "interaction-resolved" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "interactionId", "interactionKind", "resolution"],
    [],
    path,
  );
  const interactionKind = decodeEnum(
    object.interactionKind,
    ["approval", "input"] as const,
    at(path, "interactionKind"),
  );
  const common = {
    kind: decodeLiteral(
      object.kind,
      "interaction-resolved",
      at(path, "kind"),
    ),
    interactionId: decodeServiceId(
      "TurnInteraction",
      object.interactionId,
      at(path, "interactionId"),
    ),
  };
  return interactionKind === "approval"
    ? {
        ...common,
        interactionKind,
        resolution: decodeApprovalResolution(
          object.resolution,
          at(path, "resolution"),
        ),
      }
    : {
        ...common,
        interactionKind,
        resolution: decodeInputResolution(
          object.resolution,
          at(path, "resolution"),
        ),
      };
}

function decodeUsageFinalized(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "usage-finalized" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "usage"], [], path);
  return {
    kind: decodeLiteral(object.kind, "usage-finalized", at(path, "kind")),
    usage: decodeTurnUsage(object.usage, at(path, "usage")),
  };
}

function decodeTerminal(
  input: unknown,
  path: CodecPath = [],
): Extract<TurnEventPayload, { readonly kind: "terminal" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "result", "partialOutputAvailable"],
    [],
    path,
  );
  return {
    kind: decodeLiteral(object.kind, "terminal", at(path, "kind")),
    result: decodeTurnResult(object.result, at(path, "result")),
    partialOutputAvailable: decodeBoolean(
      object.partialOutputAvailable,
      at(path, "partialOutputAvailable"),
    ),
  };
}

const TURN_EVENT_PAYLOAD_DECODERS = {
  "agent-message-chunk": decodeMessageChunk,
  "agent-progress-chunk": decodeProgressChunk,
  plan: decodePlan,
  "tool-invocation-update": decodeToolUpdate,
  "usage-update": decodeUsageUpdate,
  "state-transition": decodeStateTransition,
  "prompt-accepted": decodePromptAccepted,
  "inference-resolved": decodeInferenceResolved,
  "user-message-recorded": decodeUserMessageRecorded,
  "agent-message-finalized": decodeAgentMessageFinalized,
  "tool-invocation-finalized": decodeToolFinalized,
  "interaction-requested": decodeInteractionRequested,
  "interaction-resolved": decodeInteractionResolved,
  "usage-finalized": decodeUsageFinalized,
  terminal: decodeTerminal,
} as const satisfies Record<TurnEventPayload["kind"], Decoder<TurnEventPayload>>;

export const TURN_EVENT_PAYLOAD_KINDS = Object.freeze(
  Object.keys(TURN_EVENT_PAYLOAD_DECODERS) as TurnEventPayload["kind"][],
);

export function decodeTurnEventPayload(
  input: unknown,
  path: CodecPath = [],
): TurnEventPayload {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (!Object.hasOwn(TURN_EVENT_PAYLOAD_DECODERS, kind)) {
    codecFail(
      at(path, "kind"),
      "unsupported-discriminant",
      `unsupported Turn event kind ${JSON.stringify(kind)}`,
    );
  }
  const decoder = TURN_EVENT_PAYLOAD_DECODERS[
    kind as TurnEventPayload["kind"]
  ] as Decoder<TurnEventPayload>;
  return decoder(input, path);
}

function decodeDriverMessageChunk(
  input: unknown,
  path: CodecPath = [],
): Extract<AgentDriverTurnEventPayload, { readonly kind: "agent-message-chunk" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "protocolMessageId", "text"], [], path);
  return {
    kind: decodeLiteral(object.kind, "agent-message-chunk", at(path, "kind")),
    protocolMessageId: decodeProtocolString(
      object.protocolMessageId,
      at(path, "protocolMessageId"),
    ) as Extract<
      AgentDriverTurnEventPayload,
      { readonly kind: "agent-message-chunk" }
    >["protocolMessageId"],
    text: decodeBoundedString(
      object.text,
      { maximumLength: MAX_TEXT_CHARACTERS, label: "agent message chunk" },
      at(path, "text"),
    ),
  };
}

function decodeDriverProgressChunk(
  input: unknown,
  path: CodecPath = [],
): Extract<AgentDriverTurnEventPayload, { readonly kind: "agent-progress-chunk" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "text"], [], path);
  return {
    kind: decodeLiteral(object.kind, "agent-progress-chunk", at(path, "kind")),
    text: decodeBoundedString(
      object.text,
      { maximumLength: MAX_TEXT_CHARACTERS, label: "agent progress chunk" },
      at(path, "text"),
    ),
  };
}

function decodeDriverPlan(
  input: unknown,
  path: CodecPath = [],
): Extract<AgentDriverTurnEventPayload, { readonly kind: "plan" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "entries"], [], path);
  return {
    kind: decodeLiteral(object.kind, "plan", at(path, "kind")),
    entries: decodeBoundedArray(
      object.entries,
      decodePlanEntry,
      { maximumItems: MAX_PLAN_ENTRIES },
      at(path, "entries"),
    ),
  };
}

function decodeDriverToolEvent(
  input: unknown,
  expectedKind: "tool-invocation-update" | "tool-invocation-finalized",
  path: CodecPath,
): Extract<
  AgentDriverTurnEventPayload,
  {
    readonly kind:
      | "tool-invocation-update"
      | "tool-invocation-finalized";
  }
> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "protocolToolCallId", "title", "status"],
    ["sanitizedSummary"],
    path,
  );
  const common = compact({
    protocolToolCallId: decodeProtocolString(
      object.protocolToolCallId,
      at(path, "protocolToolCallId"),
    ),
    title: decodeSanitizedString(
      object.title,
      { minimumLength: 1, maximumLength: 512, label: "tool title" },
      at(path, "title"),
    ),
    sanitizedSummary: optional(
      object,
      "sanitizedSummary",
      (value, fieldPath) =>
        decodeSanitizedString(
          value,
          {
            maximumLength: MAX_SHORT_TEXT_CHARACTERS,
            label: "sanitized tool summary",
          },
          fieldPath,
        ),
      path,
    ),
  });
  return (
    expectedKind === "tool-invocation-update"
      ? {
          ...common,
          kind: decodeLiteral(object.kind, expectedKind, at(path, "kind")),
          status: decodeEnum(
            object.status,
            ["pending", "in-progress"] as const,
            at(path, "status"),
          ),
        }
      : {
          ...common,
          kind: decodeLiteral(object.kind, expectedKind, at(path, "kind")),
          status: decodeEnum(
            object.status,
            ["completed", "failed", "cancelled"] as const,
            at(path, "status"),
          ),
        }
  ) as Extract<
    AgentDriverTurnEventPayload,
    {
      readonly kind:
        | "tool-invocation-update"
        | "tool-invocation-finalized";
    }
  >;
}

function decodeDriverFinalizedMessage(
  input: unknown,
  path: CodecPath = [],
): Extract<
  AgentDriverTurnEventPayload,
  { readonly kind: "agent-message-finalized" }
> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["kind", "protocolMessageId", "text"], [], path);
  return {
    kind: decodeLiteral(
      object.kind,
      "agent-message-finalized",
      at(path, "kind"),
    ),
    protocolMessageId: decodeProtocolString(
      object.protocolMessageId,
      at(path, "protocolMessageId"),
    ) as Extract<
      AgentDriverTurnEventPayload,
      { readonly kind: "agent-message-finalized" }
    >["protocolMessageId"],
    text: decodeBoundedString(
      object.text,
      { maximumLength: MAX_TEXT_CHARACTERS, label: "final agent message" },
      at(path, "text"),
    ),
  };
}

function decodeDriverInteractionRequest(
  input: unknown,
  path: CodecPath = [],
): Extract<
  AgentDriverTurnEventPayload,
  { readonly kind: "interaction-requested" }
> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "protocolInteractionId", "request"],
    [],
    path,
  );
  const requestPath = at(path, "request");
  const request = decodePlainObject(object.request, requestPath);
  const requestKind = decodeString(request.kind, at(requestPath, "kind"));
  let decodedRequest: Extract<
    AgentDriverTurnEventPayload,
    { readonly kind: "interaction-requested" }
  >["request"];
  if (requestKind === "approval") {
    requireExactFields(
      request,
      ["kind", "protocolToolCallId", "title", "options"],
      ["sanitizedDescription"],
      requestPath,
    );
    decodedRequest = compact({
      kind: "approval",
      protocolToolCallId: decodeProtocolString(
        request.protocolToolCallId,
        at(requestPath, "protocolToolCallId"),
      ),
      title: decodeSanitizedString(
        request.title,
        { minimumLength: 1, maximumLength: 512, label: "interaction title" },
        at(requestPath, "title"),
      ),
      sanitizedDescription: optional(
        request,
        "sanitizedDescription",
        (value, fieldPath) =>
          decodeSanitizedString(
            value,
            {
              maximumLength: MAX_SHORT_TEXT_CHARACTERS,
              label: "sanitized description",
            },
            fieldPath,
          ),
        requestPath,
      ),
      options: decodeBoundedArray(
        request.options,
        decodeAgentPermissionOption,
        {
          maximumItems: MAX_INTERACTION_OPTIONS,
          uniqueBy: (option) => option.protocolOptionId,
        },
        at(requestPath, "options"),
      ),
    }) as typeof decodedRequest;
  } else if (requestKind === "input") {
    decodedRequest = decodeInputRequest(request, requestPath);
  } else {
    codecFail(
      at(requestPath, "kind"),
      "unsupported-discriminant",
      `unsupported driver interaction request ${JSON.stringify(requestKind)}`,
    );
  }
  return {
    kind: decodeLiteral(
      object.kind,
      "interaction-requested",
      at(path, "kind"),
    ),
    protocolInteractionId: decodeProtocolString(
      object.protocolInteractionId,
      at(path, "protocolInteractionId"),
    ) as Extract<
      AgentDriverTurnEventPayload,
      { readonly kind: "interaction-requested" }
    >["protocolInteractionId"],
    request: decodedRequest,
  };
}

function decodeDriverTerminalOutcome(
  input: unknown,
  path: CodecPath,
): AgentDriverTerminalOutcome {
  const object = decodePlainObject(input, path);
  const outcome = decodeString(object.outcome, at(path, "outcome"));
  if (
    outcome === "completed" ||
    outcome === "output-limit" ||
    outcome === "refused" ||
    outcome === "cancelled"
  ) {
    requireExactFields(object, ["outcome"], [], path);
    return { outcome };
  }
  if (outcome === "failed") {
    requireExactFields(object, ["outcome", "code"], ["sanitizedDetail"], path);
    return compact({
      outcome,
      code: decodeEnum(
        object.code,
        ["agent-error", "protocol-error"] as const,
        at(path, "code"),
      ),
      sanitizedDetail: optional(
        object,
        "sanitizedDetail",
        (value, fieldPath) =>
          decodeSanitizedString(
            value,
            {
              maximumLength: MAX_SHORT_TEXT_CHARACTERS,
              label: "sanitized failure detail",
            },
            fieldPath,
          ),
        path,
      ),
    }) as AgentDriverTerminalOutcome;
  }
  codecFail(
    at(path, "outcome"),
    "unsupported-discriminant",
    `unsupported driver terminal outcome ${JSON.stringify(outcome)}`,
  );
}

function decodeDriverTerminal(
  input: unknown,
  path: CodecPath = [],
): Extract<AgentDriverTurnEventPayload, { readonly kind: "terminal" }> {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["kind", "terminal", "partialOutputAvailable"],
    [],
    path,
  );
  return {
    kind: decodeLiteral(object.kind, "terminal", at(path, "kind")),
    terminal: decodeDriverTerminalOutcome(object.terminal, at(path, "terminal")),
    partialOutputAvailable: decodeBoolean(
      object.partialOutputAvailable,
      at(path, "partialOutputAvailable"),
    ),
  };
}

const DRIVER_TURN_EVENT_DECODERS = {
  "user-message-recorded": decodeUserMessageRecorded,
  "agent-message-chunk": decodeDriverMessageChunk,
  "agent-progress-chunk": decodeDriverProgressChunk,
  plan: decodeDriverPlan,
  "tool-invocation-update": (input: unknown, path: CodecPath = []) =>
    decodeDriverToolEvent(input, "tool-invocation-update", path),
  "agent-message-finalized": decodeDriverFinalizedMessage,
  "tool-invocation-finalized": (input: unknown, path: CodecPath = []) =>
    decodeDriverToolEvent(input, "tool-invocation-finalized", path),
  "interaction-requested": decodeDriverInteractionRequest,
  terminal: decodeDriverTerminal,
} as const satisfies Record<
  AgentDriverTurnEventPayload["kind"],
  Decoder<AgentDriverTurnEventPayload>
>;

export const DRIVER_TURN_EVENT_KINDS = Object.freeze(
  Object.keys(
    DRIVER_TURN_EVENT_DECODERS,
  ) as AgentDriverTurnEventPayload["kind"][],
);

export function decodeDriverTurnEventPayload(
  input: unknown,
  path: CodecPath = [],
): AgentDriverTurnEventPayload {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  if (!Object.hasOwn(DRIVER_TURN_EVENT_DECODERS, kind)) {
    codecFail(
      at(path, "kind"),
      "unsupported-discriminant",
      `unsupported driver Turn event kind ${JSON.stringify(kind)}`,
    );
  }
  const decoder = DRIVER_TURN_EVENT_DECODERS[
    kind as AgentDriverTurnEventPayload["kind"]
  ] as Decoder<AgentDriverTurnEventPayload>;
  return decoder(input, path);
}

export function decodeDriverTurnEvent(
  input: unknown,
  path: CodecPath = [],
): AgentDriverTurnEvent {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["observedAt", "payload"], [], path);
  return {
    observedAt: decodeIsoTimestamp(object.observedAt, at(path, "observedAt")),
    payload: decodeDriverTurnEventPayload(object.payload, at(path, "payload")),
  };
}

export function decodeTurnEvent(
  input: unknown,
  path: CodecPath = [],
): TurnEvent {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["id", "turnId", "sequence", "visibility", "occurredAt", "payload"],
    [],
    path,
  );
  const turnId = decodeServiceId("Turn", object.turnId, at(path, "turnId"));
  const payload = decodeTurnEventPayload(object.payload, at(path, "payload"));
  if (
    payload.kind === "inference-resolved" &&
    payload.resolution.turnId !== turnId
  ) {
    codecFail(
      at(at(at(path, "payload"), "resolution"), "turnId"),
      "invalid-format",
      "inference resolution Turn ID must match its event envelope",
    );
  }
  return {
    id: decodeServiceId("TurnEvent", object.id, at(path, "id")),
    turnId,
    sequence: decodePositiveSafeInteger(object.sequence, at(path, "sequence")),
    visibility: decodeEnum(
      object.visibility,
      ["internal", "requester", "session-readers"] as const,
      at(path, "visibility"),
    ),
    occurredAt: decodeIsoTimestamp(object.occurredAt, at(path, "occurredAt")),
    payload,
  };
}

export function encodeTurnEvent(event: TurnEvent): JsonObject {
  return decodeTurnEvent(event) as unknown as JsonObject;
}

export function encodeCanonicalTurnEvent(event: TurnEvent): string {
  return encodeCanonicalJson(encodeTurnEvent(event));
}

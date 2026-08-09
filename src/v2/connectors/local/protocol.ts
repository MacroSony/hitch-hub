import type {
  ConnectorCommandFailureCode,
  ConnectorResponseEvent,
} from "../../model/application.js";
import type {
  ClientCertificateFingerprint,
  IdentityBindingId,
  IsoTimestamp,
  PrincipalId,
  SessionId,
  TurnId,
  TurnIdempotencyKey,
  TurnInteractionId,
  WorkspaceId,
} from "../../model/primitives.js";
import type { TurnTerminalResponse } from "../../model/records.js";
import type {
  CheckpointTurnEventPayload,
  TurnApprovalInteractionRequest,
  TurnLifecycleStatus,
} from "../../model/turn.js";
import { codecFail, type CodecPath } from "../../codecs/errors.js";
import {
  decodeBoundedArray,
  decodeBoundedString,
  decodeClientCertificateFingerprint,
  decodeIsoTimestamp,
  decodeNonNegativeSafeInteger,
  decodePositiveSafeInteger,
  decodeServiceId,
} from "../../codecs/primitives.js";
import {
  at,
  decodeBoolean,
  decodeEnum,
  decodeLiteral,
  decodePlainObject,
  decodeString,
  requireExactFields,
} from "../../codecs/structure.js";
import {
  decodeTurnContentBlock,
  decodeTurnEventPayload,
  decodeTurnInteractionRequest,
  decodeTurnResult,
} from "../../codecs/turn-events.js";
import { decodeCanonicalHostPath } from "../../bootstrap/records.js";

export const LOCAL_PROTOCOL_NAME = "hitch.local" as const;
export const LOCAL_PROTOCOL_VERSION = 1 as const;

/**
 * Hard protocol ceilings. Installation policy may narrow these later, but the
 * socket boundary may never widen them.
 */
export const LOCAL_PROTOCOL_LIMITS = Object.freeze({
  maximumFrameBytes: 16 * 1024 * 1024,
  maximumImageBytes: 8 * 1024 * 1024,
  maximumClientCertificateDerBytes: 64 * 1024,
  maximumPromptCharacters: 65_536,
  maximumShortTextCharacters: 4_096,
  maximumReferenceCharacters: 128,
  maximumRequestIdCharacters: 128,
  maximumIdempotencyKeyCharacters: 128,
  maximumTerminalMessages: 256,
  maximumContentBlocksPerMessage: 256,
});

const CONFIGURATION_REFERENCE = /^[a-z][a-z0-9-]{0,127}$/u;
const REQUEST_CORRELATION =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;
const IDEMPOTENCY_KEY =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface LocalProtocolImage {
  readonly encoding: "base64";
  readonly byteLength: number;
  readonly data: string;
}

export interface LocalProtocolClientCertificateDer {
  readonly encoding: "base64";
  readonly byteLength: number;
  readonly data: string;
}

export type LocalProtocolSessionSelector =
  | {
      readonly kind: "session-id";
      readonly sessionId: SessionId;
    }
  | {
      readonly kind: "session-name";
      readonly name: string;
    };

export type LocalApplicationProtocolCommand =
  | {
      readonly kind: "create-session";
      readonly profileReference: string;
      readonly workspaceReference: string;
      readonly displayName?: string;
    }
  | {
      readonly kind: "submit-turn";
      readonly session: LocalProtocolSessionSelector;
      readonly idempotencyKey: TurnIdempotencyKey;
      readonly text: string;
      readonly image?: LocalProtocolImage;
    }
  | {
      readonly kind: "get-turn";
      readonly turnId: TurnId;
    }
  | {
      readonly kind: "cancel-turn";
      readonly turnId: TurnId;
    }
  | {
      readonly kind: "stop-session";
      readonly sessionId: SessionId;
    }
  | {
      readonly kind: "resolve-interaction";
      readonly interactionId: TurnInteractionId;
      readonly decision: "approve" | "deny";
    };

/** Commands exposed only by the owner-private elevated local boundary. */
export type LocalAdministrationProtocolCommand =
  | {
      readonly kind: "admin-create-principal";
      readonly principalReference: string;
      readonly displayName: string;
      readonly role: "admin" | "member";
      readonly workspaceReference: string;
      readonly workspaceRoot: string;
    }
  | {
      readonly kind: "admin-disable-principal";
      readonly principalReference: string;
    }
  | {
      readonly kind: "admin-bind-client-certificate";
      readonly principalReference: string;
      readonly bindingReference: string;
      readonly certificateDer: LocalProtocolClientCertificateDer;
    }
  | {
      readonly kind: "admin-revoke-client-certificate";
      readonly bindingReference: string;
    };

export type LocalProtocolCommand =
  | LocalApplicationProtocolCommand
  | LocalAdministrationProtocolCommand;

export interface LocalProtocolClientFrame {
  readonly protocol: typeof LOCAL_PROTOCOL_NAME;
  readonly version: typeof LOCAL_PROTOCOL_VERSION;
  readonly frame: "request";
  readonly requestId: string;
  readonly command: LocalProtocolCommand;
}

export type LocalProtocolCommandResult =
  | {
      readonly kind: "session-created";
      readonly sessionId: SessionId;
    }
  | {
      readonly kind: "turn-submitted";
      readonly turnId: TurnId;
      readonly status: "starting";
      readonly canCancel: boolean;
    }
  | {
      readonly kind: "turn-submitted";
      readonly turnId: TurnId;
      readonly status: "queued";
      readonly position: number;
      readonly canCancel: boolean;
    }
  | {
      readonly kind: "turn-found";
      readonly turnId: TurnId;
      readonly state: TurnLifecycleStatus;
      readonly updatedAt: IsoTimestamp;
      readonly terminalResponse?: TurnTerminalResponse;
    }
  | {
      readonly kind: "turn-cancelled" | "turn-already-cancelled";
      readonly turnId: TurnId;
    }
  | {
      readonly kind: "turn-not-cancelled";
      readonly turnId: TurnId;
      readonly reason: "turn-not-queued-or-active" | "already-terminal";
    }
  | {
      readonly kind:
        | "session-stop-requested"
        | "session-already-stopped";
      readonly sessionId: SessionId;
    }
  | {
      readonly kind:
        | "interaction-resolved"
        | "interaction-not-pending";
      readonly interactionId: TurnInteractionId;
    }
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

export type LocalProtocolCommandOutcome =
  | {
      readonly status: "rejected";
      readonly code: ConnectorCommandFailureCode;
    }
  | {
      readonly status: "succeeded";
      readonly result: LocalProtocolCommandResult;
    };

export type LocalProtocolServerFrame =
  | {
      readonly protocol: typeof LOCAL_PROTOCOL_NAME;
      readonly version: typeof LOCAL_PROTOCOL_VERSION;
      readonly frame: "response";
      readonly requestId: string;
      readonly outcome: LocalProtocolCommandOutcome;
    }
  | {
      readonly protocol: typeof LOCAL_PROTOCOL_NAME;
      readonly version: typeof LOCAL_PROTOCOL_VERSION;
      readonly frame: "event";
      readonly requestId: string;
      readonly event: ConnectorResponseEvent;
    }
  | {
      readonly protocol: typeof LOCAL_PROTOCOL_NAME;
      readonly version: typeof LOCAL_PROTOCOL_VERSION;
      readonly frame: "stream-end";
      readonly requestId: string;
    };

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function compact<Value extends Record<string, unknown>>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  ) as Value;
}

function decodeVersion(input: unknown, path: CodecPath): 1 {
  if (input !== LOCAL_PROTOCOL_VERSION) {
    codecFail(
      path,
      "invalid-format",
      `expected local protocol version ${LOCAL_PROTOCOL_VERSION}`,
    );
  }
  return LOCAL_PROTOCOL_VERSION;
}

function decodeRequestId(input: unknown, path: CodecPath): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: LOCAL_PROTOCOL_LIMITS.maximumRequestIdCharacters,
      pattern: REQUEST_CORRELATION,
      label: "request correlation",
    },
    path,
  );
}

function decodeConfigurationReference(
  input: unknown,
  path: CodecPath,
): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: LOCAL_PROTOCOL_LIMITS.maximumReferenceCharacters,
      pattern: CONFIGURATION_REFERENCE,
      label: "configuration reference",
    },
    path,
  );
}

function decodeUserLabel(
  input: unknown,
  path: CodecPath,
  label: string,
): string {
  const value = decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: 256,
      label,
    },
    path,
  );
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    codecFail(path, "invalid-format", `${label} contains control characters`);
  }
  return value;
}

function decodeTurnInteractionId(input: unknown, path: CodecPath = []) {
  return decodeServiceId("TurnInteraction", input, path);
}

function decodeSessionSelector(
  input: unknown,
  path: CodecPath,
): LocalProtocolSessionSelector {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "session-id":
      requireExactFields(object, ["kind", "sessionId"], [], path);
      return {
        kind: decodeLiteral(object.kind, "session-id", at(path, "kind")),
        sessionId: decodeServiceId(
          "Session",
          object.sessionId,
          at(path, "sessionId"),
        ),
      };
    case "session-name":
      requireExactFields(object, ["kind", "name"], [], path);
      return {
        kind: decodeLiteral(object.kind, "session-name", at(path, "kind")),
        name: decodeUserLabel(
          object.name,
          at(path, "name"),
          "session name",
        ),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported session selector ${JSON.stringify(kind)}`,
      );
  }
}

function decodeImage(
  input: unknown,
  path: CodecPath,
): LocalProtocolImage {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    ["encoding", "byteLength", "data"],
    [],
    path,
  );
  decodeLiteral(
    object.encoding,
    "base64",
    at(path, "encoding"),
  );
  const byteLength = decodePositiveSafeInteger(
    object.byteLength,
    at(path, "byteLength"),
  );
  if (byteLength > LOCAL_PROTOCOL_LIMITS.maximumImageBytes) {
    codecFail(
      at(path, "byteLength"),
      "out-of-range",
      "image exceeds the local protocol byte limit",
    );
  }
  const maximumBase64Characters =
    Math.ceil(LOCAL_PROTOCOL_LIMITS.maximumImageBytes / 3) * 4;
  const data = decodeBoundedString(
    object.data,
    {
      minimumLength: 4,
      maximumLength: maximumBase64Characters,
      pattern: BASE64,
      label: "image base64",
    },
    at(path, "data"),
  );
  let decoded: Buffer;
  try {
    decoded = Buffer.from(data, "base64");
  } catch {
    codecFail(
      at(path, "data"),
      "invalid-format",
      "image data must be canonical base64",
    );
  }
  if (
    decoded.length !== byteLength ||
    decoded.length > LOCAL_PROTOCOL_LIMITS.maximumImageBytes ||
    decoded.toString("base64") !== data
  ) {
    codecFail(
      at(path, "data"),
      "invalid-format",
      "image byte length and canonical base64 must agree",
    );
  }
  return { encoding: "base64", byteLength, data };
}

function decodeClientCertificateDer(
  input: unknown,
  path: CodecPath,
): LocalProtocolClientCertificateDer {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["encoding", "byteLength", "data"], [], path);
  decodeLiteral(object.encoding, "base64", at(path, "encoding"));
  const byteLength = decodePositiveSafeInteger(
    object.byteLength,
    at(path, "byteLength"),
  );
  if (byteLength > LOCAL_PROTOCOL_LIMITS.maximumClientCertificateDerBytes) {
    codecFail(
      at(path, "byteLength"),
      "out-of-range",
      "client certificate exceeds the DER byte limit",
    );
  }
  const data = decodeBoundedString(
    object.data,
    {
      minimumLength: 4,
      maximumLength:
        Math.ceil(
          LOCAL_PROTOCOL_LIMITS.maximumClientCertificateDerBytes / 3,
        ) * 4,
      pattern: BASE64,
      label: "client certificate DER base64",
    },
    at(path, "data"),
  );
  const decoded = Buffer.from(data, "base64");
  if (
    decoded.length !== byteLength ||
    decoded.length >
      LOCAL_PROTOCOL_LIMITS.maximumClientCertificateDerBytes ||
    decoded.toString("base64") !== data
  ) {
    codecFail(
      at(path, "data"),
      "invalid-format",
      "client certificate byte length and canonical base64 must agree",
    );
  }
  return { encoding: "base64", byteLength, data };
}

function decodeCanonicalAbsolutePath(
  input: unknown,
  path: CodecPath,
): string {
  return decodeCanonicalHostPath(input, path);
}

export function decodeLocalProtocolCommand(
  input: unknown,
  path: CodecPath = [],
): LocalProtocolCommand {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "create-session":
      requireExactFields(
        object,
        ["kind", "profileReference", "workspaceReference"],
        ["displayName"],
        path,
      );
      return compact({
        kind: decodeLiteral(
          object.kind,
          "create-session",
          at(path, "kind"),
        ),
        profileReference: decodeConfigurationReference(
          object.profileReference,
          at(path, "profileReference"),
        ),
        workspaceReference: decodeConfigurationReference(
          object.workspaceReference,
          at(path, "workspaceReference"),
        ),
        displayName: Object.hasOwn(object, "displayName")
          ? decodeUserLabel(
              object.displayName,
              at(path, "displayName"),
              "session display name",
            )
          : undefined,
      }) as LocalProtocolCommand;
    case "submit-turn":
      requireExactFields(
        object,
        ["kind", "session", "idempotencyKey", "text"],
        ["image"],
        path,
      );
      return compact({
        kind: decodeLiteral(
          object.kind,
          "submit-turn",
          at(path, "kind"),
        ),
        session: decodeSessionSelector(
          object.session,
          at(path, "session"),
        ),
        idempotencyKey: decodeBoundedString(
          object.idempotencyKey,
          {
            minimumLength: 1,
            maximumLength:
              LOCAL_PROTOCOL_LIMITS.maximumIdempotencyKeyCharacters,
            pattern: IDEMPOTENCY_KEY,
            label: "Turn idempotency key",
          },
          at(path, "idempotencyKey"),
        ) as TurnIdempotencyKey,
        text: decodeBoundedString(
          object.text,
          {
            minimumLength: 1,
            maximumLength:
              LOCAL_PROTOCOL_LIMITS.maximumPromptCharacters,
            label: "prompt text",
          },
          at(path, "text"),
        ),
        image: Object.hasOwn(object, "image")
          ? decodeImage(object.image, at(path, "image"))
          : undefined,
      }) as LocalProtocolCommand;
    case "get-turn":
    case "cancel-turn":
      requireExactFields(object, ["kind", "turnId"], [], path);
      return {
        kind,
        turnId: decodeServiceId(
          "Turn",
          object.turnId,
          at(path, "turnId"),
        ),
      };
    case "stop-session":
      requireExactFields(object, ["kind", "sessionId"], [], path);
      return {
        kind,
        sessionId: decodeServiceId(
          "Session",
          object.sessionId,
          at(path, "sessionId"),
        ),
      };
    case "resolve-interaction":
      requireExactFields(
        object,
        ["kind", "interactionId", "decision"],
        [],
        path,
      );
      return {
        kind,
        interactionId: decodeTurnInteractionId(
          object.interactionId,
          at(path, "interactionId"),
        ),
        decision: decodeEnum(
          object.decision,
          ["approve", "deny"] as const,
          at(path, "decision"),
        ),
      };
    case "admin-create-principal":
      requireExactFields(
        object,
        [
          "kind",
          "principalReference",
          "displayName",
          "role",
          "workspaceReference",
          "workspaceRoot",
        ],
        [],
        path,
      );
      return {
        kind,
        principalReference: decodeConfigurationReference(
          object.principalReference,
          at(path, "principalReference"),
        ),
        displayName: decodeUserLabel(
          object.displayName,
          at(path, "displayName"),
          "principal display name",
        ),
        role: decodeEnum(
          object.role,
          ["admin", "member"] as const,
          at(path, "role"),
        ),
        workspaceReference: decodeConfigurationReference(
          object.workspaceReference,
          at(path, "workspaceReference"),
        ),
        workspaceRoot: decodeCanonicalAbsolutePath(
          object.workspaceRoot,
          at(path, "workspaceRoot"),
        ),
      };
    case "admin-disable-principal":
      requireExactFields(object, ["kind", "principalReference"], [], path);
      return {
        kind,
        principalReference: decodeConfigurationReference(
          object.principalReference,
          at(path, "principalReference"),
        ),
      };
    case "admin-bind-client-certificate":
      requireExactFields(
        object,
        ["kind", "principalReference", "bindingReference", "certificateDer"],
        [],
        path,
      );
      return {
        kind,
        principalReference: decodeConfigurationReference(
          object.principalReference,
          at(path, "principalReference"),
        ),
        bindingReference: decodeConfigurationReference(
          object.bindingReference,
          at(path, "bindingReference"),
        ),
        certificateDer: decodeClientCertificateDer(
          object.certificateDer,
          at(path, "certificateDer"),
        ),
      };
    case "admin-revoke-client-certificate":
      requireExactFields(object, ["kind", "bindingReference"], [], path);
      return {
        kind,
        bindingReference: decodeConfigurationReference(
          object.bindingReference,
          at(path, "bindingReference"),
        ),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported local command ${JSON.stringify(kind)}`,
      );
  }
}

function decodeTerminalMessage(
  input: unknown,
  path: CodecPath,
): TurnTerminalResponse["finalizedMessages"][number] {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["messageId", "sequence", "content"], [], path);
  return {
    messageId: decodeServiceId(
      "TurnMessage",
      object.messageId,
      at(path, "messageId"),
    ),
    sequence: decodeNonNegativeSafeInteger(
      object.sequence,
      at(path, "sequence"),
    ),
    content: decodeBoundedArray(
      object.content,
      decodeTurnContentBlock,
      {
        maximumItems:
          LOCAL_PROTOCOL_LIMITS.maximumContentBlocksPerMessage,
      },
      at(path, "content"),
    ),
  };
}

function decodeTerminalResponse(
  input: unknown,
  path: CodecPath,
): TurnTerminalResponse {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    [
      "id",
      "turnId",
      "result",
      "partialOutputAvailable",
      "finalizedMessages",
      "finalizedAt",
    ],
    [],
    path,
  );
  return {
    id: decodeServiceId(
      "TurnTerminalResponse",
      object.id,
      at(path, "id"),
    ),
    turnId: decodeServiceId("Turn", object.turnId, at(path, "turnId")),
    result: decodeTurnResult(object.result, at(path, "result")),
    partialOutputAvailable: decodeBoolean(
      object.partialOutputAvailable,
      at(path, "partialOutputAvailable"),
    ),
    finalizedMessages: decodeBoundedArray(
      object.finalizedMessages,
      decodeTerminalMessage,
      {
        maximumItems: LOCAL_PROTOCOL_LIMITS.maximumTerminalMessages,
        uniqueBy: (message) => message.messageId,
      },
      at(path, "finalizedMessages"),
    ),
    finalizedAt: decodeIsoTimestamp(
      object.finalizedAt,
      at(path, "finalizedAt"),
    ),
  };
}

function decodeTurnSubmitted(
  object: Record<string, unknown>,
  path: CodecPath,
): LocalProtocolCommandResult {
  const status = decodeString(object.status, at(path, "status"));
  if (status === "starting") {
    requireExactFields(
      object,
      ["kind", "turnId", "status", "canCancel"],
      [],
      path,
    );
    return {
      kind: "turn-submitted",
      turnId: decodeServiceId("Turn", object.turnId, at(path, "turnId")),
      status,
      canCancel: decodeBoolean(
        object.canCancel,
        at(path, "canCancel"),
      ),
    };
  }
  if (status === "queued") {
    requireExactFields(
      object,
      ["kind", "turnId", "status", "position", "canCancel"],
      [],
      path,
    );
    return {
      kind: "turn-submitted",
      turnId: decodeServiceId("Turn", object.turnId, at(path, "turnId")),
      status,
      position: decodePositiveSafeInteger(
        object.position,
        at(path, "position"),
      ),
      canCancel: decodeBoolean(
        object.canCancel,
        at(path, "canCancel"),
      ),
    };
  }
  codecFail(
    at(path, "status"),
    "unsupported-discriminant",
    `unsupported Turn receipt ${JSON.stringify(status)}`,
  );
}

const TURN_LIFECYCLE_STATUSES = [
  "queued",
  "dispatching",
  "submission-armed",
  "submitted-unconfirmed",
  "accepted",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
  "cancelling",
  "terminal",
] as const satisfies readonly TurnLifecycleStatus[];

function decodeTurnFound(
  object: Record<string, unknown>,
  path: CodecPath,
): LocalProtocolCommandResult {
  const state = decodeEnum(
    object.state,
    TURN_LIFECYCLE_STATUSES,
    at(path, "state"),
  );
  requireExactFields(
    object,
    ["kind", "turnId", "state", "updatedAt"],
    state === "terminal" ? ["terminalResponse"] : [],
    path,
  );
  const turnId = decodeServiceId("Turn", object.turnId, at(path, "turnId"));
  if (state === "terminal") {
    if (!Object.hasOwn(object, "terminalResponse")) {
      codecFail(
        at(path, "terminalResponse"),
        "invalid-type",
        "terminal Turn requires its immutable response",
      );
    }
    const terminalResponse = decodeTerminalResponse(
      object.terminalResponse,
      at(path, "terminalResponse"),
    );
    if (terminalResponse.turnId !== turnId) {
      codecFail(
        at(at(path, "terminalResponse"), "turnId"),
        "invalid-format",
        "terminal response belongs to a different Turn",
      );
    }
    return {
      kind: "turn-found",
      turnId,
      state,
      updatedAt: decodeIsoTimestamp(
        object.updatedAt,
        at(path, "updatedAt"),
      ),
      terminalResponse,
    };
  }
  if (Object.hasOwn(object, "terminalResponse")) {
    codecFail(
      at(path, "terminalResponse"),
      "unknown-field",
      "nonterminal Turn cannot contain a terminal response",
    );
  }
  return {
    kind: "turn-found",
    turnId,
    state,
    updatedAt: decodeIsoTimestamp(
      object.updatedAt,
      at(path, "updatedAt"),
    ),
  };
}

function decodeCommandResult(
  input: unknown,
  path: CodecPath,
): LocalProtocolCommandResult {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "session-created":
      requireExactFields(object, ["kind", "sessionId"], [], path);
      return {
        kind,
        sessionId: decodeServiceId(
          "Session",
          object.sessionId,
          at(path, "sessionId"),
        ),
      };
    case "turn-submitted":
      return decodeTurnSubmitted(object, path);
    case "turn-found":
      return decodeTurnFound(object, path);
    case "turn-cancelled":
    case "turn-already-cancelled":
      requireExactFields(object, ["kind", "turnId"], [], path);
      return {
        kind,
        turnId: decodeServiceId(
          "Turn",
          object.turnId,
          at(path, "turnId"),
        ),
      };
    case "turn-not-cancelled":
      requireExactFields(object, ["kind", "turnId", "reason"], [], path);
      return {
        kind,
        turnId: decodeServiceId(
          "Turn",
          object.turnId,
          at(path, "turnId"),
        ),
        reason: decodeEnum(
          object.reason,
          ["turn-not-queued-or-active", "already-terminal"] as const,
          at(path, "reason"),
        ),
      };
    case "session-stop-requested":
    case "session-already-stopped":
      requireExactFields(object, ["kind", "sessionId"], [], path);
      return {
        kind,
        sessionId: decodeServiceId(
          "Session",
          object.sessionId,
          at(path, "sessionId"),
        ),
      };
    case "interaction-resolved":
    case "interaction-not-pending":
      requireExactFields(object, ["kind", "interactionId"], [], path);
      return {
        kind,
        interactionId: decodeTurnInteractionId(
          object.interactionId,
          at(path, "interactionId"),
        ),
      };
    case "principal-created":
      requireExactFields(
        object,
        ["kind", "principalId", "workspaceId"],
        [],
        path,
      );
      return {
        kind,
        principalId: decodeServiceId(
          "Principal",
          object.principalId,
          at(path, "principalId"),
        ),
        workspaceId: decodeServiceId(
          "Workspace",
          object.workspaceId,
          at(path, "workspaceId"),
        ),
      };
    case "principal-disabled":
    case "principal-already-disabled":
      requireExactFields(object, ["kind", "principalId"], [], path);
      return {
        kind,
        principalId: decodeServiceId(
          "Principal",
          object.principalId,
          at(path, "principalId"),
        ),
      };
    case "client-certificate-bound":
      requireExactFields(
        object,
        ["kind", "principalId", "identityBindingId", "fingerprint"],
        [],
        path,
      );
      return {
        kind,
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
        fingerprint: decodeClientCertificateFingerprint(
          object.fingerprint,
          at(path, "fingerprint"),
        ),
      };
    case "client-certificate-revoked":
    case "client-certificate-already-revoked":
      requireExactFields(
        object,
        ["kind", "identityBindingId"],
        [],
        path,
      );
      return {
        kind,
        identityBindingId: decodeServiceId(
          "IdentityBinding",
          object.identityBindingId,
          at(path, "identityBindingId"),
        ),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported local result ${JSON.stringify(kind)}`,
      );
  }
}

function decodeOutcome(
  input: unknown,
  path: CodecPath,
): LocalProtocolCommandOutcome {
  const object = decodePlainObject(input, path);
  const status = decodeString(object.status, at(path, "status"));
  if (status === "rejected") {
    requireExactFields(object, ["status", "code"], [], path);
    return {
      status,
      code: decodeEnum(
        object.code,
        [
          "not-authorized",
          "not-found",
          "invalid-request",
          "queue-capacity-exceeded",
          "conflict",
          "temporarily-unavailable",
        ] as const,
        at(path, "code"),
      ),
    };
  }
  if (status === "succeeded") {
    requireExactFields(object, ["status", "result"], [], path);
    return {
      status,
      result: decodeCommandResult(object.result, at(path, "result")),
    };
  }
  codecFail(
    at(path, "status"),
    "unsupported-discriminant",
    `unsupported local outcome ${JSON.stringify(status)}`,
  );
}

function decodeCheckpointPayload(
  input: unknown,
  path: CodecPath,
): CheckpointTurnEventPayload {
  const payload = decodeTurnEventPayload(input, path);
  if (
    payload.kind !== "plan" &&
    payload.kind !== "tool-invocation-update" &&
    payload.kind !== "usage-update"
  ) {
    codecFail(
      at(path, "kind"),
      "unsupported-discriminant",
      "connector checkpoint accepts only sanitized checkpoint events",
    );
  }
  return payload;
}

function decodeApprovalRequest(
  input: unknown,
  path: CodecPath,
): TurnApprovalInteractionRequest {
  const request = decodeTurnInteractionRequest(input, path);
  if (request.kind !== "approval") {
    codecFail(
      at(path, "kind"),
      "unsupported-discriminant",
      "the first-slice connector exposes approval requests only",
    );
  }
  return request;
}

function decodeConnectorEvent(
  input: unknown,
  path: CodecPath,
): ConnectorResponseEvent {
  const object = decodePlainObject(input, path);
  const kind = decodeString(object.kind, at(path, "kind"));
  switch (kind) {
    case "turn-checkpoint":
      requireExactFields(
        object,
        ["kind", "turnId", "sequence", "payload"],
        [],
        path,
      );
      return {
        kind,
        turnId: decodeServiceId(
          "Turn",
          object.turnId,
          at(path, "turnId"),
        ),
        sequence: decodeNonNegativeSafeInteger(
          object.sequence,
          at(path, "sequence"),
        ),
        payload: decodeCheckpointPayload(
          object.payload,
          at(path, "payload"),
        ),
      };
    case "approval-requested":
      requireExactFields(
        object,
        ["kind", "turnId", "interactionId", "request"],
        [],
        path,
      );
      return {
        kind,
        turnId: decodeServiceId(
          "Turn",
          object.turnId,
          at(path, "turnId"),
        ),
        interactionId: decodeTurnInteractionId(
          object.interactionId,
          at(path, "interactionId"),
        ),
        request: decodeApprovalRequest(
          object.request,
          at(path, "request"),
        ),
      };
    case "turn-terminal":
      requireExactFields(object, ["kind", "response"], [], path);
      return {
        kind,
        response: decodeTerminalResponse(
          object.response,
          at(path, "response"),
        ),
      };
    case "response-delivery-state":
      requireExactFields(
        object,
        ["kind", "turnId", "deliveryId", "state"],
        [],
        path,
      );
      return {
        kind,
        turnId: decodeServiceId(
          "Turn",
          object.turnId,
          at(path, "turnId"),
        ),
        deliveryId: decodeServiceId(
          "TurnResponseDelivery",
          object.deliveryId,
          at(path, "deliveryId"),
        ),
        state: decodeEnum(
          object.state,
          [
            "pending",
            "delivering",
            "delivered",
            "retryable-failure",
            "failed",
            "suppressed",
            "expired",
          ] as const,
          at(path, "state"),
        ),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported connector event ${JSON.stringify(kind)}`,
      );
  }
}

function decodeEnvelope(
  input: unknown,
  expectedFrame: "request" | "response" | "event" | "stream-end",
): Record<string, unknown> {
  const object = decodePlainObject(input);
  decodeLiteral(object.protocol, LOCAL_PROTOCOL_NAME, ["protocol"]);
  decodeVersion(object.version, ["version"]);
  decodeLiteral(object.frame, expectedFrame, ["frame"]);
  decodeRequestId(object.requestId, ["requestId"]);
  return object;
}

export function decodeLocalProtocolClientFrame(
  input: unknown,
): LocalProtocolClientFrame {
  const object = decodePlainObject(input);
  const frame = decodeString(object.frame, ["frame"]);
  if (frame !== "request") {
    codecFail(
      ["frame"],
      "unsupported-discriminant",
      "clients may send request frames only",
    );
  }
  const envelope = decodeEnvelope(object, "request");
  requireExactFields(
    envelope,
    ["protocol", "version", "frame", "requestId", "command"],
  );
  return deepFreeze({
    protocol: LOCAL_PROTOCOL_NAME,
    version: LOCAL_PROTOCOL_VERSION,
    frame: "request",
    requestId: decodeRequestId(envelope.requestId, ["requestId"]),
    command: decodeLocalProtocolCommand(envelope.command, ["command"]),
  });
}

export function decodeLocalProtocolServerFrame(
  input: unknown,
): LocalProtocolServerFrame {
  const object = decodePlainObject(input);
  const frame = decodeString(object.frame, ["frame"]);
  if (
    frame !== "response" &&
    frame !== "event" &&
    frame !== "stream-end"
  ) {
    codecFail(
      ["frame"],
      "unsupported-discriminant",
      "server frame kind is unsupported",
    );
  }
  const envelope = decodeEnvelope(object, frame);
  if (frame === "response") {
    requireExactFields(
      envelope,
      ["protocol", "version", "frame", "requestId", "outcome"],
    );
    return deepFreeze({
      protocol: LOCAL_PROTOCOL_NAME,
      version: LOCAL_PROTOCOL_VERSION,
      frame,
      requestId: decodeRequestId(envelope.requestId, ["requestId"]),
      outcome: decodeOutcome(envelope.outcome, ["outcome"]),
    });
  }
  if (frame === "event") {
    requireExactFields(
      envelope,
      ["protocol", "version", "frame", "requestId", "event"],
    );
    return deepFreeze({
      protocol: LOCAL_PROTOCOL_NAME,
      version: LOCAL_PROTOCOL_VERSION,
      frame,
      requestId: decodeRequestId(envelope.requestId, ["requestId"]),
      event: decodeConnectorEvent(envelope.event, ["event"]),
    });
  }
  requireExactFields(
    envelope,
    ["protocol", "version", "frame", "requestId"],
  );
  return deepFreeze({
    protocol: LOCAL_PROTOCOL_NAME,
    version: LOCAL_PROTOCOL_VERSION,
    frame,
    requestId: decodeRequestId(envelope.requestId, ["requestId"]),
  });
}

function encodeBoundedFrame(input: unknown, side: "client" | "server"): string {
  const decoded =
    side === "client"
      ? decodeLocalProtocolClientFrame(input)
      : decodeLocalProtocolServerFrame(input);
  // Every decoder reconstructs fields in a fixed order and rejects non-JSON
  // values, so JSON.stringify is deterministic here without the generic
  // codec's narrower 65 KiB string ceiling (valid image frames are larger).
  const encoded = JSON.stringify(decoded);
  if (
    Buffer.byteLength(encoded, "utf8") >
    LOCAL_PROTOCOL_LIMITS.maximumFrameBytes
  ) {
    codecFail([], "too-long", "encoded local protocol frame exceeds its byte limit");
  }
  return encoded;
}

export function encodeCanonicalLocalProtocolClientFrame(
  input: unknown,
): string {
  return encodeBoundedFrame(input, "client");
}

export function encodeCanonicalLocalProtocolServerFrame(
  input: unknown,
): string {
  return encodeBoundedFrame(input, "server");
}

import type { AuditActorRef, AuditSystemComponent } from "../model/identity-access.js";
import type { AuditAction, AuditEnvelope, AuditEvent } from "../model/records.js";
import type { JsonObject } from "../model/primitives.js";
import { codecFail, type CodecPath } from "./errors.js";
import { encodeCanonicalJson } from "./json.js";
import {
  decodeIsoTimestamp,
  decodeServiceId,
  type ServiceIdKind,
} from "./primitives.js";
import {
  at,
  decodeEnum,
  decodePlainObject,
  decodeString,
  requireExactFields,
} from "./structure.js";

interface AuditIdField {
  readonly field: string;
  readonly kind: ServiceIdKind;
}

const COMMON_INFERENCE_FIELDS = [
  { field: "sessionId", kind: "Session" },
  { field: "turnId", kind: "Turn" },
  { field: "workerLeaseId", kind: "WorkerLease" },
  { field: "credentialLeaseId", kind: "CredentialLease" },
] as const satisfies readonly AuditIdField[];

const RESERVED_INFERENCE_FIELDS = [
  ...COMMON_INFERENCE_FIELDS,
  { field: "reservationId", kind: "InferenceRequestReservation" },
] as const satisfies readonly AuditIdField[];

const FORWARDED_INFERENCE_FIELDS = [
  ...RESERVED_INFERENCE_FIELDS,
  { field: "forwardingAttemptId", kind: "InferenceForwardingAttempt" },
] as const satisfies readonly AuditIdField[];

const AUDIT_EVENT_FIELDS = {
  "installation-published": [],
  "authentication-recorded": [
    { field: "authenticationRequestId", kind: "AuthenticationRequest" },
  ],
  "principal-created": [
    { field: "subjectPrincipalId", kind: "Principal" },
  ],
  "principal-state-changed": [
    { field: "subjectPrincipalId", kind: "Principal" },
  ],
  "identity-binding-state-changed": [
    { field: "identityBindingId", kind: "IdentityBinding" },
  ],
  "configuration-grant-state-changed": [
    { field: "accessGrantId", kind: "AccessGrant" },
  ],
  "session-created": [
    { field: "sessionId", kind: "Session" },
    { field: "sessionSpecId", kind: "SessionSpec" },
    { field: "endpointBindingId", kind: "SessionEndpointBinding" },
  ],
  "session-creation-denied": [],
  "session-runtime-stop-recorded": [
    { field: "sessionId", kind: "Session" },
  ],
  "session-lifecycle-state-changed": [
    { field: "sessionId", kind: "Session" },
  ],
  "attachment-admitted": [
    { field: "attachmentId", kind: "Attachment" },
    { field: "authenticationRequestId", kind: "AuthenticationRequest" },
  ],
  "turn-admitted": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
  ],
  "turn-state-transitioned": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
  ],
  "turn-queue-handoff-recorded": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
  ],
  "turn-dispatched": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "attemptId", kind: "AgentDispatchAttempt" },
  ],
  "turn-recovery-recorded": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "attemptId", kind: "AgentDispatchAttempt" },
    { field: "workerLeaseId", kind: "WorkerLease" },
  ],
  "turn-message-finalized": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "messageId", kind: "TurnMessage" },
  ],
  "interaction-recorded": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "interactionId", kind: "TurnInteraction" },
  ],
  "interaction-resolved": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "interactionId", kind: "TurnInteraction" },
  ],
  "interaction-response-dispatch-recorded": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "interactionId", kind: "TurnInteraction" },
    { field: "interactionResponseId", kind: "TurnInteractionResponse" },
  ],
  "worker-lease-state-changed": [
    { field: "sessionId", kind: "Session" },
    { field: "workerLeaseId", kind: "WorkerLease" },
  ],
  "credential-lease-state-changed": [
    { field: "sessionId", kind: "Session" },
    { field: "workerLeaseId", kind: "WorkerLease" },
    { field: "credentialLeaseId", kind: "CredentialLease" },
  ],
  "resume-handle-state-changed": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "workerLeaseId", kind: "WorkerLease" },
    { field: "resumeHandleId", kind: "AgentResumeHandle" },
  ],
  "inference-reserved": [
    ...COMMON_INFERENCE_FIELDS,
    { field: "reservationId", kind: "InferenceRequestReservation" },
  ],
  "inference-reservation-denied": COMMON_INFERENCE_FIELDS,
  "inference-forwarding-recorded": FORWARDED_INFERENCE_FIELDS,
  "inference-forwarding-denied": RESERVED_INFERENCE_FIELDS,
  "inference-send-started": FORWARDED_INFERENCE_FIELDS,
  "inference-send-completed": FORWARDED_INFERENCE_FIELDS,
  "inference-send-outcome-unknown": FORWARDED_INFERENCE_FIELDS,
  "inference-settled": FORWARDED_INFERENCE_FIELDS,
  "inference-charged-reservation": FORWARDED_INFERENCE_FIELDS,
  "inference-released": RESERVED_INFERENCE_FIELDS,
  "inference-release-denied": RESERVED_INFERENCE_FIELDS,
  "turn-terminalized": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
  ],
  "response-delivery-created": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "deliveryId", kind: "TurnResponseDelivery" },
  ],
  "response-delivery-attempt-recorded": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "deliveryId", kind: "TurnResponseDelivery" },
    { field: "deliveryAttemptId", kind: "TurnResponseDeliveryAttempt" },
  ],
  "response-delivery-expired": [
    { field: "sessionId", kind: "Session" },
    { field: "turnId", kind: "Turn" },
    { field: "deliveryId", kind: "TurnResponseDelivery" },
  ],
} as const satisfies Record<AuditAction, readonly AuditIdField[]>;

export const AUDIT_ACTIONS = Object.freeze(
  Object.keys(AUDIT_EVENT_FIELDS) as AuditAction[],
);

const AUDIT_SYSTEM_COMPONENTS = [
  "application",
  "authorization",
  "bootstrap",
  "broker",
  "delivery",
  "local-connector",
  "remote-ingress",
  "recovery",
  "sidecar",
  "supervisor",
  "turn-coordinator",
] as const satisfies readonly AuditSystemComponent[];

function decodeAuditActor(
  input: unknown,
  path: CodecPath,
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
        principalId: decodeServiceId("Principal", object.principalId, at(path, "principalId")),
      };
    case "system":
      requireExactFields(object, ["kind", "component"], [], path);
      return {
        kind,
        component: decodeEnum(object.component, AUDIT_SYSTEM_COMPONENTS, at(path, "component")),
      };
    default:
      codecFail(
        at(path, "kind"),
        "unsupported-discriminant",
        `unsupported audit actor ${JSON.stringify(kind)}`,
      );
  }
}

function decodeAuditEventFields(
  object: Record<string, unknown>,
  requiredPrefix: readonly string[],
  path: CodecPath,
): AuditEvent {
  const actionValue = decodeString(object.action, at(path, "action"));
  if (!Object.hasOwn(AUDIT_EVENT_FIELDS, actionValue)) {
    codecFail(
      at(path, "action"),
      "unsupported-discriminant",
      `unsupported audit action ${JSON.stringify(actionValue)}`,
    );
  }
  const action = actionValue as AuditAction;
  const fields: readonly AuditIdField[] = AUDIT_EVENT_FIELDS[action];
  requireExactFields(
    object,
    [...requiredPrefix, "action", ...fields.map(({ field }) => field)],
    [],
    path,
  );

  const decoded: Record<string, string> = { action };
  for (const { field, kind } of fields) {
    decoded[field] = decodeServiceId(kind, object[field], at(path, field));
  }
  return decoded as AuditEvent;
}

export function decodeAuditEvent(
  input: unknown,
  path: CodecPath = [],
): AuditEvent {
  const object = decodePlainObject(input, path);
  return decodeAuditEventFields(object, [], path);
}

export function encodeAuditEvent(event: AuditEvent): JsonObject {
  return decodeAuditEvent(event) as unknown as JsonObject;
}

export function encodeCanonicalAuditEvent(event: AuditEvent): string {
  return encodeCanonicalJson(encodeAuditEvent(event));
}

/** Exact external boundary for content-free, append-only audit records. */
export function decodeAuditEnvelope(
  input: unknown,
  path: CodecPath = [],
): AuditEnvelope {
  const object = decodePlainObject(input, path);
  const event = decodeAuditEventFields(
    object,
    ["id", "installationId", "actor", "outcome", "occurredAt"],
    path,
  );
  return {
    id: decodeServiceId("AuditEnvelope", object.id, at(path, "id")),
    installationId: decodeServiceId(
      "Installation",
      object.installationId,
      at(path, "installationId"),
    ),
    actor: decodeAuditActor(object.actor, at(path, "actor")),
    outcome: decodeEnum(
      object.outcome,
      ["succeeded", "denied", "failed"] as const,
      at(path, "outcome"),
    ),
    occurredAt: decodeIsoTimestamp(object.occurredAt, at(path, "occurredAt")),
    ...event,
  } as AuditEnvelope;
}

export function encodeAuditEnvelope(envelope: AuditEnvelope): JsonObject {
  return decodeAuditEnvelope(envelope) as unknown as JsonObject;
}

export function encodeCanonicalAuditEnvelope(envelope: AuditEnvelope): string {
  return encodeCanonicalJson(encodeAuditEnvelope(envelope));
}

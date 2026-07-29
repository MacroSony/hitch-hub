import { randomBytes, randomUUID } from "node:crypto";

import type {
  Clock,
  IdSource,
  ServiceAllocatedIdKind,
} from "../model/application.js";
import type {
  Id,
  IsoTimestamp,
  OriginMessageId,
  TurnIdempotencyKey,
} from "../model/primitives.js";

const SERVICE_ALLOCATED_ID_KIND_MEMBERSHIP = Object.freeze({
  Installation: true,
  Principal: true,
  IdentityBinding: true,
  AuthenticationRequest: true,
  LocalHost: true,
  AccessGrant: true,
  Session: true,
  SessionSpec: true,
  SessionEndpointBinding: true,
  Endpoint: true,
  Turn: true,
  TurnPolicy: true,
  TurnPolicySnapshot: true,
  TurnInputSnapshot: true,
  TurnEvent: true,
  TurnMessage: true,
  TurnInteraction: true,
  TurnInteractionOption: true,
  TurnInteractionResponse: true,
  ToolInvocation: true,
  AgentDispatchAttempt: true,
  Attachment: true,
  PrivateBlob: true,
  WorkerLease: true,
  CredentialLease: true,
  AgentResumeHandle: true,
  InferenceRequestReservation: true,
  InferenceForwardingAttempt: true,
  TurnTerminalResponse: true,
  TurnResponseDelivery: true,
  TurnResponseDeliveryAttempt: true,
  AuditEnvelope: true,
  AgentDriver: true,
  AgentDriverLaunchProfile: true,
  AgentDriverPermissionMediation: true,
  AgentProfile: true,
  AgentProfileRevision: true,
  AgentResourceSnapshot: true,
  Provider: true,
  ProviderConnection: true,
  Model: true,
  ProviderCredentialBinding: true,
  Workspace: true,
  WorkspaceRevision: true,
  WorkspaceResource: true,
  ExecutionPolicy: true,
  ExecutionPolicySnapshot: true,
  ToolCapability: true,
  Extension: true,
  ExtensionRevision: true,
  ExtensionGrantSnapshot: true,
  ExtensionCapability: true,
} as const satisfies Readonly<Record<ServiceAllocatedIdKind, true>>);

const SERVICE_ALLOCATED_ID_KINDS = new Set<string>(
  Object.keys(SERVICE_ALLOCATED_ID_KIND_MEMBERSHIP),
);

/** Production wall clock. Application services receive this through composition. */
export class SystemClock implements Clock {
  now(): IsoTimestamp {
    return new Date().toISOString() as IsoTimestamp;
  }
}

/**
 * Production durable-ID and request-correlation source.
 *
 * Service IDs carry a non-authoritative kind prefix for diagnostics and a
 * cryptographically random UUID. Idempotency keys use 256 random bits because
 * they may cross a process boundary and must remain unguessable.
 */
export class CryptographicIdSource implements IdSource {
  next<Kind extends ServiceAllocatedIdKind>(kind: Kind): Id<Kind> {
    if (
      typeof kind !== "string" ||
      !SERVICE_ALLOCATED_ID_KINDS.has(kind)
    ) {
      throw new TypeError("unknown service-allocated ID kind");
    }
    return `${kind}:${randomUUID()}` as Id<Kind>;
  }

  nextTurnIdempotencyKey(): TurnIdempotencyKey {
    return `ik:${randomBytes(32).toString("base64url")}` as TurnIdempotencyKey;
  }

  nextOriginMessageId(): OriginMessageId {
    return `om:${randomUUID()}` as OriginMessageId;
  }
}

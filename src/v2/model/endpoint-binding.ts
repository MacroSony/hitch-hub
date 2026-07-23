/**
 * Compile-only v2 endpoint routing model.
 *
 * Endpoints are presentation and delivery locations. A binding connects one to
 * a session, while identity bindings and access grants independently determine
 * who may act. Shared-endpoint policies filter an already-authorized audience;
 * they never turn group membership or an @mention into session authority.
 */

import type {
  ConnectorAccountId,
  EndpointBindingPolicySnapshotId,
  EndpointId,
  ExternalEndpointId,
  InstallationId,
  IsoTimestamp,
  LocalEndpointId,
  LocalHostId,
  PrincipalId,
  SessionEndpointBindingId,
  SessionId,
} from "./primitives.js";
import type { AuditActorRef } from "./identity-access.js";

export type EndpointAddress =
  | {
      readonly kind: "connector";
      readonly connectorAccountId: ConnectorAccountId;
      readonly externalEndpointId: ExternalEndpointId;
    }
  | {
      readonly kind: "local-client";
      readonly localHostId: LocalHostId;
      readonly localEndpointId: LocalEndpointId;
    };

export type EndpointAudience =
  | {
      readonly kind: "private";
      /** Principal proven to control this private endpoint. */
      readonly principalId: PrincipalId;
    }
  | {
      readonly kind: "shared";
    };

/** Connector or local-client destination known to the trusted ingress layer. */
export interface Endpoint {
  readonly id: EndpointId;
  readonly installationId: InstallationId;
  readonly address: EndpointAddress;
  readonly audience: EndpointAudience;
  readonly createdAt: IsoTimestamp;
}

export interface PrivateEndpointBindingPolicySnapshot {
  readonly id: EndpointBindingPolicySnapshotId;
  readonly bindingId: SessionEndpointBindingId;
  readonly kind: "private";
  readonly interaction: "direct";
  readonly response: "origin";
  readonly createdBy: AuditActorRef;
  readonly createdAt: IsoTimestamp;
}

/**
 * This is an audience filter, not an authority grant. Every accepted sender
 * must also be the owner, hold session.prompt, or hold an active endpoint-
 * participant grant for this exact binding.
 */
export type SharedEndpointAudiencePolicy =
  | { readonly kind: "owner-only" }
  | { readonly kind: "authorized-principals" }
  | {
      readonly kind: "principal-allowlist";
      readonly principalIds: readonly PrincipalId[];
    };

export type SharedEndpointActivationSignal = "direct-mention" | "reply-to-agent" | "command";

export interface SharedEndpointContextLimits {
  readonly maxMessages: number;
  readonly maxAgeMs: number;
  readonly maxCharacters: number;
  readonly includeAttachments: boolean;
}

export interface SharedEndpointActivationLimits {
  readonly perSenderMinIntervalMs: number;
  readonly bindingMinIntervalMs: number;
  readonly maxQueuedTurns: number;
}

export type SharedEndpointInteractionPolicy =
  | {
      /** Every audience-authorized message is captured and starts a turn. */
      readonly kind: "respond-to-all";
    }
  | {
      /**
       * Audience-authorized messages enter a bounded context buffer. Only a
       * configured activation signal starts a turn; passive capture never runs
       * the agent or executes tools.
       */
      readonly kind: "contextual-mention";
      readonly activationSignals: readonly SharedEndpointActivationSignal[];
      readonly context: SharedEndpointContextLimits;
    }
  | {
      /** Non-activating messages are neither retained nor sent to the agent. */
      readonly kind: "mentions-only";
      readonly activationSignals: readonly SharedEndpointActivationSignal[];
    };

export type SharedEndpointResponsePolicy =
  | "same-endpoint"
  | "origin-thread"
  | "reply-to-message"
  | "direct-message-originator";

/**
 * Append-only policy for one shared binding configuration. Updating group
 * behavior creates a new snapshot and changes only the binding's current
 * policy pointer; the immutable SessionSpec is unaffected.
 */
export interface SharedEndpointBindingPolicySnapshot {
  readonly id: EndpointBindingPolicySnapshotId;
  readonly bindingId: SessionEndpointBindingId;
  readonly kind: "shared";
  readonly audience: SharedEndpointAudiencePolicy;
  readonly interaction: SharedEndpointInteractionPolicy;
  readonly response: SharedEndpointResponsePolicy;
  readonly acceptAutomatedSenders: boolean;
  readonly activationLimits: SharedEndpointActivationLimits;
  readonly createdBy: AuditActorRef;
  readonly createdAt: IsoTimestamp;
}

export type EndpointBindingPolicySnapshot =
  | PrivateEndpointBindingPolicySnapshot
  | SharedEndpointBindingPolicySnapshot;

export type SessionEndpointBindingState =
  | { readonly status: "active" }
  | {
      readonly status: "suspended";
      readonly suspendedAt: IsoTimestamp;
      readonly suspendedBy: AuditActorRef;
      readonly reason: string;
    }
  | {
      readonly status: "revoked";
      readonly revokedAt: IsoTimestamp;
      readonly revokedBy: AuditActorRef;
    };

/**
 * Mutable routing relationship between a session and an endpoint. Normal turn
 * output returns only to the originating endpoint under the policy snapshot.
 *
 * A principal with session.bind-self may create or update a private binding
 * only when Endpoint.audience names that same principal. Shared bindings and
 * their policy snapshots remain session-owner managed. Installation admins may
 * suspend or revoke bindings without gaining content-delivery authority.
 */
export interface SessionEndpointBinding {
  readonly id: SessionEndpointBindingId;
  readonly sessionId: SessionId;
  readonly endpointId: EndpointId;
  readonly policySnapshotId: EndpointBindingPolicySnapshotId;
  readonly createdByPrincipalId: PrincipalId;
  readonly state: SessionEndpointBindingState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Mutable UI routing preference, separate from both authorization and binding
 * existence. Private selections are per principal; a shared conversation has
 * one visible session selection for the whole endpoint.
 */
export type EndpointSessionSelection =
  | {
      readonly kind: "private";
      readonly endpointId: EndpointId;
      readonly principalId: PrincipalId;
      readonly selectedBindingId: SessionEndpointBindingId;
      readonly updatedAt: IsoTimestamp;
    }
  | {
      readonly kind: "shared";
      readonly endpointId: EndpointId;
      readonly selectedBindingId: SessionEndpointBindingId;
      readonly selectedByPrincipalId: PrincipalId;
      readonly updatedAt: IsoTimestamp;
    };

/**
 * Compile-only v2 endpoint routing model.
 *
 * Endpoints are presentation and delivery locations. A binding connects one to
 * a session, while identity bindings and access grants independently determine
 * who may act. V2.0 bindings are private only; shared endpoints are recognized
 * but reserved for a separately reviewed post-v2.0 binding model.
 */

import type {
  ConnectorAccountId,
  EndpointId,
  ExternalEndpointId,
  IdentityBindingId,
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
    }
  | {
      readonly kind: "remote-client";
      /** Resolved from trusted mTLS evidence; it is never caller-selected. */
      readonly identityBindingId: IdentityBindingId;
    };

export type EndpointAudience =
  | {
      readonly kind: "private";
      /** Principal proven to control this private endpoint. */
      readonly principalId: PrincipalId;
    }
  | {
      /** Reserved for a separately reviewed post-v2.0 binding model. */
      readonly kind: "shared";
    };

/** Connector, local-client, or certificate-bound remote destination. */
export interface Endpoint {
  readonly id: EndpointId;
  readonly installationId: InstallationId;
  readonly address: EndpointAddress;
  readonly audience: EndpointAudience;
  readonly createdAt: IsoTimestamp;
}

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
 * Mutable routing relationship between a session and a private endpoint. Normal
 * turn output returns only to its originating endpoint.
 *
 * A principal with session.bind-self may create or update a private binding
 * only when Endpoint.audience names that same principal. Shared endpoints are
 * recognized by ingress but cannot be bound in v2.0. Installation admins may
 * suspend or revoke bindings without gaining content-delivery authority.
 */
export interface SessionEndpointBinding {
  readonly id: SessionEndpointBindingId;
  readonly kind: "private";
  readonly sessionId: SessionId;
  readonly endpointId: EndpointId;
  readonly createdByPrincipalId: PrincipalId;
  readonly state: SessionEndpointBindingState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** Mutable private UI routing preference; it has no authorization effect. */
export interface EndpointSessionSelection {
  readonly kind: "private";
  readonly endpointId: EndpointId;
  readonly principalId: PrincipalId;
  readonly selectedBindingId: SessionEndpointBindingId;
  readonly updatedAt: IsoTimestamp;
}

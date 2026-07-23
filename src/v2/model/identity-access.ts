/**
 * Compile-only v2 identity and authorization model.
 *
 * Authentication sources resolve through revocable bindings to installation-
 * scoped principals. Roles and grants authorize actions; endpoint bindings
 * route traffic and apply audience filters but never create authority.
 */

import type {
  AccessGrantId,
  AgentProfileId,
  AuthenticationRequestId,
  AuthenticationSubjectId,
  ConnectorAccountId,
  ExecutionPolicyId,
  ExtensionId,
  IdentityBindingId,
  IdentityInvitationId,
  InstallationId,
  IsoTimestamp,
  LocalHostId,
  PrincipalId,
  ProviderCredentialBindingId,
  SessionEndpointBindingId,
  SessionId,
  TurnId,
  TurnPolicyId,
  WorkspaceId,
} from "./primitives.js";

export type PrincipalKind = "human" | "service";

export type AuditActorRef =
  | { readonly kind: "bootstrap" }
  | { readonly kind: "principal"; readonly principalId: PrincipalId }
  | { readonly kind: "system"; readonly component: string };

export type PrincipalState =
  | { readonly status: "active" }
  | {
      readonly status: "disabled";
      readonly disabledAt: IsoTimestamp;
      readonly disabledBy: AuditActorRef;
    };

/**
 * Stable installation-local authorization subject. Platform and operating-
 * system identities authenticate a principal but never replace it.
 */
export interface Principal {
  readonly id: PrincipalId;
  readonly installationId: InstallationId;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly state: PrincipalState;
  readonly createdAt: IsoTimestamp;
}

export type AuthenticationSource =
  | {
      readonly kind: "connector";
      readonly connectorAccountId: ConnectorAccountId;
    }
  | {
      readonly kind: "local-peer";
      readonly localHostId: LocalHostId;
    };

/**
 * Immutable authentication-source subject to principal assignment. The tuple
 * (installationId, source, subjectId) has at most one active binding. Rebinding
 * a subject revokes the old record and creates a new one; principalId is never
 * changed in place.
 */
export interface IdentityBinding {
  readonly id: IdentityBindingId;
  readonly installationId: InstallationId;
  readonly principalId: PrincipalId;
  readonly source: AuthenticationSource;
  readonly subjectId: AuthenticationSubjectId;
  readonly state:
    | { readonly status: "active" }
    | {
        readonly status: "revoked";
        readonly revokedAt: IsoTimestamp;
        readonly revokedBy: AuditActorRef;
      };
  readonly supersedesBindingId?: IdentityBindingId;
  readonly createdAt: IsoTimestamp;
}

export type AuthenticationAssurance = "normal" | "elevated";

/**
 * Request-specific trusted authentication result. Adapters construct this only
 * after verifying the source; principal and binding IDs are never caller input.
 */
export interface AuthenticatedPrincipal {
  readonly kind: "authenticated-principal";
  readonly principalId: PrincipalId;
  readonly identityBindingId: IdentityBindingId;
  readonly method: AuthenticationSource["kind"];
  readonly assurance: AuthenticationAssurance;
  readonly requestId: AuthenticationRequestId;
  readonly authenticatedAt: IsoTimestamp;
}

export type IdentityInvitationState =
  | { readonly status: "pending" }
  | {
      readonly status: "claimed";
      readonly claimedAt: IsoTimestamp;
      readonly identityBindingId: IdentityBindingId;
    }
  | {
      readonly status: "revoked";
      readonly revokedAt: IsoTimestamp;
      readonly revokedBy: AuditActorRef;
    };

/**
 * Short-lived, single-use proof-of-possession enrollment. The presented code or
 * its verification material belongs to the authentication service, not this
 * domain record. A claim must be authenticated by the constrained source.
 */
export interface IdentityInvitation {
  readonly id: IdentityInvitationId;
  readonly installationId: InstallationId;
  readonly principalId: PrincipalId;
  readonly source: AuthenticationSource;
  readonly createdBy: AuditActorRef;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly state: IdentityInvitationState;
}

export type AccessGrantState =
  | { readonly status: "active" }
  | {
      readonly status: "revoked";
      readonly revokedAt: IsoTimestamp;
      readonly revokedBy: AuditActorRef;
    };

export interface AccessGrantAudit {
  readonly id: AccessGrantId;
  readonly grantedBy: AuditActorRef;
  readonly createdAt: IsoTimestamp;
  readonly state: AccessGrantState;
}

export type InstallationRole = "admin" | "member";

/** Installation authority never implies access to private session content. */
export interface InstallationRoleGrant extends AccessGrantAudit {
  readonly kind: "installation-role";
  readonly installationId: InstallationId;
  readonly principalId: PrincipalId;
  readonly role: InstallationRole;
}

/** Session ownership is intrinsic to Session; only delegated roles are granted. */
export type DelegatedSessionRole = "operator" | "participant" | "approver" | "viewer";

export interface SessionRoleGrant extends AccessGrantAudit {
  readonly kind: "session-role";
  readonly sessionId: SessionId;
  readonly principalId: PrincipalId;
  readonly role: DelegatedSessionRole;
}

/**
 * Endpoint-scoped participant authority. It permits prompting only through the
 * named binding and grants no private history, control, approval, or bind access.
 */
export interface SessionEndpointParticipantGrant extends AccessGrantAudit {
  readonly kind: "session-endpoint-participant";
  readonly sessionId: SessionId;
  readonly endpointBindingId: SessionEndpointBindingId;
  readonly principalId: PrincipalId;
}

/**
 * Stable configuration resource. A use grant follows all currently and future
 * published revisions of the resource; each SessionSpec still pins exact IDs.
 */
export type SessionConfigurationResourceRef =
  | { readonly kind: "agent-profile"; readonly id: AgentProfileId }
  | { readonly kind: "workspace"; readonly id: WorkspaceId }
  | { readonly kind: "execution-policy"; readonly id: ExecutionPolicyId }
  | { readonly kind: "turn-policy"; readonly id: TurnPolicyId }
  | { readonly kind: "extension"; readonly id: ExtensionId }
  | { readonly kind: "provider-credential-binding"; readonly id: ProviderCredentialBindingId };

/** Explicit permission to use a stable configuration resource and its revisions. */
export interface SessionConfigurationUseGrant extends AccessGrantAudit {
  readonly kind: "session-configuration-use";
  readonly installationId: InstallationId;
  readonly principalId: PrincipalId;
  readonly resource: SessionConfigurationResourceRef;
}

export type AccessGrant =
  | InstallationRoleGrant
  | SessionRoleGrant
  | SessionEndpointParticipantGrant
  | SessionConfigurationUseGrant;

export type InstallationPermission =
  | "installation.read"
  | "installation.manage"
  | "installation-role.manage"
  | "principal.manage"
  | "identity-binding.manage"
  | "identity-invitation.manage"
  | "connector.manage"
  | "session-configuration.manage"
  | "credential-binding.manage"
  | "audit.read"
  | "session.create";

/**
 * Content-blind installation administrator operations. They expose operational
 * metadata and allow containment, but never prompt/read a private session or
 * create a content-delivery binding.
 */
export type BlindSessionAdministrativePermission =
  | "session.admin.inspect"
  | "session.admin.stop"
  | "session.admin.quarantine"
  | "session.admin.archive"
  | "session.admin.suspend-binding"
  | "session.admin.revoke-binding"
  | "session.admin.revoke-delegated-access";

/** Content-blind containment of one queued or active turn. */
export type BlindTurnAdministrativePermission = "turn.admin.cancel";

export type SessionPermission =
  | "session.read"
  | "session.prompt"
  | "session.control"
  | "session.approve"
  | "session.bind-self"
  | "session.manage-bindings"
  | "session.fork"
  | "session.archive"
  | "session.manage-access";

export type TurnPermission = "turn.read" | "turn.cancel" | "turn.replace";

export type AuthorizationRequest =
  | {
      readonly actor: AuthenticatedPrincipal;
      readonly scope: { readonly kind: "installation"; readonly installationId: InstallationId };
      readonly permission: InstallationPermission;
    }
  | {
      readonly actor: AuthenticatedPrincipal;
      readonly scope: { readonly kind: "session"; readonly sessionId: SessionId };
      readonly permission: SessionPermission | BlindSessionAdministrativePermission;
    }
  | {
      readonly actor: AuthenticatedPrincipal;
      readonly scope: {
        readonly kind: "session-endpoint";
        readonly sessionId: SessionId;
        readonly endpointBindingId: SessionEndpointBindingId;
      };
      readonly permission: "session.prompt-via-endpoint";
    }
  | {
      readonly actor: AuthenticatedPrincipal;
      readonly scope: {
        readonly kind: "turn";
        readonly sessionId: SessionId;
        readonly turnId: TurnId;
      };
      readonly permission: TurnPermission | BlindTurnAdministrativePermission;
    }
  | {
      readonly actor: AuthenticatedPrincipal;
      readonly scope: {
        readonly kind: "session-configuration-resource";
        readonly installationId: InstallationId;
        readonly resource: SessionConfigurationResourceRef;
      };
      readonly permission: "session-configuration.use";
    };

export type AuthorizationDecisionReason =
  | "session-owner"
  | "role-grant"
  | "endpoint-participant-grant"
  | "turn-requester"
  | "installation-admin"
  | "resource-grant"
  | "principal-disabled"
  | "identity-binding-revoked"
  | "grant-revoked"
  | "wrong-installation"
  | "insufficient-assurance"
  | "not-granted";

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: AuthorizationDecisionReason;
  readonly supportingGrantId?: AccessGrantId;
  readonly evaluatedAt: IsoTimestamp;
}

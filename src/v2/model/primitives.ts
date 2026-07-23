declare const idBrand: unique symbol;
declare const valueBrand: unique symbol;

export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };
export type BrandedString<Kind extends string> = string & { readonly [valueBrand]: Kind };

export type InstallationId = Id<"Installation">;
export type PrincipalId = Id<"Principal">;
export type IdentityBindingId = Id<"IdentityBinding">;
export type IdentityInvitationId = Id<"IdentityInvitation">;
export type AuthenticationRequestId = Id<"AuthenticationRequest">;
export type ConnectorAccountId = Id<"ConnectorAccount">;
export type LocalHostId = Id<"LocalHost">;
export type AccessGrantId = Id<"AccessGrant">;

export type SessionId = Id<"Session">;
export type SessionSpecId = Id<"SessionSpec">;
export type SessionEndpointBindingId = Id<"SessionEndpointBinding">;
export type EndpointBindingPolicySnapshotId = Id<"EndpointBindingPolicySnapshot">;
export type EndpointId = Id<"Endpoint">;
export type TurnId = Id<"Turn">;
export type WorkerLeaseId = Id<"WorkerLease">;
export type AgentResumeHandleId = Id<"AgentResumeHandle">;

export type AgentDriverId = Id<"AgentDriver">;
export type AgentProfileId = Id<"AgentProfile">;
export type AgentProfileRevisionId = Id<"AgentProfileRevision">;
export type ProviderId = Id<"Provider">;
export type ModelId = Id<"Model">;
export type ProviderCredentialBindingId = Id<"ProviderCredentialBinding">;

export type WorkspaceId = Id<"Workspace">;
export type WorkspaceRevisionId = Id<"WorkspaceRevision">;
export type WorkspaceResourceId = Id<"WorkspaceResource">;

export type ExecutionPolicyId = Id<"ExecutionPolicy">;
export type ExecutionPolicySnapshotId = Id<"ExecutionPolicySnapshot">;
export type ToolCapabilityId = Id<"ToolCapability">;

export type ExtensionId = Id<"Extension">;
export type ExtensionRevisionId = Id<"ExtensionRevision">;
export type ExtensionGrantSnapshotId = Id<"ExtensionGrantSnapshot">;
export type ExtensionCapabilityId = Id<"ExtensionCapability">;

export type IsoTimestamp = BrandedString<"IsoTimestamp">;
export type AuthenticationSubjectId = BrandedString<"AuthenticationSubjectId">;
export type ExternalEndpointId = BrandedString<"ExternalEndpointId">;
export type LocalEndpointId = BrandedString<"LocalEndpointId">;
export type CanonicalHostPath = BrandedString<"CanonicalHostPath">;
export type SandboxPath = BrandedString<"SandboxPath">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

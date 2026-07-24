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
export type EndpointId = Id<"Endpoint">;
export type TurnId = Id<"Turn">;
export type TurnPolicyId = Id<"TurnPolicy">;
export type TurnPolicySnapshotId = Id<"TurnPolicySnapshot">;
export type TurnInputSnapshotId = Id<"TurnInputSnapshot">;
export type TurnEventId = Id<"TurnEvent">;
export type TurnMessageId = Id<"TurnMessage">;
export type TurnInteractionId = Id<"TurnInteraction">;
export type TurnInteractionOptionId = Id<"TurnInteractionOption">;
export type TurnInteractionResponseId = Id<"TurnInteractionResponse">;
export type InferenceRequestReservationId =
  Id<"InferenceRequestReservation">;
export type ToolInvocationId = Id<"ToolInvocation">;
export type AttachmentId = Id<"Attachment">;
export type WorkerLeaseId = Id<"WorkerLease">;
export type CredentialLeaseId = Id<"CredentialLease">;
export type AgentResumeHandleId = Id<"AgentResumeHandle">;

export type AgentDriverId = Id<"AgentDriver">;
export type AgentDriverPermissionMediationId =
  Id<"AgentDriverPermissionMediation">;
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
export type OriginMessageId = BrandedString<"OriginMessageId">;
export type TurnIdempotencyKey = BrandedString<"TurnIdempotencyKey">;
export type AgentProtocolMessageId = BrandedString<"AgentProtocolMessageId">;
export type AgentProtocolToolCallId = BrandedString<"AgentProtocolToolCallId">;
export type AgentProtocolInteractionOptionId =
  BrandedString<"AgentProtocolInteractionOptionId">;
export type AgentProtocolPermissionOptionKind =
  BrandedString<"AgentProtocolPermissionOptionKind">;
export type ProviderApiProtocolId = BrandedString<"ProviderApiProtocolId">;
export type BrokerEndpoint = BrandedString<"BrokerEndpoint">;
export type BrokerCapabilityToken = BrandedString<"BrokerCapabilityToken">;
export type CanonicalHostPath = BrandedString<"CanonicalHostPath">;
export type SandboxPath = BrandedString<"SandboxPath">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Pure deterministic bootstrap publication projection; allocation belongs to V2-004. */

import type {
  BootstrapPublicationArtifactBindings,
  BootstrapPublicationRecords,
  BootstrapPublicationReferenceBindings,
} from "../model/application.js";
import type { JsonObject } from "../model/primitives.js";
import type {
  AccessGrantId,
  AgentProfileId,
  AgentProfileRevisionId,
  AuthenticationSubjectId,
  CanonicalHostPath,
  ConfigurationReference,
  EndpointId,
  ExecutionPolicyId,
  ExecutionPolicySnapshotId,
  ExtensionId,
  IdentityBindingId,
  InstallationId,
  IntegrityDigest,
  IsoTimestamp,
  LocalEndpointId,
  LocalHostId,
  PrincipalId,
  ProviderConnectionId,
  ProviderCredentialBindingId,
  SandboxPath,
  TurnPolicyId,
  TurnPolicySnapshotId,
  WorkspaceId,
  WorkspaceResourceId,
  WorkspaceRevisionId,
} from "../model/primitives.js";
import { decodeBoundedArray, decodeBoundedString, decodeIntegrityDigest, decodeIsoTimestamp, decodePositiveSafeInteger, decodeSandboxPath, decodeServiceId, digestCanonicalJson } from "../codecs/index.js";
import { codecFail, type CodecPath } from "../codecs/errors.js";
import { at, decodeLiteral, decodePlainObject, requireExactFields } from "../codecs/structure.js";
import { decodeFirstSliceInstallationConfiguration, type FirstSliceInstallationConfiguration } from "./configuration.js";
import {
  decodeAgentProfileRevision, decodeAgentResourceSnapshot, decodeConfigurationIdentity,
  decodeExecutionPolicySnapshot, decodeExtensionGrantSnapshot, decodeExtensionRevision,
  decodeInstallationHardCeilings, decodeProviderConnectionSpec, decodeProviderCredentialBinding,
  decodeTurnPolicySnapshot, decodeWorkspaceRevision, decodeCanonicalHostPath, freeze, validateBootstrapGraph,
} from "./records.js";

const PATH = (path: CodecPath, key: string): CodecPath => at(path, key);

export interface TrustedCanonicalWorkspaceBinding {
  readonly bindingRef: ConfigurationReference;
  readonly workspaceReference: ConfigurationReference;
  readonly revision: number;
  readonly root: {
    readonly id: WorkspaceResourceId;
    readonly canonicalHostPath: CanonicalHostPath;
    readonly sandboxPath: SandboxPath;
    readonly maximumAccess: "read-write";
  };
  readonly mounts: readonly [];
}

/** All IDs/timing originate at the caller that owns allocation and audit. */
export interface BootstrapPublicationProjectionInput {
  readonly configuration: FirstSliceInstallationConfiguration;
  readonly resolved: {
    readonly timestamp: IsoTimestamp;
    readonly auditActor: { readonly kind: "bootstrap" };
    readonly serviceSchemaDigest: IntegrityDigest;
    readonly sourceReferences: {
      readonly installationRef: ConfigurationReference;
      readonly principalRef: ConfigurationReference;
      readonly localHostRef: ConfigurationReference;
      readonly identityBindingRef: ConfigurationReference;
      readonly subjectRef: ConfigurationReference;
      readonly subjectResolution: ConfigurationReference;
      readonly endpointRef: ConfigurationReference;
      readonly workspaceBindingRef: ConfigurationReference;
    };
    readonly ids: {
      readonly installationId: InstallationId; readonly ownerId: PrincipalId; readonly identityBindingId: IdentityBindingId;
      readonly endpointId: EndpointId; readonly installationRoleGrantId: AccessGrantId; readonly localHostId: LocalHostId; readonly authenticationSubjectId: AuthenticationSubjectId; readonly localEndpointId: LocalEndpointId;
      readonly workspaceId: WorkspaceId; readonly workspaceRevisionId: WorkspaceRevisionId;
      readonly profileId: AgentProfileId; readonly profileRevisionId: AgentProfileRevisionId;
      readonly executionPolicyId: ExecutionPolicyId; readonly executionPolicySnapshotId: ExecutionPolicySnapshotId;
      readonly turnPolicyId: TurnPolicyId; readonly turnPolicySnapshotId: TurnPolicySnapshotId;
      readonly providerConnectionId: ProviderConnectionId; readonly credentialBindingId: ProviderCredentialBindingId;
      readonly configurationUseGrantIds: { readonly workspace: AccessGrantId; readonly profile: AccessGrantId; readonly executionPolicy: AccessGrantId; readonly turnPolicy: AccessGrantId; readonly credentialBinding: AccessGrantId; };
      readonly extensionUseGrantIds: readonly { readonly extensionId: ExtensionId; readonly grantId: AccessGrantId }[];
    };
    readonly trustedWorkspaceBinding: TrustedCanonicalWorkspaceBinding;
  };
}

export type PublicationArtifactBindingPlan =
  BootstrapPublicationArtifactBindings;

export interface BootstrapPublicationProjection {
  readonly records: BootstrapPublicationRecords;
}

export function decodeBootstrapPublicationProjectionInput(input: unknown, path: CodecPath = []): BootstrapPublicationProjectionInput {
  const object = decodePlainObject(input, path); requireExactFields(object, ["configuration", "resolved"], [], path);
  const configuration = decodeFirstSliceInstallationConfiguration(object.configuration, PATH(path, "configuration"));
  const resolved = decodePlainObject(object.resolved, PATH(path, "resolved")); requireExactFields(resolved, ["timestamp", "auditActor", "serviceSchemaDigest", "sourceReferences", "ids", "trustedWorkspaceBinding"], [], PATH(path, "resolved"));
  const actor = decodePlainObject(resolved.auditActor, PATH(PATH(path, "resolved"), "auditActor")); requireExactFields(actor, ["kind"], [], PATH(PATH(path, "resolved"), "auditActor"));
  const sourceReferences = decodePlainObject(resolved.sourceReferences, PATH(PATH(path, "resolved"), "sourceReferences")); requireExactFields(sourceReferences, ["installationRef", "principalRef", "localHostRef", "identityBindingRef", "subjectRef", "subjectResolution", "endpointRef", "workspaceBindingRef"], [], PATH(PATH(path, "resolved"), "sourceReferences"));
  const ids = decodePlainObject(resolved.ids, PATH(PATH(path, "resolved"), "ids"));
  const idFields = ["installationId", "ownerId", "identityBindingId", "endpointId", "installationRoleGrantId", "localHostId", "authenticationSubjectId", "localEndpointId", "workspaceId", "workspaceRevisionId", "profileId", "profileRevisionId", "executionPolicyId", "executionPolicySnapshotId", "turnPolicyId", "turnPolicySnapshotId", "providerConnectionId", "credentialBindingId", "configurationUseGrantIds", "extensionUseGrantIds"];
  requireExactFields(ids, idFields, [], PATH(PATH(path, "resolved"), "ids"));
  const grantIds = decodePlainObject(ids.configurationUseGrantIds, PATH(PATH(PATH(path, "resolved"), "ids"), "configurationUseGrantIds")); requireExactFields(grantIds, ["workspace", "profile", "executionPolicy", "turnPolicy", "credentialBinding"], [], PATH(PATH(PATH(path, "resolved"), "ids"), "configurationUseGrantIds"));
  const binding = decodePlainObject(resolved.trustedWorkspaceBinding, PATH(PATH(path, "resolved"), "trustedWorkspaceBinding")); requireExactFields(binding, ["bindingRef", "workspaceReference", "revision", "root", "mounts"], [], PATH(PATH(path, "resolved"), "trustedWorkspaceBinding"));
  const root = decodePlainObject(binding.root, PATH(PATH(PATH(path, "resolved"), "trustedWorkspaceBinding"), "root")); requireExactFields(root, ["id", "canonicalHostPath", "sandboxPath", "maximumAccess"], [], PATH(PATH(PATH(path, "resolved"), "trustedWorkspaceBinding"), "root"));
  decodeBoundedArray(
    binding.mounts,
    (_item, itemPath) =>
      codecFail(
        itemPath,
        "unsupported-discriminant",
        "first-slice workspace mounts must be empty",
      ),
    { maximumItems: 0 },
    PATH(PATH(PATH(path, "resolved"), "trustedWorkspaceBinding"), "mounts"),
  );
  const extensionUseGrantIds = decodeBoundedArray(ids.extensionUseGrantIds, (entry, itemPath) => { const item = decodePlainObject(entry, itemPath); requireExactFields(item, ["extensionId", "grantId"], [], itemPath); return freeze({ extensionId: decodeServiceId("Extension", item.extensionId, PATH(itemPath, "extensionId")), grantId: decodeServiceId("AccessGrant", item.grantId, PATH(itemPath, "grantId")) }); }, { maximumItems: 32, uniqueBy: (entry) => entry.extensionId }, PATH(PATH(PATH(path, "resolved"), "ids"), "extensionUseGrantIds"));
  if (new Set(extensionUseGrantIds.map((entry) => entry.extensionId)).size !== extensionUseGrantIds.length) codecFail(PATH(PATH(path, "resolved"), "ids"), "duplicate-item", "duplicate extension use grant");
  const strictReference = (
    value: unknown,
    valuePath: CodecPath,
  ): ConfigurationReference =>
    decodeBoundedString(value, {
      minimumLength: 1,
      maximumLength: 128,
      pattern: /^[a-z][a-z0-9-]{0,127}$/u,
      label: "trusted reference",
    }, valuePath) as ConfigurationReference;
  const opaqueResolvedId = (value: unknown, valuePath: CodecPath) =>
    decodeBoundedString(
      value,
      {
        minimumLength: 1,
        maximumLength: 128,
        pattern:
          /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u,
        label: "resolved opaque identifier",
      },
      valuePath,
    );
  const canonicalHostPath = decodeCanonicalHostPath(root.canonicalHostPath, PATH(PATH(PATH(PATH(path, "resolved"), "trustedWorkspaceBinding"), "root"), "canonicalHostPath")) as CanonicalHostPath;
  const decodedSourceReferences = freeze({ installationRef: strictReference(sourceReferences.installationRef, []), principalRef: strictReference(sourceReferences.principalRef, []), localHostRef: strictReference(sourceReferences.localHostRef, []), identityBindingRef: strictReference(sourceReferences.identityBindingRef, []), subjectRef: strictReference(sourceReferences.subjectRef, []), subjectResolution: strictReference(sourceReferences.subjectResolution, []), endpointRef: strictReference(sourceReferences.endpointRef, []), workspaceBindingRef: strictReference(sourceReferences.workspaceBindingRef, []) });
  if (decodedSourceReferences.installationRef !== configuration.bootstrap.installationRef || decodedSourceReferences.principalRef !== configuration.bootstrap.owner.principalRef || decodedSourceReferences.localHostRef !== configuration.bootstrap.owner.localHostRef || decodedSourceReferences.identityBindingRef !== configuration.bootstrap.owner.identityBindingRef || decodedSourceReferences.subjectRef !== configuration.bootstrap.owner.subjectRef || decodedSourceReferences.subjectResolution !== configuration.bootstrap.owner.subjectResolution || decodedSourceReferences.endpointRef !== configuration.localEndpoint.endpointRef || decodedSourceReferences.workspaceBindingRef !== configuration.workspaceBinding.bindingRef) codecFail(PATH(PATH(path, "resolved"), "sourceReferences"), "invalid-format", "resolved source reference drift");
  return freeze({ configuration, resolved: freeze({ timestamp: decodeIsoTimestamp(resolved.timestamp, PATH(PATH(path, "resolved"), "timestamp")), auditActor: freeze({ kind: decodeLiteral(actor.kind, "bootstrap", PATH(PATH(PATH(path, "resolved"), "auditActor"), "kind")) }), serviceSchemaDigest: decodeIntegrityDigest(resolved.serviceSchemaDigest, PATH(PATH(path, "resolved"), "serviceSchemaDigest")), sourceReferences: decodedSourceReferences, ids: freeze({ installationId: decodeServiceId("Installation", ids.installationId, []), ownerId: decodeServiceId("Principal", ids.ownerId, []), identityBindingId: decodeServiceId("IdentityBinding", ids.identityBindingId, []), endpointId: decodeServiceId("Endpoint", ids.endpointId, []), installationRoleGrantId: decodeServiceId("AccessGrant", ids.installationRoleGrantId, []), localHostId: decodeServiceId("LocalHost", ids.localHostId, []), authenticationSubjectId: opaqueResolvedId(ids.authenticationSubjectId, []) as AuthenticationSubjectId, localEndpointId: opaqueResolvedId(ids.localEndpointId, []) as LocalEndpointId, workspaceId: decodeServiceId("Workspace", ids.workspaceId, []), workspaceRevisionId: decodeServiceId("WorkspaceRevision", ids.workspaceRevisionId, []), profileId: decodeServiceId("AgentProfile", ids.profileId, []), profileRevisionId: decodeServiceId("AgentProfileRevision", ids.profileRevisionId, []), executionPolicyId: decodeServiceId("ExecutionPolicy", ids.executionPolicyId, []), executionPolicySnapshotId: decodeServiceId("ExecutionPolicySnapshot", ids.executionPolicySnapshotId, []), turnPolicyId: decodeServiceId("TurnPolicy", ids.turnPolicyId, []), turnPolicySnapshotId: decodeServiceId("TurnPolicySnapshot", ids.turnPolicySnapshotId, []), providerConnectionId: decodeServiceId("ProviderConnection", ids.providerConnectionId, []), credentialBindingId: decodeServiceId("ProviderCredentialBinding", ids.credentialBindingId, []), configurationUseGrantIds: freeze({ workspace: decodeServiceId("AccessGrant", grantIds.workspace, []), profile: decodeServiceId("AccessGrant", grantIds.profile, []), executionPolicy: decodeServiceId("AccessGrant", grantIds.executionPolicy, []), turnPolicy: decodeServiceId("AccessGrant", grantIds.turnPolicy, []), credentialBinding: decodeServiceId("AccessGrant", grantIds.credentialBinding, []) }), extensionUseGrantIds }), trustedWorkspaceBinding: freeze({ bindingRef: strictReference(binding.bindingRef, []), workspaceReference: strictReference(binding.workspaceReference, []), revision: decodePositiveSafeInteger(binding.revision, []), root: freeze({ id: decodeServiceId("WorkspaceResource", root.id, []), canonicalHostPath, sandboxPath: decodeSandboxPath(root.sandboxPath, []), maximumAccess: decodeLiteral(root.maximumAccess, "read-write", []) }), mounts: [] as const }) }) });
}

export function projectBootstrapPublication(input: unknown): BootstrapPublicationProjection {
  return projectDecodedBootstrapPublication(decodeBootstrapPublicationProjectionInput(input));
}

function projectDecodedBootstrapPublication(input: BootstrapPublicationProjectionInput): BootstrapPublicationProjection {
  const config = input.configuration; const r = input.resolved; const timestamp = r.timestamp;
  if (r.ids.profileId !== config.profile.id || r.ids.executionPolicyId !== config.executionPolicy.id || r.ids.turnPolicyId !== config.turnPolicy.id || r.ids.providerConnectionId !== config.provider.connection.id || r.ids.credentialBindingId !== config.credentialBinding.id) codecFail([], "invalid-format", "configured stable ID and resolved ID drift");
  const configuredExtensionIds = config.resources.extensions.grants.map((grant) => grant.extensionId);
  if (new Set(configuredExtensionIds).size !== configuredExtensionIds.length || !sameStringSet(configuredExtensionIds, r.ids.extensionUseGrantIds.map((grant) => grant.extensionId))) codecFail([], "invalid-format", "extension grant resolution drift");
  verifyProviderDigests(config);
  const workspace = decodeConfigurationIdentity({ id: r.ids.workspaceId, installationId: r.ids.installationId, reference: config.workspaceBinding.workspaceRef, displayName: config.workspaceBinding.displayName, createdAt: timestamp }, "workspace") as BootstrapPublicationRecords["workspace"];
  const workspaceRevision = decodeWorkspaceRevision({ id: r.ids.workspaceRevisionId, workspaceId: r.ids.workspaceId, revision: config.workspaceBinding.revision, displayName: config.workspaceBinding.displayName, root: r.trustedWorkspaceBinding.root, mounts: r.trustedWorkspaceBinding.mounts, createdAt: timestamp });
  if (r.trustedWorkspaceBinding.bindingRef !== config.workspaceBinding.bindingRef || r.trustedWorkspaceBinding.workspaceReference !== config.workspaceBinding.workspaceRef || r.trustedWorkspaceBinding.revision !== config.workspaceBinding.revision || r.trustedWorkspaceBinding.root.sandboxPath !== config.workspaceBinding.sandboxPath || r.trustedWorkspaceBinding.root.id !== config.workspaceBinding.workspaceResourceRef) codecFail([], "invalid-format", "trusted workspace binding drift");
  const executionPolicy = decodeConfigurationIdentity({ id: r.ids.executionPolicyId, installationId: r.ids.installationId, reference: config.executionPolicy.reference, displayName: config.executionPolicy.displayName, createdAt: timestamp }, "execution-policy") as BootstrapPublicationRecords["executionPolicy"];
  const executionPolicySnapshot = decodeExecutionPolicySnapshot({ id: r.ids.executionPolicySnapshotId, policyId: r.ids.executionPolicyId, revision: config.executionPolicy.revision, sandbox: config.executionPolicy.sandbox, workspaceFilesystem: config.executionPolicy.workspaceFilesystem, resourceGrants: config.executionPolicy.resourceGrants.map((grant) => ({ resourceId: grant.resourceRef, access: grant.access })), process: config.executionPolicy.process, network: config.executionPolicy.network, tools: config.executionPolicy.tools, limits: config.executionPolicy.limits, createdAt: timestamp });
  const turnPolicy = decodeConfigurationIdentity({ id: r.ids.turnPolicyId, installationId: r.ids.installationId, reference: config.turnPolicy.reference, displayName: config.turnPolicy.displayName, createdAt: timestamp }, "turn-policy") as BootstrapPublicationRecords["turnPolicy"];
  const { id: _turnId, reference: _turnReference, displayName: _turnDisplayName, ...turnSnapshot } = config.turnPolicy;
  const turnPolicySnapshot = decodeTurnPolicySnapshot({ id: r.ids.turnPolicySnapshotId, policyId: r.ids.turnPolicyId, ...turnSnapshot, createdAt: timestamp });
  const artifacts: {
    declarative: {
      agentResourceSnapshotId: string;
      artifactReference: string;
      integrityDigest: string;
      kind: "skill" | "prompt-template" | "theme";
    }[];
    extensions: {
      extensionRevisionId: string;
      artifactReference: string;
      integrityDigest: string;
    }[];
    provider: {
      providerConnectionId: string;
      bridgeId: string;
      bridgeArtifactDigest: string;
      nativeStack: "pi-ai";
      nativeStackVersion: string;
      nativeStackDigest: string;
      nativeCatalogDigest: string;
    };
  } = {
    declarative: [],
    extensions: [],
    provider: {
      providerConnectionId: r.ids.providerConnectionId,
      bridgeId: config.provider.connection.transport.bridgeId,
      bridgeArtifactDigest:
        config.provider.connection.transport.bridgeArtifactDigest,
      nativeStack: config.provider.connection.transport.nativeStack,
      nativeStackVersion:
        config.provider.connection.transport.nativeStackVersion,
      nativeStackDigest:
        config.provider.connection.transport.nativeStackDigest,
      nativeCatalogDigest:
        config.provider.connection.transport.nativeCatalogDigest,
    },
  };
  const resources = ([...config.resources.skills.snapshots, ...config.resources.promptTemplates.snapshots, ...config.resources.themes.snapshots]);
  const agentResourceSnapshots = resources.map((resource) => { artifacts.declarative.push({ agentResourceSnapshotId: resource.snapshotId, artifactReference: resource.artifactRef, integrityDigest: resource.integrityDigest, kind: resource.kind }); return decodeAgentResourceSnapshot({ id: resource.snapshotId, kind: resource.kind, source: { kind: "profile" }, displayName: resource.displayName, integrityDigest: resource.integrityDigest, createdAt: timestamp }); });
  const extensionRevisions = config.resources.extensions.grants.map((grant) => { artifacts.extensions.push({ extensionRevisionId: grant.extensionRevisionId, artifactReference: grant.revisionArtifactRef, integrityDigest: grant.revisionIntegrityDigest }); return decodeExtensionRevision({ id: grant.extensionRevisionId, extensionId: grant.extensionId, revision: grant.revision, displayName: grant.displayName, integrityDigest: grant.revisionIntegrityDigest, configurationSchema: grant.configurationSchema, createdAt: timestamp }); });
  const extensions = config.resources.extensions.grants.map(
    (grant) =>
      decodeConfigurationIdentity(
        {
          id: grant.extensionId,
          installationId: r.ids.installationId,
          reference: grant.extensionRef,
          displayName: grant.displayName,
          createdAt: timestamp,
        },
        "extension",
      ) as BootstrapPublicationRecords["extensions"][number],
  );
  const extensionGrantSnapshots = config.resources.extensions.grants.map((grant) => decodeExtensionGrantSnapshot({ id: grant.grantSnapshotId, extensionId: grant.extensionId, extensionRevisionId: grant.extensionRevisionId, integrityDigest: grant.grantIntegrityDigest, loading: "explicit-pinned", configuration: grant.configuration, promptLifecycle: grant.promptLifecycle, capabilities: grant.capabilityIds, createdAt: timestamp }));
  const profile = decodeConfigurationIdentity({ id: r.ids.profileId, installationId: r.ids.installationId, reference: config.profile.reference, displayName: config.profile.displayName, createdAt: timestamp }, "agent-profile") as BootstrapPublicationRecords["agentProfile"];
  const profileRevision = decodeAgentProfileRevision({ id: r.ids.profileRevisionId, profileId: r.ids.profileId, revision: config.profile.revision, driverId: config.profile.driverId, displayName: config.profile.displayName, providers: config.profile.providers.map((provider) => ({ providerId: provider.providerId, providerConnectionId: provider.connectionId, models: { kind: "allowlist", modelIds: provider.modelIds } })), defaultModel: config.profile.defaultModel, defaultReasoning: config.profile.defaultReasoning, resourcePolicy: config.profile.resourcePolicy, agentResourceSnapshotIds: agentResourceSnapshots.map((resource) => resource.id), extensionGrantSnapshotIds: extensionGrantSnapshots.map((grant) => grant.id), configuration: config.profile.configuration, createdAt: timestamp });
  const transport = config.provider.connection.transport;
  const connection = decodeProviderConnectionSpec({ id: r.ids.providerConnectionId, installationId: r.ids.installationId, providerId: config.provider.connection.providerId, displayName: config.provider.connection.displayName, transport: { mode: transport.mode, credentialCustody: transport.credentialCustody, bridgeId: transport.bridgeId, nativeStack: transport.nativeStack, nativeStackVersion: transport.nativeStackVersion, bridgeProtocolVersion: transport.bridgeProtocolVersion, nativeCatalogDigest: transport.nativeCatalogDigest, credentialResolverId: transport.credentialResolverId, nativeRetries: transport.nativeRetries, invocation: transport.invocation }, allowedUpstreamOrigins: config.provider.connection.allowedOrigins, models: [{ providerId: config.provider.connection.model.providerId, modelId: config.provider.connection.model.id, apiProtocolId: config.provider.connection.model.apiProtocol, contextWindowTokens: config.provider.connection.model.contextWindowTokens, maximumOutputTokens: config.provider.connection.model.maximumOutputTokens, tokenEstimatorId: config.provider.connection.model.tokenEstimatorId, imageInput: config.provider.connection.model.imageInput, tools: config.provider.connection.model.tools, reasoning: config.provider.connection.model.reasoning, nativeModelMetadata: config.provider.connection.model.nativeModelMetadata, integrityDigest: config.provider.connection.model.integrityDigest }], integrityDigest: config.provider.connection.integrityDigest, createdAt: timestamp });
  const credential = decodeProviderCredentialBinding({ id: r.ids.credentialBindingId, installationId: r.ids.installationId, providerId: config.credentialBinding.providerId, custody: config.credentialBinding.custody, displayName: config.credentialBinding.displayName, state: { status: config.credentialBinding.state }, createdBy: r.auditActor, createdAt: timestamp, updatedAt: timestamp });
  const accessGrants: Array<
    BootstrapPublicationRecords["accessGrants"][number]
  > = [
    { id: r.ids.installationRoleGrantId, kind: "installation-role", installationId: r.ids.installationId, principalId: r.ids.ownerId, role: config.ownerAccess.installationRole, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } },
    { id: r.ids.configurationUseGrantIds.workspace, kind: "session-configuration-use", installationId: r.ids.installationId, principalId: r.ids.ownerId, resource: { kind: "workspace", id: workspace.id }, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } },
    { id: r.ids.configurationUseGrantIds.profile, kind: "session-configuration-use", installationId: r.ids.installationId, principalId: r.ids.ownerId, resource: { kind: "agent-profile", id: profile.id }, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } },
    { id: r.ids.configurationUseGrantIds.executionPolicy, kind: "session-configuration-use", installationId: r.ids.installationId, principalId: r.ids.ownerId, resource: { kind: "execution-policy", id: executionPolicy.id }, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } },
    { id: r.ids.configurationUseGrantIds.turnPolicy, kind: "session-configuration-use", installationId: r.ids.installationId, principalId: r.ids.ownerId, resource: { kind: "turn-policy", id: turnPolicy.id }, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } },
    { id: r.ids.configurationUseGrantIds.credentialBinding, kind: "session-configuration-use", installationId: r.ids.installationId, principalId: r.ids.ownerId, resource: { kind: "provider-credential-binding", id: credential.id }, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } },
    ...extensions.map((extension): BootstrapPublicationRecords["accessGrants"][number] => { const grant = r.ids.extensionUseGrantIds.find((entry) => entry.extensionId === extension.id); if (!grant) codecFail([], "invalid-format", "missing required extension use grant"); return { id: grant.grantId, kind: "session-configuration-use", installationId: r.ids.installationId, principalId: r.ids.ownerId, resource: { kind: "extension", id: extension.id }, grantedBy: r.auditActor, createdAt: timestamp, state: { status: "active" } }; }),
  ];
  if (new Set(accessGrants.map((grant) => grant.id)).size !== accessGrants.length) codecFail([], "duplicate-item", "duplicate access grant ID");
  validateConfiguredAccess(config, accessGrants, extensions);
  const refs = r.sourceReferences;
  const referenceBindings: BootstrapPublicationReferenceBindings = freeze({
    installation: freeze({
      reference: refs.installationRef,
      installationId: r.ids.installationId,
      displayName: config.bootstrap.displayName,
    }),
    owner: freeze({
      reference: refs.principalRef,
      principalId: r.ids.ownerId,
    }),
    localHost: freeze({
      reference: refs.localHostRef,
      localHostId: r.ids.localHostId,
    }),
    identityBinding: freeze({
      reference: refs.identityBindingRef,
      identityBindingId: r.ids.identityBindingId,
    }),
    subject: freeze({
      reference: refs.subjectRef,
      resolution: refs.subjectResolution,
      authenticationSubjectId: r.ids.authenticationSubjectId,
    }),
    endpoint: freeze({
      reference: refs.endpointRef,
      endpointId: r.ids.endpointId,
      localEndpointId: r.ids.localEndpointId,
    }),
    workspace: freeze({
      bindingReference: refs.workspaceBindingRef,
      workspaceId: r.ids.workspaceId,
      workspaceRevisionId: r.ids.workspaceRevisionId,
    }),
  });
  if (connection.transport.mode !== "native-library-sidecar") {
    codecFail([], "unsupported-discriminant", "first-slice provider transport drift");
  }
  const artifactBindings: BootstrapPublicationArtifactBindings = freeze({
    declarative: artifacts.declarative.map((binding, index) => freeze({
      agentResourceSnapshotId: agentResourceSnapshots[index]!.id,
      artifactReference:
        binding.artifactReference as ConfigurationReference,
      integrityDigest: agentResourceSnapshots[index]!.integrityDigest,
      kind: binding.kind,
    })),
    extensions: artifacts.extensions.map((binding, index) => freeze({
      extensionRevisionId: extensionRevisions[index]!.id,
      artifactReference:
        binding.artifactReference as ConfigurationReference,
      integrityDigest: extensionRevisions[index]!.integrityDigest,
    })),
    provider: freeze({
      providerConnectionId: connection.id,
      bridgeId: connection.transport.bridgeId,
      bridgeArtifactDigest: decodeIntegrityDigest(
        config.provider.connection.transport.bridgeArtifactDigest,
      ),
      nativeStack: connection.transport.nativeStack,
      nativeStackVersion: connection.transport.nativeStackVersion,
      nativeStackDigest: decodeIntegrityDigest(
        config.provider.connection.transport.nativeStackDigest,
      ),
      nativeCatalogDigest: connection.transport.nativeCatalogDigest,
    }),
  });
  validateArtifactBindings(
    artifacts,
    agentResourceSnapshots,
    extensionRevisions,
    connection,
  );
  const records: BootstrapPublicationRecords = freeze({
    installation: freeze({ id: r.ids.installationId, serviceSchema: freeze({ service: "hitch", generation: "v2", schemaVersion: 1, sqliteApplicationId: 0x48495432, schemaDigest: r.serviceSchemaDigest }), hardCeilings: decodeInstallationHardCeilings(config.installationHardCeilings), createdAt: timestamp, updatedAt: timestamp }),
    owner: freeze({ id: r.ids.ownerId, installationId: r.ids.installationId, kind: config.bootstrap.owner.kind, displayName: config.bootstrap.owner.displayName, state: { status: "active" }, createdAt: timestamp }),
    localIdentityBinding: freeze({ id: r.ids.identityBindingId, installationId: r.ids.installationId, principalId: r.ids.ownerId, source: { kind: "local-peer", localHostId: r.ids.localHostId }, subjectId: r.ids.authenticationSubjectId, state: { status: "active" }, createdAt: timestamp }),
    localEndpoint: freeze({ id: r.ids.endpointId, installationId: r.ids.installationId, address: { kind: "local-client", localHostId: r.ids.localHostId, localEndpointId: r.ids.localEndpointId }, audience: { kind: "private", principalId: r.ids.ownerId }, createdAt: timestamp }),
    accessGrants: freeze(accessGrants),
    workspace,
    workspaceRevision,
    agentProfile: profile,
    agentProfileRevision: profileRevision,
    executionPolicy,
    executionPolicySnapshot,
    turnPolicy,
    turnPolicySnapshot,
    agentResourceSnapshots,
    extensions,
    extensionRevisions,
    extensionGrantSnapshots,
    providerConnection: connection,
    providerCredentialBinding: credential,
    referenceBindings,
    artifactBindings,
  });
  validateBootstrapGraph({ workspace, workspaceRevision, agentProfile: profile, agentProfileRevision: profileRevision, executionPolicy, executionPolicySnapshot, turnPolicy, turnPolicySnapshot, agentResourceSnapshots, extensions, extensionRevisions, extensionGrantSnapshots, providerConnection: connection, providerCredentialBinding: credential, installationId: r.ids.installationId, hardCeilings: records.installation.hardCeilings });
  return freeze({ records });
}

function validateArtifactBindings(plan: { readonly declarative: readonly { readonly agentResourceSnapshotId: string; readonly artifactReference: string; readonly integrityDigest: string; readonly kind: string }[]; readonly extensions: readonly { readonly extensionRevisionId: string; readonly artifactReference: string; readonly integrityDigest: string }[]; readonly provider: { readonly providerConnectionId: string; readonly bridgeId: string; readonly nativeStack: string; readonly nativeStackVersion: string; readonly nativeCatalogDigest: string } }, resources: readonly { readonly id: string; readonly kind: string; readonly integrityDigest: string }[], extensions: readonly { readonly id: string; readonly integrityDigest: string }[], connection: BootstrapPublicationRecords["providerConnection"]): void {
  const resourceIds = new Set(plan.declarative.map((item) => item.agentResourceSnapshotId)); const extensionIds = new Set(plan.extensions.map((item) => item.extensionRevisionId));
  if (resourceIds.size !== plan.declarative.length || extensionIds.size !== plan.extensions.length || new Set(plan.declarative.map((item) => item.artifactReference)).size !== plan.declarative.length || new Set(plan.extensions.map((item) => item.artifactReference)).size !== plan.extensions.length) codecFail([], "duplicate-item", "conflicting artifact binding");
  if (resources.length !== plan.declarative.length || extensions.length !== plan.extensions.length) codecFail([], "invalid-format", "artifact binding cardinality drift");
  for (const item of plan.declarative) { const resource = resources.find((entry) => entry.id === item.agentResourceSnapshotId); if (!resource || resource.kind !== item.kind || resource.integrityDigest !== item.integrityDigest) codecFail([], "invalid-format", "declarative artifact binding drift"); }
  for (const item of plan.extensions) { const extension = extensions.find((entry) => entry.id === item.extensionRevisionId); if (!extension || extension.integrityDigest !== item.integrityDigest) codecFail([], "invalid-format", "extension artifact binding drift"); }
  if (
    connection.transport.mode !== "native-library-sidecar" ||
    plan.provider.providerConnectionId !== connection.id ||
    plan.provider.bridgeId !== connection.transport.bridgeId ||
    plan.provider.nativeStack !== connection.transport.nativeStack ||
    plan.provider.nativeStackVersion !== connection.transport.nativeStackVersion ||
    plan.provider.nativeCatalogDigest !== connection.transport.nativeCatalogDigest
  ) {
    codecFail([], "invalid-format", "provider artifact binding drift");
  }
}

function verifyProviderDigests(config: FirstSliceInstallationConfiguration): void {
  const connection = config.provider.connection;
  const model = connection.model;
  const modelCoverage = {
    providerId: model.providerId, id: model.id, apiProtocol: model.apiProtocol,
    contextWindowTokens: model.contextWindowTokens, maximumOutputTokens: model.maximumOutputTokens,
    tokenEstimatorId: model.tokenEstimatorId, imageInput: model.imageInput, tools: model.tools,
    reasoning: model.reasoning, nativeModelMetadata: model.nativeModelMetadata,
  };
  if (digestCanonicalJson(modelCoverage) !== model.integrityDigest) codecFail([], "invalid-format", "model integrity digest drift");
  const transport = connection.transport;
  const catalog = digestCanonicalJson({
    piVersion: transport.nativeStackVersion, nativeStackDigest: transport.nativeStackDigest,
    connectionId: connection.id, allowedOrigins: connection.allowedOrigins,
    model: { id: model.id, name: "GPT-5.4 mini", api: model.apiProtocol, provider: model.providerId, reasoning: true, input: ["text", "image"], contextWindow: model.contextWindowTokens, maxTokens: model.maximumOutputTokens },
  });
  if (catalog !== transport.nativeCatalogDigest) codecFail([], "invalid-format", "native catalog digest drift");
  const connectionDigest = digestCanonicalJson({
    id: connection.id, providerId: connection.providerId, displayName: connection.displayName,
    transport, allowedOrigins: connection.allowedOrigins, modelIntegrityDigest: model.integrityDigest,
    credentialBindingId: config.credentialBinding.id,
  });
  if (connectionDigest !== connection.integrityDigest) codecFail([], "invalid-format", "provider connection digest drift");
}

function validateConfiguredAccess(config: FirstSliceInstallationConfiguration, grants: readonly { readonly kind: string; readonly resource?: { readonly kind: string; readonly id: string } }[], extensions: readonly { readonly id: string; readonly reference: string }[]): void {
  const configured = config.ownerAccess.configurationUse;
  const expectedPairs = new Set([`workspace:${config.workspaceBinding.workspaceRef}`, `agent-profile:${config.profile.reference}`, `execution-policy:${config.executionPolicy.reference}`, `turn-policy:${config.turnPolicy.reference}`, `provider-credential-binding:${config.credentialBinding.id}`]);
  if (configured.length !== expectedPairs.size || new Set(configured.map((grant) => `${grant.kind}:${grant.reference}`)).size !== configured.length || configured.some((grant) => !expectedPairs.has(`${grant.kind}:${grant.reference}`))) codecFail([], "invalid-format", "owner configuration-use references drift");
  const uses = grants.filter((grant) => grant.kind === "session-configuration-use");
  if (uses.length !== 5 + extensions.length) codecFail([], "invalid-format", "configuration-use grant cardinality drift");
  const extensionIds = new Set(extensions.map((extension) => extension.id));
  if (extensionIds.size !== extensions.length || uses.filter((grant) => grant.resource?.kind === "extension").some((grant) => !extensionIds.has(grant.resource!.id))) codecFail([], "invalid-format", "extension use grant drift");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)); }

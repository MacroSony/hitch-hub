/** Strict, pure codecs for the immutable records published by bootstrap. */

import { posix } from "node:path";

import type {
  AgentProfileResourceIdentity,
  ExecutionPolicyResourceIdentity,
  ExtensionResourceIdentity,
  TurnPolicyResourceIdentity,
  WorkspaceResourceIdentity,
} from "../model/application.js";
import type { ProviderConnectionSpec, ProviderModelManifest } from "../model/provider-broker.js";
import type { InstallationHardCeilings } from "../model/records.js";
import type { ProviderCredentialBinding } from "../model/runtime-security.js";
import type {
  AgentProfileRevision, AgentResourceSnapshot, ExecutionPolicySnapshot,
  ExtensionGrantSnapshot, ExtensionRevision, SessionSpec,
  WorkspaceRevision,
} from "../model/session.js";
import type { TurnPolicySnapshot } from "../model/turn.js";
import type { JsonObject } from "../model/primitives.js";
import {
  decodeAgentImageMimeType, decodeBoundedArray, decodeBoundedString,
  decodeIntegrityDigest, decodeIsoTimestamp, decodePositiveSafeInteger,
  decodeSandboxPath, decodeSecretFreeJsonValue, decodeServiceId,
  decodeTrustedUpstreamOrigin,
} from "../codecs/index.js";
import { codecFail, type CodecPath } from "../codecs/errors.js";
import { at as oneAt, decodeEnum, decodeLiteral, decodePlainObject, requireExactFields } from "../codecs/structure.js";

const MAX_ITEMS = 32;
const REFERENCE = /^[a-z][a-z0-9-]{0,127}$/u;
const SEMANTIC_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const at = (path: CodecPath, ...segments: (string | number)[]): CodecPath => segments.reduce(oneAt, path);

function literal<T extends string | number | boolean>(input: unknown, value: T, path: CodecPath): T {
  if (input !== value) codecFail(path, "invalid-format", `expected ${JSON.stringify(value)}`);
  return value;
}

function exact(input: unknown, fields: readonly string[], path: CodecPath): Record<string, unknown> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, fields, [], path);
  return object;
}

function reference(input: unknown, path: CodecPath): string {
  return decodeBoundedString(input, { minimumLength: 1, maximumLength: 128, pattern: REFERENCE, label: "configuration reference" }, path);
}

function decodeClosedEmptyObject(input: unknown, path: CodecPath): JsonObject {
  exact(input, [], path);
  return freeze({});
}

function decodeClosedEmptyConfigurationSchema(
  input: unknown,
  path: CodecPath,
): JsonObject {
  const object = exact(
    input,
    ["type", "properties", "required", "additionalProperties"],
    path,
  );
  exact(object.properties, [], at(path, "properties"));
  const required = decodeBoundedArray(
    object.required,
    (_item, itemPath) =>
      codecFail(
        itemPath,
        "unsupported-discriminant",
        "first-slice extension configuration schema must be closed and empty",
      ),
    { maximumItems: 0 },
    at(path, "required"),
  );
  return freeze({
    type: decodeLiteral(object.type, "object", at(path, "type")),
    properties: freeze({}),
    required,
    additionalProperties: literal(
      object.additionalProperties,
      false,
      at(path, "additionalProperties"),
    ),
  });
}

function decodeNativeModelMetadata(
  input: unknown,
  path: CodecPath,
): JsonObject {
  const object = exact(input, ["transport", "streaming"], path);
  return freeze({
    transport: reference(object.transport, at(path, "transport")),
    streaming: decodeLiteral(object.streaming, "sse", at(path, "streaming")),
  });
}

/** A canonical host path exists only in trusted workspace-resolution input. */
export function decodeCanonicalHostPath(input: unknown, path: CodecPath = []): string {
  const value = decodeBoundedString(
    input,
    { minimumLength: 2, maximumLength: 4_096, label: "trusted canonical host path" },
    path,
  );
  if (
    !value.startsWith("/") || value === "/" || value.endsWith("/") ||
    value.includes("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value) ||
    posix.normalize(value) !== value || value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    codecFail(path, "invalid-format", "expected a normalized absolute canonical host path");
  }
  return value;
}

function displayName(input: unknown, path: CodecPath): string {
  const value = decodeBoundedString(
    input,
    { minimumLength: 1, maximumLength: 128, label: "display name" },
    path,
  );
  decodeSecretFreeJsonValue(value, { forbiddenPaths: "all" }, path);
  return value;
}

function positiveRevision(input: unknown, path: CodecPath): number {
  return decodePositiveSafeInteger(input, path);
}

function oneOf<T extends string>(input: unknown, values: readonly T[], path: CodecPath): T {
  return decodeEnum(input, values, path) as T;
}

export type ConfigurationIdentity = WorkspaceResourceIdentity | AgentProfileResourceIdentity | ExecutionPolicyResourceIdentity | TurnPolicyResourceIdentity | ExtensionResourceIdentity;

export function decodeConfigurationIdentity(input: unknown, kind: "workspace" | "agent-profile" | "execution-policy" | "turn-policy" | "extension", path: CodecPath = []): ConfigurationIdentity {
  const object = exact(input, ["id", "installationId", "reference", "displayName", "createdAt"], path);
  const idKind = kind === "workspace" ? "Workspace" : kind === "agent-profile" ? "AgentProfile" : kind === "execution-policy" ? "ExecutionPolicy" : kind === "turn-policy" ? "TurnPolicy" : "Extension";
  return freeze({
    id: decodeServiceId(idKind, object.id, at(path, "id")),
    installationId: decodeServiceId("Installation", object.installationId, at(path, "installationId")),
    reference: reference(object.reference, at(path, "reference")),
    displayName: displayName(object.displayName, at(path, "displayName")),
    createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")),
  }) as ConfigurationIdentity;
}

function decodeWorkspaceResource(input: unknown, path: CodecPath) {
  const object = exact(input, ["id", "canonicalHostPath", "sandboxPath", "maximumAccess"], path);
  const host = decodeCanonicalHostPath(object.canonicalHostPath, at(path, "canonicalHostPath"));
  return freeze({
    id: decodeServiceId("WorkspaceResource", object.id, at(path, "id")),
    canonicalHostPath: host as WorkspaceRevision["root"]["canonicalHostPath"],
    sandboxPath: decodeSandboxPath(object.sandboxPath, at(path, "sandboxPath")),
    maximumAccess: oneOf(object.maximumAccess, ["read-only", "read-write"], at(path, "maximumAccess")),
  });
}

export function decodeWorkspaceRevision(input: unknown, path: CodecPath = []): WorkspaceRevision {
  const object = exact(input, ["id", "workspaceId", "revision", "displayName", "root", "mounts", "createdAt"], path);
  const root = decodeWorkspaceResource(object.root, at(path, "root"));
  const mounts = decodeBoundedArray(object.mounts, decodeWorkspaceResource, { maximumItems: MAX_ITEMS, uniqueBy: (x) => x.id }, at(path, "mounts"));
  if (mounts.some((mount) => mount.id === root.id)) codecFail(at(path, "mounts"), "duplicate-item", "workspace root cannot also be a mount");
  const resources = [root, ...mounts];
  if (
    new Set(resources.map((resource) => resource.canonicalHostPath)).size !==
      resources.length ||
    new Set(resources.map((resource) => resource.sandboxPath)).size !==
      resources.length
  ) {
    codecFail(
      at(path, "mounts"),
      "duplicate-item",
      "workspace resources must have unique canonical and sandbox paths",
    );
  }
  return freeze({ id: decodeServiceId("WorkspaceRevision", object.id, at(path, "id")), workspaceId: decodeServiceId("Workspace", object.workspaceId, at(path, "workspaceId")), revision: positiveRevision(object.revision, at(path, "revision")), displayName: displayName(object.displayName, at(path, "displayName")), root, mounts, createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

function decodeResourcePolicy(input: unknown, path: CodecPath) {
  const object = exact(input, ["skills", "promptTemplates", "themes", "extensions"], path);
  const declarative = (value: unknown, valuePath: CodecPath) => {
    const item = exact(value, ["mode", "projectResources"], valuePath);
    return freeze({ mode: decodeLiteral(item.mode, "pinned", at(valuePath, "mode")), projectResources: oneOf(item.projectResources, ["disabled", "snapshot-at-session-creation"], at(valuePath, "projectResources")) });
  };
  const extension = exact(object.extensions, ["mode", "discovery", "hotReload", "promptLifecycle"], at(path, "extensions"));
  return freeze({
    skills: declarative(object.skills, at(path, "skills")), promptTemplates: declarative(object.promptTemplates, at(path, "promptTemplates")), themes: declarative(object.themes, at(path, "themes")),
    extensions: freeze({ mode: decodeLiteral(extension.mode, "granted-only", at(path, "extensions", "mode")), discovery: decodeLiteral(extension.discovery, "explicit-only", at(path, "extensions", "discovery")), hotReload: literal(extension.hotReload, false, at(path, "extensions", "hotReload")), promptLifecycle: decodeLiteral(extension.promptLifecycle, "agent-loop-preserving", at(path, "extensions", "promptLifecycle")) }),
  });
}

function decodeReasoning(input: unknown, path: CodecPath) {
  const object = exact(input, ["kind"], path);
  return freeze({ kind: decodeLiteral(object.kind, "agent-default", at(path, "kind")) });
}

export function decodeAgentProfileRevision(input: unknown, path: CodecPath = []): AgentProfileRevision {
  const object = exact(input, ["id", "profileId", "revision", "driverId", "displayName", "providers", "defaultModel", "defaultReasoning", "resourcePolicy", "agentResourceSnapshotIds", "extensionGrantSnapshotIds", "configuration", "createdAt"], path);
  const providers = decodeBoundedArray(object.providers, (value, itemPath) => {
    const item = exact(value, ["providerId", "providerConnectionId", "models"], itemPath);
    const models = exact(item.models, ["kind", "modelIds"], at(itemPath, "models"));
    return freeze({ providerId: decodeServiceId("Provider", item.providerId, at(itemPath, "providerId")), providerConnectionId: decodeServiceId("ProviderConnection", item.providerConnectionId, at(itemPath, "providerConnectionId")), models: freeze({ kind: decodeLiteral(models.kind, "allowlist", at(itemPath, "models", "kind")), modelIds: decodeBoundedArray(models.modelIds, (v, p) => decodeServiceId("Model", v, p), { minimumItems: 1, maximumItems: MAX_ITEMS, uniqueBy: String }, at(itemPath, "models", "modelIds")) }) });
  }, { minimumItems: 1, maximumItems: MAX_ITEMS, uniqueBy: (x) => x.providerId }, at(path, "providers"));
  const defaultModel = exact(object.defaultModel, ["providerId", "modelId"], at(path, "defaultModel"));
  return freeze({
    id: decodeServiceId("AgentProfileRevision", object.id, at(path, "id")), profileId: decodeServiceId("AgentProfile", object.profileId, at(path, "profileId")), revision: positiveRevision(object.revision, at(path, "revision")), driverId: decodeServiceId("AgentDriver", object.driverId, at(path, "driverId")), displayName: displayName(object.displayName, at(path, "displayName")), providers,
    defaultModel: freeze({ providerId: decodeServiceId("Provider", defaultModel.providerId, at(path, "defaultModel", "providerId")), modelId: decodeServiceId("Model", defaultModel.modelId, at(path, "defaultModel", "modelId")) }), defaultReasoning: decodeReasoning(object.defaultReasoning, at(path, "defaultReasoning")), resourcePolicy: decodeResourcePolicy(object.resourcePolicy, at(path, "resourcePolicy")),
    agentResourceSnapshotIds: decodeBoundedArray(object.agentResourceSnapshotIds, (v, p) => decodeServiceId("AgentResourceSnapshot", v, p), { maximumItems: MAX_ITEMS, uniqueBy: String }, at(path, "agentResourceSnapshotIds")), extensionGrantSnapshotIds: decodeBoundedArray(object.extensionGrantSnapshotIds, (v, p) => decodeServiceId("ExtensionGrantSnapshot", v, p), { maximumItems: MAX_ITEMS, uniqueBy: String }, at(path, "extensionGrantSnapshotIds")), configuration: decodeClosedEmptyObject(object.configuration, at(path, "configuration")), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")),
  });
}

export function decodeExecutionPolicySnapshot(input: unknown, path: CodecPath = []): ExecutionPolicySnapshot {
  const object = exact(input, ["id", "policyId", "revision", "sandbox", "workspaceFilesystem", "resourceGrants", "process", "network", "tools", "limits", "createdAt"], path);
  const limits = exact(object.limits, ["memoryBytes", "maxProcesses", "temporaryStorageBytes", "outputBytes"], at(path, "limits"));
  return freeze({ id: decodeServiceId("ExecutionPolicySnapshot", object.id, at(path, "id")), policyId: decodeServiceId("ExecutionPolicy", object.policyId, at(path, "policyId")), revision: positiveRevision(object.revision, at(path, "revision")), sandbox: decodeLiteral(object.sandbox, "required", at(path, "sandbox")), workspaceFilesystem: oneOf(object.workspaceFilesystem, ["none", "read-only", "read-write"], at(path, "workspaceFilesystem")), resourceGrants: decodeBoundedArray(object.resourceGrants, (v, p) => { const grant = exact(v, ["resourceId", "access"], p); return freeze({ resourceId: decodeServiceId("WorkspaceResource", grant.resourceId, at(p, "resourceId")), access: oneOf(grant.access, ["read-only", "read-write"], at(p, "access")) }); }, { maximumItems: MAX_ITEMS, uniqueBy: (x) => x.resourceId }, at(path, "resourceGrants")), process: decodeLiteral(object.process, "deny", at(path, "process")), network: decodeLiteral(object.network, "deny", at(path, "network")), tools: decodeBoundedArray(object.tools, (v, p) => decodeServiceId("ToolCapability", v, p), { minimumItems: 1, maximumItems: MAX_ITEMS, uniqueBy: String }, at(path, "tools")), limits: freeze({ memoryBytes: decodePositiveSafeInteger(limits.memoryBytes, at(path, "limits", "memoryBytes")), maxProcesses: decodePositiveSafeInteger(limits.maxProcesses, at(path, "limits", "maxProcesses")), temporaryStorageBytes: decodePositiveSafeInteger(limits.temporaryStorageBytes, at(path, "limits", "temporaryStorageBytes")), outputBytes: decodePositiveSafeInteger(limits.outputBytes, at(path, "limits", "outputBytes")) }), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

export function decodeTurnPolicySnapshot(input: unknown, path: CodecPath = []): TurnPolicySnapshot {
  const object = exact(input, ["id", "policyId", "revision", "admission", "timing", "interaction", "retry", "inference", "output", "createdAt"], path);
  const admission = exact(object.admission, ["whenBusy", "maxQueuedTurns"], at(path, "admission")); const timing = exact(object.timing, ["initialActiveWorkMs", "toolExtensionMs", "maximumActiveWorkMs", "interactionWaitMs"], at(path, "timing")); const interaction = exact(object.interaction, ["approval", "onApprovalTimeout", "inputRequests", "onInputTimeout"], at(path, "interaction")); const retry = exact(object.retry, ["maximumBeforeAcceptanceAttempts", "afterPossibleAcceptance"], at(path, "retry")); const inference = exact(object.inference, ["maximumProviderRequests", "maximumTotalTokens", "maximumOutputTokensPerRequest"], at(path, "inference")); const output = exact(object.output, ["progressDelivery", "checkpointIntervalMs", "maximumCheckpointCharacters", "persistFinalMessages", "persistRawReasoning", "persistRawToolInputOutput"], at(path, "output"));
  const p = (value: unknown, key: string, base: CodecPath) => decodePositiveSafeInteger(value, at(base, key));
  const decodedTiming = freeze({ initialActiveWorkMs: p(timing.initialActiveWorkMs, "initialActiveWorkMs", at(path, "timing")), toolExtensionMs: p(timing.toolExtensionMs, "toolExtensionMs", at(path, "timing")), maximumActiveWorkMs: p(timing.maximumActiveWorkMs, "maximumActiveWorkMs", at(path, "timing")), interactionWaitMs: p(timing.interactionWaitMs, "interactionWaitMs", at(path, "timing")) });
  if (decodedTiming.initialActiveWorkMs > decodedTiming.maximumActiveWorkMs) codecFail(at(path, "timing"), "out-of-range", "initial work budget cannot exceed maximum active work");
  return freeze({ id: decodeServiceId("TurnPolicySnapshot", object.id, at(path, "id")), policyId: decodeServiceId("TurnPolicy", object.policyId, at(path, "policyId")), revision: positiveRevision(object.revision, at(path, "revision")), admission: freeze({ whenBusy: decodeLiteral(admission.whenBusy, "bounded-fifo", at(path, "admission", "whenBusy")), maxQueuedTurns: p(admission.maxQueuedTurns, "maxQueuedTurns", at(path, "admission")) }), timing: decodedTiming, interaction: freeze({ approval: oneOf(interaction.approval, ["deny", "policy-only", "ask-authorized-approver"], at(path, "interaction", "approval")), onApprovalTimeout: decodeLiteral(interaction.onApprovalTimeout, "deny", at(path, "interaction", "onApprovalTimeout")), inputRequests: oneOf(interaction.inputRequests, ["deny", "ask-originator"], at(path, "interaction", "inputRequests")), onInputTimeout: decodeLiteral(interaction.onInputTimeout, "no-input", at(path, "interaction", "onInputTimeout")) }), retry: freeze({ maximumBeforeAcceptanceAttempts: p(retry.maximumBeforeAcceptanceAttempts, "maximumBeforeAcceptanceAttempts", at(path, "retry")), afterPossibleAcceptance: decodeLiteral(retry.afterPossibleAcceptance, "never", at(path, "retry", "afterPossibleAcceptance")) }), inference: freeze({ maximumProviderRequests: p(inference.maximumProviderRequests, "maximumProviderRequests", at(path, "inference")), maximumTotalTokens: p(inference.maximumTotalTokens, "maximumTotalTokens", at(path, "inference")), maximumOutputTokensPerRequest: p(inference.maximumOutputTokensPerRequest, "maximumOutputTokensPerRequest", at(path, "inference")) }), output: freeze({ progressDelivery: decodeLiteral(output.progressDelivery, "checkpoints", at(path, "output", "progressDelivery")), checkpointIntervalMs: p(output.checkpointIntervalMs, "checkpointIntervalMs", at(path, "output")), maximumCheckpointCharacters: p(output.maximumCheckpointCharacters, "maximumCheckpointCharacters", at(path, "output")), persistFinalMessages: literal(output.persistFinalMessages, true, at(path, "output", "persistFinalMessages")), persistRawReasoning: literal(output.persistRawReasoning, false, at(path, "output", "persistRawReasoning")), persistRawToolInputOutput: literal(output.persistRawToolInputOutput, false, at(path, "output", "persistRawToolInputOutput")) }), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

export function decodeInstallationHardCeilings(input: unknown, path: CodecPath = []): InstallationHardCeilings {
  const keys = ["maximumQueuedTurnsPerSession", "maximumActiveWorkMs", "maximumInteractionWaitMs", "maximumBeforeAcceptanceAttempts", "maximumProviderRequestsPerTurn", "maximumTotalInferenceTokensPerTurn", "maximumOutputTokensPerInferenceRequest", "maximumImageBytesPerAttachment", "maximumBrokerRequestBytes", "maximumConcurrentBrokerRequests", "maximumMemoryBytes", "maximumProcesses", "maximumTemporaryStorageBytes", "maximumAgentOutputBytes"] as const;
  const object = exact(input, keys, path); const output: Record<string, number> = {};
  for (const key of keys) output[key] = decodePositiveSafeInteger(object[key], at(path, key));
  return freeze(output) as unknown as InstallationHardCeilings;
}

export function decodeAgentResourceSnapshot(input: unknown, path: CodecPath = []): AgentResourceSnapshot {
  const object = exact(input, ["id", "kind", "source", "displayName", "integrityDigest", "createdAt"], path);
  const source = exact(object.source, ["kind"], at(path, "source"));
  return freeze({ id: decodeServiceId("AgentResourceSnapshot", object.id, at(path, "id")), kind: oneOf(object.kind, ["skill", "prompt-template", "theme"], at(path, "kind")), source: freeze({ kind: decodeLiteral(source.kind, "profile", at(path, "source", "kind")) }), displayName: displayName(object.displayName, at(path, "displayName")), integrityDigest: decodeIntegrityDigest(object.integrityDigest, at(path, "integrityDigest")), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

export function decodeExtensionRevision(input: unknown, path: CodecPath = []): ExtensionRevision {
  const object = exact(input, ["id", "extensionId", "revision", "displayName", "integrityDigest", "configurationSchema", "createdAt"], path);
  return freeze({ id: decodeServiceId("ExtensionRevision", object.id, at(path, "id")), extensionId: decodeServiceId("Extension", object.extensionId, at(path, "extensionId")), revision: positiveRevision(object.revision, at(path, "revision")), displayName: displayName(object.displayName, at(path, "displayName")), integrityDigest: decodeIntegrityDigest(object.integrityDigest, at(path, "integrityDigest")), configurationSchema: decodeClosedEmptyConfigurationSchema(object.configurationSchema, at(path, "configurationSchema")), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

export function decodeExtensionGrantSnapshot(input: unknown, path: CodecPath = []): ExtensionGrantSnapshot {
  const object = exact(input, ["id", "extensionId", "extensionRevisionId", "integrityDigest", "loading", "configuration", "promptLifecycle", "capabilities", "createdAt"], path);
  return freeze({ id: decodeServiceId("ExtensionGrantSnapshot", object.id, at(path, "id")), extensionId: decodeServiceId("Extension", object.extensionId, at(path, "extensionId")), extensionRevisionId: decodeServiceId("ExtensionRevision", object.extensionRevisionId, at(path, "extensionRevisionId")), integrityDigest: decodeIntegrityDigest(object.integrityDigest, at(path, "integrityDigest")), loading: decodeLiteral(object.loading, "explicit-pinned", at(path, "loading")), configuration: decodeClosedEmptyObject(object.configuration, at(path, "configuration")), promptLifecycle: decodeLiteral(object.promptLifecycle, "agent-loop-preserving", at(path, "promptLifecycle")), capabilities: decodeBoundedArray(object.capabilities, (v, p) => decodeServiceId("ExtensionCapability", v, p), { maximumItems: MAX_ITEMS, uniqueBy: String }, at(path, "capabilities")), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

export function decodeProviderModelManifest(input: unknown, path: CodecPath = []): ProviderModelManifest {
  const object = exact(input, ["providerId", "modelId", "apiProtocolId", "contextWindowTokens", "maximumOutputTokens", "tokenEstimatorId", "imageInput", "tools", "reasoning", "nativeModelMetadata", "integrityDigest"], path);
  const image = exact(object.imageInput, ["kind", "acceptedMimeTypes", "maximumImagesPerRequest", "maximumImageBytesEach", "maximumTotalImageBytesPerRequest"], at(path, "imageInput"));
  const reasoning = exact(object.reasoning, ["kind", "supportedEfforts", "agentDefaultSupported"], at(path, "reasoning"));
  const contextWindowTokens = decodePositiveSafeInteger(object.contextWindowTokens, at(path, "contextWindowTokens"));
  const maximumOutputTokens = decodePositiveSafeInteger(object.maximumOutputTokens, at(path, "maximumOutputTokens"));
  if (maximumOutputTokens > contextWindowTokens) codecFail(at(path, "maximumOutputTokens"), "out-of-range", "maximum output cannot exceed context window");
  const maximumImageBytesEach = decodePositiveSafeInteger(image.maximumImageBytesEach, at(path, "imageInput", "maximumImageBytesEach"));
  const maximumTotalImageBytesPerRequest = decodePositiveSafeInteger(image.maximumTotalImageBytesPerRequest, at(path, "imageInput", "maximumTotalImageBytesPerRequest"));
  if (maximumTotalImageBytesPerRequest < maximumImageBytesEach) codecFail(at(path, "imageInput"), "out-of-range", "total image bytes cannot be smaller than each-image limit");
  return freeze({ providerId: decodeServiceId("Provider", object.providerId, at(path, "providerId")), modelId: decodeServiceId("Model", object.modelId, at(path, "modelId")), apiProtocolId: reference(object.apiProtocolId, at(path, "apiProtocolId")) as ProviderModelManifest["apiProtocolId"], contextWindowTokens, maximumOutputTokens, tokenEstimatorId: reference(object.tokenEstimatorId, at(path, "tokenEstimatorId")) as ProviderModelManifest["tokenEstimatorId"], imageInput: freeze({ kind: decodeLiteral(image.kind, "supported", at(path, "imageInput", "kind")), acceptedMimeTypes: decodeBoundedArray(image.acceptedMimeTypes, decodeAgentImageMimeType, { minimumItems: 1, maximumItems: 4, uniqueBy: String }, at(path, "imageInput", "acceptedMimeTypes")) as ProviderModelManifest["imageInput"] extends { readonly acceptedMimeTypes: infer M } ? M : never, maximumImagesPerRequest: decodePositiveSafeInteger(image.maximumImagesPerRequest, at(path, "imageInput", "maximumImagesPerRequest")), maximumImageBytesEach, maximumTotalImageBytesPerRequest }), tools: decodeLiteral(object.tools, "supported", at(path, "tools")), reasoning: freeze({ kind: decodeLiteral(reasoning.kind, "portable-efforts", at(path, "reasoning", "kind")), supportedEfforts: decodeBoundedArray(reasoning.supportedEfforts, (v, p) => oneOf(v, ["none", "low", "medium", "high"], p), { minimumItems: 1, maximumItems: 4, uniqueBy: String }, at(path, "reasoning", "supportedEfforts")) as ProviderModelManifest["reasoning"] extends { readonly supportedEfforts: infer E } ? E : never, agentDefaultSupported: literal(reasoning.agentDefaultSupported, true, at(path, "reasoning", "agentDefaultSupported")) }), nativeModelMetadata: decodeNativeModelMetadata(object.nativeModelMetadata, at(path, "nativeModelMetadata")), integrityDigest: decodeIntegrityDigest(object.integrityDigest, at(path, "integrityDigest")) });
}

export function decodeProviderConnectionSpec(input: unknown, path: CodecPath = []): ProviderConnectionSpec {
  const object = exact(input, ["id", "installationId", "providerId", "displayName", "transport", "allowedUpstreamOrigins", "models", "integrityDigest", "createdAt"], path);
  const transport = exact(object.transport, ["mode", "credentialCustody", "bridgeId", "nativeStack", "nativeStackVersion", "bridgeProtocolVersion", "nativeCatalogDigest", "credentialResolverId", "nativeRetries", "invocation"], at(path, "transport"));
  return freeze({ id: decodeServiceId("ProviderConnection", object.id, at(path, "id")), installationId: decodeServiceId("Installation", object.installationId, at(path, "installationId")), providerId: decodeServiceId("Provider", object.providerId, at(path, "providerId")), displayName: displayName(object.displayName, at(path, "displayName")), transport: freeze({ mode: decodeLiteral(transport.mode, "native-library-sidecar", at(path, "transport", "mode")), credentialCustody: decodeLiteral(transport.credentialCustody, "hitch-control-plane", at(path, "transport", "credentialCustody")), bridgeId: reference(transport.bridgeId, at(path, "transport", "bridgeId")) as ProviderConnectionSpec["transport"] extends infer T ? T extends { readonly bridgeId: infer B } ? B : never : never, nativeStack: decodeLiteral(transport.nativeStack, "pi-ai", at(path, "transport", "nativeStack")), nativeStackVersion: decodeBoundedString(transport.nativeStackVersion, { minimumLength: 5, maximumLength: 64, pattern: SEMANTIC_VERSION, label: "native stack semantic version" }, at(path, "transport", "nativeStackVersion")), bridgeProtocolVersion: decodePositiveSafeInteger(transport.bridgeProtocolVersion, at(path, "transport", "bridgeProtocolVersion")), nativeCatalogDigest: decodeIntegrityDigest(transport.nativeCatalogDigest, at(path, "transport", "nativeCatalogDigest")), credentialResolverId: reference(transport.credentialResolverId, at(path, "transport", "credentialResolverId")) as ProviderConnectionSpec["transport"] extends infer T ? T extends { readonly credentialResolverId: infer R } ? R : never : never, nativeRetries: decodeLiteral(transport.nativeRetries, "disabled", at(path, "transport", "nativeRetries")), invocation: decodeLiteral(transport.invocation, "structured-native-request", at(path, "transport", "invocation")) }), allowedUpstreamOrigins: decodeBoundedArray(object.allowedUpstreamOrigins, decodeTrustedUpstreamOrigin, { minimumItems: 1, maximumItems: 8, uniqueBy: String }, at(path, "allowedUpstreamOrigins")), models: decodeBoundedArray(object.models, decodeProviderModelManifest, { minimumItems: 1, maximumItems: MAX_ITEMS, uniqueBy: (x) => `${x.providerId}:${x.modelId}` }, at(path, "models")), integrityDigest: decodeIntegrityDigest(object.integrityDigest, at(path, "integrityDigest")), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) }) as unknown as ProviderConnectionSpec;
}

export function decodeProviderCredentialBinding(input: unknown, path: CodecPath = []): ProviderCredentialBinding {
  const object = exact(input, ["id", "installationId", "providerId", "custody", "displayName", "state", "createdBy", "createdAt", "updatedAt"], path);
  const state = exact(object.state, ["status"], at(path, "state")); const actor = exact(object.createdBy, ["kind"], at(path, "createdBy"));
  return freeze({ id: decodeServiceId("ProviderCredentialBinding", object.id, at(path, "id")), installationId: decodeServiceId("Installation", object.installationId, at(path, "installationId")), providerId: decodeServiceId("Provider", object.providerId, at(path, "providerId")), custody: decodeLiteral(object.custody, "hitch-control-plane", at(path, "custody")), displayName: displayName(object.displayName, at(path, "displayName")), state: freeze({ status: decodeLiteral(state.status, "active", at(path, "state", "status")) }), createdBy: freeze({ kind: decodeLiteral(actor.kind, "bootstrap", at(path, "createdBy", "kind")) }), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")), updatedAt: decodeIsoTimestamp(object.updatedAt, at(path, "updatedAt")) });
}

export function decodeSessionSpec(input: unknown, path: CodecPath = []): SessionSpec {
  const object = exact(input, ["id", "schemaVersion", "agentProfileRevisionId", "workspaceRevisionId", "executionPolicySnapshotId", "turnPolicySnapshotId", "agentResourceSnapshotIds", "extensionGrantSnapshotIds", "providerBindings", "createdAt"], path);
  return freeze({ id: decodeServiceId("SessionSpec", object.id, at(path, "id")), schemaVersion: literal(object.schemaVersion, 1, at(path, "schemaVersion")), agentProfileRevisionId: decodeServiceId("AgentProfileRevision", object.agentProfileRevisionId, at(path, "agentProfileRevisionId")), workspaceRevisionId: decodeServiceId("WorkspaceRevision", object.workspaceRevisionId, at(path, "workspaceRevisionId")), executionPolicySnapshotId: decodeServiceId("ExecutionPolicySnapshot", object.executionPolicySnapshotId, at(path, "executionPolicySnapshotId")), turnPolicySnapshotId: decodeServiceId("TurnPolicySnapshot", object.turnPolicySnapshotId, at(path, "turnPolicySnapshotId")), agentResourceSnapshotIds: decodeBoundedArray(object.agentResourceSnapshotIds, (v, p) => decodeServiceId("AgentResourceSnapshot", v, p), { maximumItems: MAX_ITEMS, uniqueBy: String }, at(path, "agentResourceSnapshotIds")), extensionGrantSnapshotIds: decodeBoundedArray(object.extensionGrantSnapshotIds, (v, p) => decodeServiceId("ExtensionGrantSnapshot", v, p), { maximumItems: MAX_ITEMS, uniqueBy: String }, at(path, "extensionGrantSnapshotIds")), providerBindings: decodeBoundedArray(object.providerBindings, (v, p) => { const b = exact(v, ["providerId", "providerConnectionId", "credentialBindingId"], p); return freeze({ providerId: decodeServiceId("Provider", b.providerId, at(p, "providerId")), providerConnectionId: decodeServiceId("ProviderConnection", b.providerConnectionId, at(p, "providerConnectionId")), credentialBindingId: decodeServiceId("ProviderCredentialBinding", b.credentialBindingId, at(p, "credentialBindingId")) }); }, { minimumItems: 1, maximumItems: MAX_ITEMS, uniqueBy: (x) => x.providerId }, at(path, "providerBindings")), createdAt: decodeIsoTimestamp(object.createdAt, at(path, "createdAt")) });
}

export interface BootstrapGraphForValidation {
  readonly workspace: ConfigurationIdentity; readonly workspaceRevision: WorkspaceRevision;
  readonly agentProfile: ConfigurationIdentity; readonly agentProfileRevision: AgentProfileRevision;
  readonly executionPolicy: ConfigurationIdentity; readonly executionPolicySnapshot: ExecutionPolicySnapshot;
  readonly turnPolicy: ConfigurationIdentity; readonly turnPolicySnapshot: TurnPolicySnapshot;
  readonly agentResourceSnapshots: readonly AgentResourceSnapshot[]; readonly extensions: readonly ConfigurationIdentity[];
  readonly extensionRevisions: readonly ExtensionRevision[]; readonly extensionGrantSnapshots: readonly ExtensionGrantSnapshot[];
  readonly providerConnection: ProviderConnectionSpec; readonly providerCredentialBinding: ProviderCredentialBinding;
  readonly installationId: string; readonly hardCeilings: InstallationHardCeilings; readonly sessionSpec?: SessionSpec;
}

export function validateBootstrapGraph(graph: BootstrapGraphForValidation): void {
  const same = (actual: string, expected: string, label: string) => { if (actual !== expected) codecFail([], "invalid-format", `${label} drift`); };
  for (const identity of [graph.workspace, graph.agentProfile, graph.executionPolicy, graph.turnPolicy, ...graph.extensions]) {
    same(identity.installationId, graph.installationId, "stable identity installation");
  }
  same(graph.workspaceRevision.workspaceId, graph.workspace.id, "workspace revision"); same(graph.agentProfileRevision.profileId, graph.agentProfile.id, "profile revision"); same(graph.executionPolicySnapshot.policyId, graph.executionPolicy.id, "execution policy snapshot"); same(graph.turnPolicySnapshot.policyId, graph.turnPolicy.id, "turn policy snapshot"); same(graph.providerConnection.installationId, graph.installationId, "provider connection installation"); same(graph.providerCredentialBinding.installationId, graph.installationId, "credential installation"); same(graph.providerCredentialBinding.providerId, graph.providerConnection.providerId, "credential provider");
  if (graph.providerConnection.transport.credentialCustody !== graph.providerCredentialBinding.custody) codecFail([], "invalid-format", "credential custody drift");
  if (
    graph.providerConnection.models.some(
      (model) => model.providerId !== graph.providerConnection.providerId,
    )
  ) {
    codecFail([], "invalid-format", "connection model provider drift");
  }
  if (graph.agentProfileRevision.providers.length !== 1) {
    codecFail([], "invalid-format", "first-slice profile must expose one exact provider allowance");
  }
  const allowance = graph.agentProfileRevision.providers[0];
  if (
    allowance === undefined ||
    allowance.providerId !== graph.providerConnection.providerId ||
    allowance.providerConnectionId !== graph.providerConnection.id ||
    allowance.models.kind !== "allowlist" ||
    allowance.models.modelIds.some(
      (modelId) =>
        !graph.providerConnection.models.some(
          (model) =>
            model.providerId === allowance.providerId &&
            model.modelId === modelId,
        ),
    )
  ) {
    codecFail([], "invalid-format", "provider allowance drift");
  }
  if (
    graph.agentProfileRevision.defaultModel === undefined ||
    graph.agentProfileRevision.defaultModel.providerId !== allowance.providerId ||
    !allowance.models.modelIds.includes(
      graph.agentProfileRevision.defaultModel.modelId,
    )
  ) {
    codecFail([], "invalid-format", "default model is outside the exact connection allowance");
  }
  if (!graph.providerConnection.models.some((model) => model.providerId === graph.agentProfileRevision.defaultModel!.providerId && model.modelId === graph.agentProfileRevision.defaultModel!.modelId)) codecFail([], "invalid-format", "default model is not in provider connection");
  const workspaceResources = [
    graph.workspaceRevision.root,
    ...graph.workspaceRevision.mounts,
  ];
  const workspaceResourceById = new Map(
    workspaceResources.map((resource) => [resource.id, resource]),
  );
  const accessRank = {
    "none": 0,
    "read-only": 1,
    "read-write": 2,
  } as const;
  for (const grant of graph.executionPolicySnapshot.resourceGrants) {
    const resource = workspaceResourceById.get(grant.resourceId);
    if (
      resource === undefined ||
      accessRank[grant.access] > accessRank[resource.maximumAccess] ||
      accessRank[grant.access] >
        accessRank[graph.executionPolicySnapshot.workspaceFilesystem]
    ) {
      codecFail(
        [],
        "invalid-format",
        "execution policy workspace resource grant drift",
      );
    }
  }
  if (
    graph.executionPolicySnapshot.workspaceFilesystem === "none" &&
    graph.executionPolicySnapshot.resourceGrants.length !== 0
  ) {
    codecFail(
      [],
      "invalid-format",
      "workspace-disabled policy cannot grant a workspace resource",
    );
  }
  const ceiling = graph.hardCeilings; const turn = graph.turnPolicySnapshot; const execution = graph.executionPolicySnapshot;
  if (ceiling.maximumQueuedTurnsPerSession > turn.admission.maxQueuedTurns || ceiling.maximumActiveWorkMs > turn.timing.maximumActiveWorkMs || ceiling.maximumInteractionWaitMs > turn.timing.interactionWaitMs || ceiling.maximumBeforeAcceptanceAttempts > turn.retry.maximumBeforeAcceptanceAttempts || ceiling.maximumProviderRequestsPerTurn > turn.inference.maximumProviderRequests || ceiling.maximumTotalInferenceTokensPerTurn > turn.inference.maximumTotalTokens || ceiling.maximumOutputTokensPerInferenceRequest > turn.inference.maximumOutputTokensPerRequest || ceiling.maximumMemoryBytes > execution.limits.memoryBytes! || ceiling.maximumProcesses > execution.limits.maxProcesses! || ceiling.maximumTemporaryStorageBytes > execution.limits.temporaryStorageBytes! || ceiling.maximumAgentOutputBytes > execution.limits.outputBytes!) codecFail([], "out-of-range", "installation hard ceilings widen pinned snapshots");
  const selected = graph.providerConnection.models.find((model) => model.providerId === graph.agentProfileRevision.defaultModel!.providerId && model.modelId === graph.agentProfileRevision.defaultModel!.modelId);
  if (!selected || turn.inference.maximumOutputTokensPerRequest > selected.maximumOutputTokens || turn.inference.maximumTotalTokens > selected.contextWindowTokens) codecFail([], "out-of-range", "turn inference limits exceed selected model");
  if (graph.agentProfileRevision.defaultReasoning.kind === "agent-default" && (!selected.reasoning || selected.reasoning.kind !== "portable-efforts" || !selected.reasoning.agentDefaultSupported)) codecFail([], "unsupported-discriminant", "selected model does not support agent-default reasoning");
  if (selected.imageInput.kind !== "supported" || ceiling.maximumImageBytesPerAttachment > selected.imageInput.maximumImageBytesEach) codecFail([], "out-of-range", "installation image ceiling widens selected model limit");
  const revisions = new Map(graph.extensionRevisions.map((revision) => [revision.id, revision])); const resourceIds = new Set(graph.agentResourceSnapshots.map((resource) => resource.id)); if (resourceIds.size !== graph.agentResourceSnapshots.length) codecFail([], "duplicate-item", "duplicate resource snapshot");
  if (!sameSet(graph.agentProfileRevision.agentResourceSnapshotIds, graph.agentResourceSnapshots.map((resource) => resource.id)) || !sameSet(graph.agentProfileRevision.extensionGrantSnapshotIds, graph.extensionGrantSnapshots.map((grant) => grant.id))) codecFail([], "invalid-format", "profile resource or extension grant drift");
  const extensionIds = new Set(graph.extensions.map((extension) => extension.id)); const extensionRefs = new Set(graph.extensions.map((extension) => extension.reference)); const extensionRevisionIds = new Set(graph.extensionRevisions.map((revision) => revision.id)); const extensionRevisionKeys = new Set(graph.extensionRevisions.map((revision) => `${revision.extensionId}:${revision.revision}`)); if (extensionIds.size !== graph.extensions.length || extensionRefs.size !== graph.extensions.length || extensionRevisionIds.size !== graph.extensionRevisions.length || extensionRevisionKeys.size !== graph.extensionRevisions.length) codecFail([], "duplicate-item", "duplicate extension identity or revision");
  if (graph.extensionRevisions.length !== graph.extensions.length || graph.extensionRevisions.some((revision) => !extensionIds.has(revision.extensionId))) codecFail([], "invalid-format", "extension identity/revision cardinality drift");
  const grantIds = new Set<string>();
  const grantedRevisionIds = new Set<string>();
  const grantedExtensionIds = new Set<string>();
  for (const grant of graph.extensionGrantSnapshots) {
    if (
      grantIds.has(grant.id) ||
      grantedRevisionIds.has(grant.extensionRevisionId) ||
      grantedExtensionIds.has(grant.extensionId)
    ) {
      codecFail([], "duplicate-item", "duplicate extension grant");
    }
    grantIds.add(grant.id);
    grantedRevisionIds.add(grant.extensionRevisionId);
    grantedExtensionIds.add(grant.extensionId);
    const revision = revisions.get(grant.extensionRevisionId);
    if (!revision || revision.extensionId !== grant.extensionId) {
      codecFail([], "invalid-format", "extension grant revision drift");
    }
  }
  if (
    graph.extensionGrantSnapshots.length !== graph.extensionRevisions.length ||
    graph.extensionRevisions.some(
      (revision) => !grantedRevisionIds.has(revision.id),
    )
  ) {
    codecFail(
      [],
      "invalid-format",
      "extension revision/grant cardinality drift",
    );
  }
  if (graph.sessionSpec !== undefined) { const spec = graph.sessionSpec; same(spec.agentProfileRevisionId, graph.agentProfileRevision.id, "SessionSpec profile"); same(spec.workspaceRevisionId, graph.workspaceRevision.id, "SessionSpec workspace"); same(spec.executionPolicySnapshotId, graph.executionPolicySnapshot.id, "SessionSpec execution policy"); same(spec.turnPolicySnapshotId, graph.turnPolicySnapshot.id, "SessionSpec turn policy"); const binding = spec.providerBindings[0]; if (spec.providerBindings.length !== 1 || !binding || binding.providerId !== graph.providerConnection.providerId || binding.providerConnectionId !== graph.providerConnection.id || binding.credentialBindingId !== graph.providerCredentialBinding.id) codecFail([], "invalid-format", "SessionSpec provider binding drift"); if (!sameSet(spec.agentResourceSnapshotIds, graph.agentProfileRevision.agentResourceSnapshotIds) || !sameSet(spec.extensionGrantSnapshotIds, graph.agentProfileRevision.extensionGrantSnapshotIds)) codecFail([], "invalid-format", "SessionSpec resource or extension grant drift"); }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)); }

export function freeze<T>(value: T): T { if (value !== null && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value); } return value; }

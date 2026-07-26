import assert from "node:assert/strict";
import { test } from "node:test";

import { CodecDecodeError } from "../codecs/errors.js";
import { scenarioCase } from "../acceptance/runner.js";
import { FIRST_SLICE_CONFIGURATION_V1 } from "./fixture-v1.js";
import { decodeBootstrapPublicationProjectionInput, projectBootstrapPublication } from "./publication-projection.js";
import {
  decodeAgentProfileRevision,
  decodeCanonicalHostPath,
  decodeExtensionGrantSnapshot,
  decodeExtensionRevision,
  decodeProviderConnectionSpec,
  decodeProviderModelManifest,
  decodeSessionSpec,
  validateBootstrapGraph,
} from "./records.js";

function input(): Record<string, unknown> {
  return {
    configuration: structuredClone(FIRST_SLICE_CONFIGURATION_V1),
    resolved: {
      timestamp: "2026-07-26T12:00:00.000Z",
      auditActor: { kind: "bootstrap" },
      serviceSchemaDigest: `sha256:${"1".repeat(64)}`,
      sourceReferences: {
        installationRef: "hitch-v2-first-slice", principalRef: "bootstrap-owner-v1",
        localHostRef: "local-host-v1", identityBindingRef: "bootstrap-owner-local-peer-v1",
        subjectRef: "service-owner-local-peer-v1", subjectResolution: "service-owner-effective-uid",
        endpointRef: "local-endpoint-v1", workspaceBindingRef: "workspace-binding-v1",
      },
      ids: {
        installationId: "installation-v1", ownerId: "owner-v1", identityBindingId: "owner-binding-v1", endpointId: "endpoint-v1", installationRoleGrantId: "role-grant-v1",
        localHostId: "local-host-v1", authenticationSubjectId: "local-owner-subject-v1", localEndpointId: "local-endpoint-v1",
        workspaceId: "workspace-v1", workspaceRevisionId: "workspace-revision-v1", profileId: "pi-profile-v1", profileRevisionId: "pi-profile-revision-v1",
        executionPolicyId: "execution-policy-v1", executionPolicySnapshotId: "execution-policy-snapshot-v1", turnPolicyId: "turn-policy-v1", turnPolicySnapshotId: "turn-policy-snapshot-v1",
        providerConnectionId: "pi-native-openai-codex-v1", credentialBindingId: "openai-codex-pi-auth-v1",
        configurationUseGrantIds: { workspace: "grant-workspace-v1", profile: "grant-profile-v1", executionPolicy: "grant-execution-v1", turnPolicy: "grant-turn-v1", credentialBinding: "grant-credential-v1" },
        extensionUseGrantIds: [],
      },
      trustedWorkspaceBinding: { bindingRef: "workspace-binding-v1", workspaceReference: "workspace-v1", revision: 1, root: { id: "workspace-root-v1", canonicalHostPath: "/srv/hitch-workspace", sandboxPath: "/workspace", maximumAccess: "read-write" }, mounts: [] },
    },
  };
}

function inputWithExtension(): Record<string, unknown> {
  const value = input();
  const configuration = value.configuration as Record<string, unknown>;
  const resources = configuration.resources as Record<string, unknown>;
  const extensions = resources.extensions as Record<string, unknown>;
  (extensions.grants as unknown[]).push({
    extensionId: "reviewed-extension-v1",
    extensionRef: "reviewed-extension-v1",
    extensionRevisionId: "reviewed-extension-revision-v1",
    revision: 1,
    displayName: "Reviewed extension",
    configurationSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    revisionArtifactRef: "reviewed-extension-artifact-v1",
    revisionIntegrityDigest: `sha256:${"e".repeat(64)}`,
    grantSnapshotId: "reviewed-extension-grant-v1",
    grantIntegrityDigest: `sha256:${"f".repeat(64)}`,
    ownerUseGrant: "required",
    capabilityIds: [],
    promptLifecycle: "agent-loop-preserving",
    configuration: {},
  });
  const resolved = value.resolved as Record<string, unknown>;
  const ids = resolved.ids as Record<string, unknown>;
  (ids.extensionUseGrantIds as unknown[]).push({
    extensionId: "reviewed-extension-v1",
    grantId: "reviewed-extension-use-v1",
  });
  return value;
}

function graphFor(
  records: ReturnType<typeof projectBootstrapPublication>["records"],
) {
  return {
    workspace: records.workspace,
    workspaceRevision: records.workspaceRevision,
    agentProfile: records.agentProfile,
    agentProfileRevision: records.agentProfileRevision,
    executionPolicy: records.executionPolicy,
    executionPolicySnapshot: records.executionPolicySnapshot,
    turnPolicy: records.turnPolicy,
    turnPolicySnapshot: records.turnPolicySnapshot,
    agentResourceSnapshots: records.agentResourceSnapshots,
    extensions: records.extensions,
    extensionRevisions: records.extensionRevisions,
    extensionGrantSnapshots: records.extensionGrantSnapshots,
    providerConnection: records.providerConnection,
    providerCredentialBinding: records.providerCredentialBinding,
    installationId: records.installation.id,
    hardCeilings: records.installation.hardCeilings,
  };
}

test("projection publishes the complete fixture graph with explicit artifact materialization plan", () => {
  const projected = projectBootstrapPublication(input());
  assert.equal(projected.records.accessGrants.length, 6);
  assert.equal(projected.records.localIdentityBinding.source.kind, "local-peer");
  assert.equal(projected.records.localIdentityBinding.source.localHostId, "local-host-v1");
  assert.equal(projected.records.providerConnection.models[0]?.modelId, "gpt-5.4-mini");
  assert.equal(projected.records.artifactBindings.provider.bridgeId, "pi-native-sidecar-v1");
  assert.equal(
    projected.records.artifactBindings.provider.providerConnectionId,
    projected.records.providerConnection.id,
  );
  assert.equal(projected.records.referenceBindings.subject.resolution, "service-owner-effective-uid");
  assert.equal(
    projected.records.referenceBindings.installation.displayName,
    "Hitch v2 first slice",
  );
  assert(Object.isFrozen(projected));
  assert(Object.isFrozen(projected.records.providerConnection));
});

test("projection rejects ID drift, host paths in configuration, and a widened hard ceiling", () => {
  const drift = input();
  (((drift.resolved as Record<string, unknown>).ids as Record<string, unknown>).profileId) = "other-profile-v1";
  assert.throws(() => projectBootstrapPublication(decodeBootstrapPublicationProjectionInput(drift)), CodecDecodeError);
  const hostPath = input();
  ((((hostPath.configuration as Record<string, unknown>).profile as Record<string, unknown>).configuration) as Record<string, unknown>).workspacePath = "/host/path";
  assert.throws(() => decodeBootstrapPublicationProjectionInput(hostPath), CodecDecodeError);
  const widened = input();
  ((widened.configuration as Record<string, unknown>).installationHardCeilings as Record<string, unknown>).maximumProviderRequestsPerTurn = 5;
  assert.throws(() => decodeBootstrapPublicationProjectionInput(widened), CodecDecodeError);
});

test("projection rejects forged resolution refs, duplicate access grant IDs, and oversized extension resolution", () => {
  const refDrift = input();
  (((refDrift.resolved as Record<string, unknown>).sourceReferences as Record<string, unknown>).endpointRef) = "other-endpoint-v1";
  assert.throws(() => projectBootstrapPublication(refDrift), CodecDecodeError);

  const duplicateGrant = input();
  const ids = (duplicateGrant.resolved as Record<string, unknown>).ids as Record<string, unknown>;
  (ids.configurationUseGrantIds as Record<string, unknown>).workspace = ids.installationRoleGrantId;
  assert.throws(() => projectBootstrapPublication(duplicateGrant), CodecDecodeError);

  const oversized = input();
  ((oversized.resolved as Record<string, unknown>).ids as Record<string, unknown>).extensionUseGrantIds = Array.from(
    { length: 33 },
    (_, index) => ({ extensionId: `extension-${index}`, grantId: `grant-${index}` }),
  );
  assert.throws(() => projectBootstrapPublication(oversized), CodecDecodeError);
});

test("trusted resolution rejects noncanonical empty mounts and accepts opaque local identities", () => {
  const malformed = input();
  const mounts: unknown[] = [];
  Object.defineProperty(mounts, "extra", {
    value: true,
    enumerable: true,
  });
  ((malformed.resolved as Record<string, unknown>).trustedWorkspaceBinding as Record<string, unknown>).mounts = mounts;
  assert.throws(() => projectBootstrapPublication(malformed), CodecDecodeError);

  const opaque = input();
  const ids = (opaque.resolved as Record<string, unknown>).ids as Record<string, unknown>;
  ids.authenticationSubjectId = "uid:1000";
  ids.localEndpointId = "endpoint:local";
  const projected = projectBootstrapPublication(opaque);
  assert.equal(projected.records.localIdentityBinding.subjectId, "uid:1000");
  assert.equal(projected.records.localEndpoint.address.kind, "local-client");
  assert.equal(
    projected.records.localEndpoint.address.localEndpointId,
    "endpoint:local",
  );
});

test("canonical trusted host paths are lexical, strict, and do not reject ordinary dot-containing names", () => {
  assert.equal(decodeCanonicalHostPath("/srv/foo..bar/workspace"), "/srv/foo..bar/workspace");
  for (const value of ["/", "/srv//workspace", "/srv/./workspace", "/srv/../workspace", "/srv/workspace/", "C:\\workspace", "/srv/\u0000workspace"]) {
    assert.throws(() => decodeCanonicalHostPath(value), CodecDecodeError);
  }
});

test("cross-record validation rejects widened ceilings and profile publication-set drift", () => {
  const projected = projectBootstrapPublication(input());
  const records = structuredClone(projected.records);
  const graph = graphFor(records);
  assert.throws(() => validateBootstrapGraph({ ...graph, hardCeilings: { ...records.installation.hardCeilings, maximumProviderRequestsPerTurn: 5 } }), CodecDecodeError);
  assert.throws(() => validateBootstrapGraph({ ...graph, agentProfileRevision: { ...records.agentProfileRevision, agentResourceSnapshotIds: ["unexpected-resource-v1" as never] } }), CodecDecodeError);
  assert.doesNotThrow(() =>
    validateBootstrapGraph({
      ...graph,
      hardCeilings: {
        ...records.installation.hardCeilings,
        maximumProviderRequestsPerTurn: 3,
      },
    }),
  );
});

test("SessionSpec codec and graph branch enforce exact bindings and pinned sets", () => {
  const projected = projectBootstrapPublication(input());
  const records = structuredClone(projected.records);
  const specInput = {
    id: "session-spec-v1",
    schemaVersion: 1,
    agentProfileRevisionId: records.agentProfileRevision.id,
    workspaceRevisionId: records.workspaceRevision.id,
    executionPolicySnapshotId: records.executionPolicySnapshot.id,
    turnPolicySnapshotId: records.turnPolicySnapshot.id,
    agentResourceSnapshotIds:
      records.agentProfileRevision.agentResourceSnapshotIds,
    extensionGrantSnapshotIds:
      records.agentProfileRevision.extensionGrantSnapshotIds,
    providerBindings: [
      {
        providerId: records.providerConnection.providerId,
        providerConnectionId: records.providerConnection.id,
        credentialBindingId: records.providerCredentialBinding.id,
      },
    ],
    createdAt: records.installation.createdAt,
  };
  const sessionSpec = decodeSessionSpec(specInput);
  assert.doesNotThrow(() =>
    validateBootstrapGraph({
      ...graphFor(records),
      sessionSpec,
    }),
  );
  assert.throws(
    () =>
      decodeSessionSpec({
        ...specInput,
        providerBindings: [
          ...specInput.providerBindings,
          ...specInput.providerBindings,
        ],
      }),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      decodeSessionSpec({
        ...specInput,
        unexpected: true,
      }),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      validateBootstrapGraph({
        ...graphFor(records),
        sessionSpec: {
          ...sessionSpec,
          workspaceRevisionId: "other-workspace-revision-v1" as never,
        },
      }),
    CodecDecodeError,
  );
});

test("cross-record validation rejects extra providers, phantom workspace grants, and non-bijective extension grants", () => {
  const projected = projectBootstrapPublication(input());
  const records = structuredClone(projected.records);
  const graph = graphFor(records);
  assert.throws(
    () =>
      validateBootstrapGraph({
        ...graph,
        agentProfileRevision: {
          ...records.agentProfileRevision,
          providers: [
            ...records.agentProfileRevision.providers,
            {
              providerId: "unregistered-provider-v1" as never,
              providerConnectionId: "unregistered-connection-v1" as never,
              models: {
                kind: "allowlist",
                modelIds: ["unregistered-model-v1" as never],
              },
            },
          ],
        },
      }),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      validateBootstrapGraph({
        ...graph,
        executionPolicySnapshot: {
          ...records.executionPolicySnapshot,
          resourceGrants: [
            {
              resourceId: "phantom-workspace-resource-v1" as never,
              access: "read-write",
            },
          ],
        },
      }),
    CodecDecodeError,
  );

  const extended = projectBootstrapPublication(inputWithExtension());
  const extensionRecords = structuredClone(extended.records);
  const originalGrant = extensionRecords.extensionGrantSnapshots[0]!;
  const duplicateGrant = {
    ...originalGrant,
    id: "duplicate-extension-grant-v1" as never,
  };
  assert.throws(
    () =>
      validateBootstrapGraph({
        ...graphFor(extensionRecords),
        agentProfileRevision: {
          ...extensionRecords.agentProfileRevision,
          extensionGrantSnapshotIds: [
            ...extensionRecords.agentProfileRevision.extensionGrantSnapshotIds,
            duplicateGrant.id,
          ],
        },
        extensionGrantSnapshots: [
          ...extensionRecords.extensionGrantSnapshots,
          duplicateGrant,
        ],
      }),
    CodecDecodeError,
  );
  const callerSchema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  decodeExtensionRevision({
    ...extended.records.extensionRevisions[0],
    configurationSchema: callerSchema,
  });
  assert.equal(Object.isFrozen(callerSchema), false);
  assert.equal(Object.isFrozen(callerSchema.properties), false);
});

test("secret-free records reject operational fields and path-bearing display names", () => {
  const projected = projectBootstrapPublication(input());
  const records = structuredClone(projected.records);
  for (const configuration of [
    { command: "curl example.invalid" },
    { preload: "extension.mjs" },
    { moduleLoader: "native-module" },
    { runtimeEnv: { SAFE: "value" } },
    { extraArguments: ["--unsafe"] },
    { customEndpoint: "https://attacker.invalid" },
  ]) {
    assert.throws(
      () =>
        decodeAgentProfileRevision({
          ...records.agentProfileRevision,
          configuration,
        }),
      CodecDecodeError,
    );
  }
  assert.throws(
    () =>
      decodeProviderModelManifest({
        ...records.providerConnection.models[0],
        nativeModelMetadata: {
          origin: "https://attacker.invalid",
        },
      }),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      decodeProviderConnectionSpec({
        ...records.providerConnection,
        transport: {
          ...records.providerConnection.transport,
          nativeStackVersion: "/tmp/pi-stack",
        },
      }),
    CodecDecodeError,
  );

  const extended = projectBootstrapPublication(inputWithExtension());
  assert.equal(extended.records.accessGrants.length, 7);
  assert.deepEqual(
    extended.records.extensionGrantSnapshots[0]?.capabilities,
    [],
  );
  assert.throws(
    () =>
      decodeExtensionRevision({
        ...extended.records.extensionRevisions[0],
        configurationSchema: {
          type: "object",
          properties: { headers: { type: "object" } },
          required: [],
          additionalProperties: false,
        },
      }),
    CodecDecodeError,
  );
  assert.throws(
    () =>
      decodeExtensionGrantSnapshot({
        ...extended.records.extensionGrantSnapshots[0],
        configuration: { ambientLoaders: true },
      }),
    CodecDecodeError,
  );

  const displayPath = input();
  const configuration = displayPath.configuration as Record<string, unknown>;
  const resources = configuration.resources as Record<string, unknown>;
  const skills = resources.skills as Record<string, unknown>;
  (skills.snapshots as unknown[]).push({
    kind: "skill",
    snapshotId: "path-skill-v1",
    displayName: "/home/alice/private/key.pem",
    artifactRef: "path-skill-artifact-v1",
    integrityDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.throws(() => projectBootstrapPublication(displayPath), CodecDecodeError);
});

test("record codec accepts independent native DeepSeek and OpenAI model manifests", () => {
  const manifest = (providerId: string, modelId: string) => decodeProviderModelManifest({
    providerId, modelId, apiProtocolId: "native-responses-v1", contextWindowTokens: 32_000, maximumOutputTokens: 8_000,
    tokenEstimatorId: "native-estimator-v1", imageInput: { kind: "supported", acceptedMimeTypes: ["image/png"], maximumImagesPerRequest: 1, maximumImageBytesEach: 1_000_000, maximumTotalImageBytesPerRequest: 1_000_000 },
    tools: "supported", reasoning: { kind: "portable-efforts", supportedEfforts: ["none", "low"], agentDefaultSupported: true }, nativeModelMetadata: { transport: "native-responses-v1", streaming: "sse" }, integrityDigest: `sha256:${(modelId.includes("deepseek") ? "d" : "a").repeat(64)}`,
  });
  assert.equal(manifest("deepseek", "deepseek-coder-v1").providerId, "deepseek");
  assert.equal(manifest("openai-codex", "gpt-codex-v1").providerId, "openai-codex");
});

scenarioCase({ scenarioId: "V2-S01", caseId: "bootstrap-publication-projection", title: "fixture resolves to one immutable publication graph", run: () => { projectBootstrapPublication(decodeBootstrapPublicationProjectionInput(input())); } });

import assert from "node:assert/strict";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import { CodecDecodeError } from "../codecs/errors.js";
import { decodeFirstSliceInstallationConfiguration } from "./configuration.js";
import { FIRST_SLICE_CONFIGURATION_V1 } from "./fixture-v1.js";

type Mutable = Record<string, unknown>;

function fixtureCopy(): Mutable {
  return structuredClone(FIRST_SLICE_CONFIGURATION_V1) as Mutable;
}

function mutate(mutation: (configuration: Mutable) => void): unknown {
  const configuration = fixtureCopy();
  mutation(configuration);
  return configuration;
}

function record(value: unknown): Mutable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected record");
  return value as Mutable;
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test("first-slice publication decodes its complete Pi/OpenAI-Codex fixture immutably", () => {
  const decoded = decodeFirstSliceInstallationConfiguration(FIRST_SLICE_CONFIGURATION_V1);
  const provider = record(record(decoded).provider);
  const connection = record(provider.connection);
  const model = record(connection.model);
  const transport = record(connection.transport);
  const turnPolicy = record(record(decoded).turnPolicy);
  const resourcePolicy = record(record(record(decoded).profile).resourcePolicy);

  assert.equal(record(decoded).configurationVersion, 1);
  assert.equal(record(record(decoded).workspaceBinding).publicationRequirement, "supervisor-resolved-canonical-host-path");
  assert.equal(record(record(decoded).workspaceBinding).sandboxPath, "/workspace");
  assert.equal(model.id, "gpt-5.4-mini");
  assert.equal(model.contextWindowTokens, 272_000);
  assert.equal(model.maximumOutputTokens, 128_000);
  assert.equal(transport.invocation, "structured-native-request");
  assert.equal(transport.nativeRetries, "disabled");
  assert.equal(
    transport.nativeCatalogDigest,
    "sha256:d570b6189992194c559046925f5b9633d8ce5ea51de53ffd28a289de229c219b",
  );
  assert.equal(record(turnPolicy.inference).maximumOutputTokensPerRequest, 16_384);
  assert.equal(record(resourcePolicy.extensions).mode, "granted-only");
  assert(Object.isFrozen(decoded));
  assert(Object.isFrozen(connection));
  assert(Object.isFrozen(transport));
  assertDeepFrozen(decoded);
});

test("bootstrap rejects incomplete, deferred, or widened publishable facts", () => {
  const cases: readonly [string, (configuration: Mutable) => void][] = [
    ["missing workspace binding", (configuration) => { delete configuration.workspaceBinding; }],
    ["deferred driver", (configuration) => { record(configuration.agentDriver).protocol = "acp"; }],
    ["deferred model selection", (configuration) => { record(configuration.agentDriver).modelSelection = "agent-selected"; }],
    ["missing credential binding", (configuration) => { delete configuration.credentialBinding; }],
    ["provider endpoint", (configuration) => { record(record(configuration.provider).connection).providerEndpoint = "https://api.openai.com"; }],
    ["preload", (configuration) => { record(configuration.worker).preload = "extension.mjs"; }],
    ["credential reference", (configuration) => { record(record(configuration.provider).connection).credentialRef = "sk-not-allowed"; }],
    ["worker network", (configuration) => { record(configuration.worker).network = "host-network"; }],
    ["ambient loader", (configuration) => { record(configuration.worker).ambientLoaders = "enabled"; }],
    ["widened filesystem", (configuration) => { record(configuration.executionPolicy).workspaceFilesystem = "none"; }],
    ["widened hard ceiling", (configuration) => { record(configuration.installationHardCeilings).maximumProviderRequestsPerTurn = 5; }],
    ["wrong catalog digest", (configuration) => { record(record(record(configuration.provider).connection).transport).nativeCatalogDigest = `sha256:${"0".repeat(64)}`; }],
    ["wrong bridge digest", (configuration) => { record(record(record(configuration.provider).connection).transport).bridgeArtifactDigest = `sha256:${"0".repeat(64)}`; }],
    ["wrong model", (configuration) => { record(record(configuration.provider).connection).model = { id: "gpt-5.4" }; }],
    ["wrong capability", (configuration) => { record(configuration.executionPolicy).tools = ["tool-shell-v1"]; }],
  ];
  for (const [name, mutation] of cases) {
    assert.throws(() => decodeFirstSliceInstallationConfiguration(mutate(mutation)), CodecDecodeError, name);
  }
});

test("bootstrap permits independently pinned resource and extension grants", () => {
  const decoded = decodeFirstSliceInstallationConfiguration(mutate((configuration) => {
    const resources = record(configuration.resources);
    record(resources.skills).snapshots = [{
      kind: "skill",
      snapshotId: "profile-skill-v1",
      displayName: "Profile skill",
      artifactRef: "profile-skill-bundle-v1",
      integrityDigest: `sha256:${"a".repeat(64)}`,
    }];
    record(resources.extensions).grants = [{
      extensionId: "profile-extension-v1",
      extensionRef: "profile-extension-v1",
      extensionRevisionId: "profile-extension-revision-v1",
      revision: 1,
      displayName: "Profile extension",
      configurationSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      revisionArtifactRef: "profile-extension-bundle-v1",
      revisionIntegrityDigest: `sha256:${"b".repeat(64)}`,
      grantSnapshotId: "profile-extension-grant-v1",
      grantIntegrityDigest: `sha256:${"c".repeat(64)}`,
      ownerUseGrant: "required",
      capabilityIds: ["extension-capability-v1"],
      promptLifecycle: "agent-loop-preserving",
      configuration: {},
    }];
  }));
  const resources = record(decoded).resources;
  assert.equal((record(record(resources).skills).snapshots as unknown[]).length, 1);
  assert.equal((record(record(resources).extensions).grants as unknown[]).length, 1);
});

test("resource grants reject duplicate identities, invalid artifacts, and nonempty deferred configuration", () => {
  assert.throws(() => decodeFirstSliceInstallationConfiguration(mutate((configuration) => {
    const resources = record(configuration.resources);
    record(resources.skills).snapshots = [
      { kind: "skill", snapshotId: "one-v1", displayName: "One", artifactRef: "one-v1", integrityDigest: `sha256:${"a".repeat(64)}` },
      { kind: "skill", snapshotId: "one-v1", displayName: "Two", artifactRef: "two-v1", integrityDigest: `sha256:${"b".repeat(64)}` },
    ];
  })), CodecDecodeError);
  assert.throws(() => decodeFirstSliceInstallationConfiguration(mutate((configuration) => {
    const resources = record(configuration.resources);
    record(resources.extensions).grants = [{
      extensionId: "profile-extension-v1", extensionRef: "profile-extension-v1",
      extensionRevisionId: "profile-extension-revision-v1", revision: 1, displayName: "Profile extension",
      configurationSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      revisionArtifactRef: "profile-extension-bundle-v1", revisionIntegrityDigest: `sha256:${"b".repeat(64)}`,
      grantSnapshotId: "grant-v1", grantIntegrityDigest: `sha256:${"c".repeat(64)}`, capabilityIds: ["capability-v1", "capability-v1"],
      ownerUseGrant: "required", promptLifecycle: "agent-loop-preserving", configuration: { deferred: true },
    }];
  })), CodecDecodeError);
  assert.throws(() => decodeFirstSliceInstallationConfiguration(mutate((configuration) => {
    const resources = record(configuration.resources);
    record(resources.extensions).grants = [
      {
        extensionId: "profile-extension-v1",
        extensionRef: "profile-extension-v1",
        extensionRevisionId: "profile-extension-revision-one-v1",
        revision: 1,
        displayName: "One",
        configurationSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        revisionArtifactRef: "one-v1",
        revisionIntegrityDigest: `sha256:${"a".repeat(64)}`,
        grantSnapshotId: "one-v1",
        grantIntegrityDigest: `sha256:${"b".repeat(64)}`,
        ownerUseGrant: "required",
        capabilityIds: ["capability-one-v1"],
        promptLifecycle: "agent-loop-preserving",
        configuration: {},
      },
      {
        extensionId: "profile-extension-v1",
        extensionRef: "profile-extension-v1",
        extensionRevisionId: "profile-extension-revision-two-v1",
        revision: 1,
        displayName: "Two",
        configurationSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        revisionArtifactRef: "two-v1",
        revisionIntegrityDigest: `sha256:${"c".repeat(64)}`,
        grantSnapshotId: "two-v1",
        grantIntegrityDigest: `sha256:${"d".repeat(64)}`,
        ownerUseGrant: "required",
        capabilityIds: ["capability-two-v1"],
        promptLifecycle: "agent-loop-preserving",
        configuration: {},
      },
    ];
  })), CodecDecodeError);
});

test("decoder bounds aggregate input and freezes nested decoded data", () => {
  assert.throws(
    () =>
      decodeFirstSliceInstallationConfiguration(
        mutate((configuration) => {
          const resources = record(configuration.resources);
          for (const groupName of [
            "skills",
            "promptTemplates",
            "themes",
          ]) {
            record(resources[groupName]).snapshots = Array.from(
              { length: 32 },
              (_, index) => ({
                kind:
                  groupName === "skills"
                    ? "skill"
                    : groupName === "promptTemplates"
                      ? "prompt-template"
                      : "theme",
                snapshotId: `${groupName}-${index}`,
                displayName: `${groupName} ${index}`,
                artifactRef: `${groupName.toLowerCase()}-${index}`,
                integrityDigest: `sha256:${index
                  .toString(16)
                  .padStart(64, "0")}`,
              }),
            );
          }
        }),
      ),
    CodecDecodeError,
  );
  const decoded = decodeFirstSliceInstallationConfiguration(fixtureCopy());
  assert.throws(() => { (record(decoded).worker as Mutable).network = "host-network"; }, TypeError);
  assert.throws(() => { (record(record(decoded).provider).connection as Mutable).id = "changed"; }, TypeError);
});

test("extension configuration uses one exact closed empty-object schema", () => {
  assert.throws(() =>
    decodeFirstSliceInstallationConfiguration(
      mutate((configuration) => {
        const resources = record(configuration.resources);
        record(resources.extensions).grants = [{
          extensionId: "profile-extension-v1",
          extensionRef: "profile-extension-v1",
          extensionRevisionId: "profile-extension-revision-v1",
          revision: 1,
          displayName: "Profile extension",
          configurationSchema: {},
          revisionArtifactRef: "profile-extension-bundle-v1",
          revisionIntegrityDigest: `sha256:${"b".repeat(64)}`,
          grantSnapshotId: "profile-extension-grant-v1",
          grantIntegrityDigest: `sha256:${"c".repeat(64)}`,
          ownerUseGrant: "required",
          capabilityIds: [],
          promptLifecycle: "agent-loop-preserving",
          configuration: {},
        }];
      }),
    ),
  CodecDecodeError);
});

scenarioCase({
  scenarioId: "V2-S01",
  caseId: "exact-bootstrap-configuration",
  title: "bootstrap accepts only the fixed Pi/OpenAI-Codex first-slice configuration",
  run: () => { decodeFirstSliceInstallationConfiguration(FIRST_SLICE_CONFIGURATION_V1); },
});

scenarioCase({
  scenarioId: "V2-S07",
  caseId: "pinned-resource-and-worker-network-policy",
  title: "pinned resources may load while worker network, shell, and process remain denied",
  run: () => {
    const decoded = record(decodeFirstSliceInstallationConfiguration(FIRST_SLICE_CONFIGURATION_V1));
    assert.equal(record(decoded.worker).network, "deny");
    assert.equal(record(decoded.worker).shell, "deny");
    assert.equal(record(record(decoded.profile).resourcePolicy).extensions !== undefined, true);
  },
});

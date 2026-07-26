/** Exact, secret-free publication input for the one executable v2 slice. */

import type { JsonObject, JsonValue } from "../model/primitives.js";
import {
  decodeBoundedArray,
  decodeBoundedString,
  decodeIntegrityDigest,
  decodeJsonValue,
  decodeSecretFreeJsonObject,
  decodeServiceId,
} from "../codecs/index.js";
import { codecFail, type CodecPath } from "../codecs/errors.js";
import { at, decodePlainObject, requireExactFields } from "../codecs/structure.js";
import { FIRST_SLICE_CONFIGURATION_V1 } from "./fixture-v1.js";

const DOCUMENT_BOUNDS = Object.freeze({
  maximumDepth: 16,
  maximumNodes: 512,
  maximumStringLength: 2_048,
  maximumArrayItems: 64,
  maximumObjectFields: 64,
});

export interface FirstSliceDeclarativeResource {
  readonly kind: "skill" | "prompt-template" | "theme";
  readonly snapshotId: string;
  readonly displayName: string;
  readonly artifactRef: string;
  readonly integrityDigest: string;
}

export interface FirstSliceExtensionGrant {
  readonly extensionId: string;
  readonly extensionRef: string;
  readonly extensionRevisionId: string;
  readonly revision: 1;
  readonly displayName: string;
  readonly configurationSchema: Readonly<JsonObject>;
  readonly revisionArtifactRef: string;
  readonly revisionIntegrityDigest: string;
  readonly grantSnapshotId: string;
  readonly grantIntegrityDigest: string;
  readonly ownerUseGrant: "required";
  readonly capabilityIds: readonly string[];
  readonly promptLifecycle: "agent-loop-preserving";
  readonly configuration: Readonly<JsonObject>;
}

type ExactFirstSliceFixture = typeof FIRST_SLICE_CONFIGURATION_V1;

/** Fully frozen publication input. Semantic cross-record checks are V2-002C. */
export type FirstSliceInstallationConfiguration = Omit<
  ExactFirstSliceFixture,
  "resources"
> & {
  readonly resources: {
    readonly skills: {
      readonly mode: "pinned";
      readonly projectResources: "disabled";
      readonly snapshots: readonly FirstSliceDeclarativeResource[];
    };
    readonly promptTemplates: {
      readonly mode: "pinned";
      readonly projectResources: "disabled";
      readonly snapshots: readonly FirstSliceDeclarativeResource[];
    };
    readonly themes: {
      readonly mode: "pinned";
      readonly projectResources: "disabled";
      readonly snapshots: readonly FirstSliceDeclarativeResource[];
    };
    readonly extensions: {
      readonly mode: "granted-only";
      readonly loading: "explicit-pinned";
      readonly promptLifecycle: "agent-loop-preserving";
      readonly grants: readonly FirstSliceExtensionGrant[];
    };
  };
};

export function decodeFirstSliceInstallationConfiguration(
  input: unknown,
  path: CodecPath = [],
): FirstSliceInstallationConfiguration {
  const document = decodeJsonValue(input, DOCUMENT_BOUNDS);
  if (document === null || Array.isArray(document) || typeof document !== "object") {
    codecFail(path, "invalid-type", "bootstrap configuration must be an object");
  }
  const object = decodePlainObject(document, path);
  const fixture = FIRST_SLICE_CONFIGURATION_V1 as unknown as JsonObject;
  requireExactFields(object, Object.keys(fixture), [], path);

  const decoded: Record<string, JsonValue> = {};
  for (const [key, expected] of Object.entries(fixture)) {
    decoded[key] = key === "resources"
      ? decodeResources(object[key], at(path, key))
      : decodeExactFixtureValue(object[key], expected, at(path, key));
  }
  return deepFreeze(
    decoded,
  ) as unknown as FirstSliceInstallationConfiguration;
}

function decodeExactFixtureValue(input: unknown, expected: JsonValue, path: CodecPath): JsonValue {
  if (expected === null || typeof expected !== "object") {
    if (input !== expected) codecFail(path, "invalid-format", `expected ${JSON.stringify(expected)}`);
    return expected;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(input) || input.length !== expected.length) {
      codecFail(path, "invalid-format", "array does not match the exact first-slice fixture");
    }
    return expected.map((item, index) => decodeExactFixtureValue(input[index], item, at(path, index)));
  }
  const object = decodePlainObject(input, path);
  requireExactFields(object, Object.keys(expected), [], path);
  const decoded: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(expected)) {
    decoded[key] = decodeExactFixtureValue(object[key], value, at(path, key));
  }
  return decoded;
}

function decodeResources(input: unknown, path: CodecPath): JsonObject {
  const expected = (FIRST_SLICE_CONFIGURATION_V1 as unknown as { resources: JsonObject }).resources;
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["skills", "promptTemplates", "themes", "extensions"], [], path);
  return {
    skills: decodeDeclarativeGroup(object.skills, expected.skills, at(path, "skills"), "skill"),
    promptTemplates: decodeDeclarativeGroup(object.promptTemplates, expected.promptTemplates, at(path, "promptTemplates"), "prompt-template"),
    themes: decodeDeclarativeGroup(object.themes, expected.themes, at(path, "themes"), "theme"),
    extensions: decodeExtensionGroup(object.extensions, expected.extensions, at(path, "extensions")),
  };
}

function decodeDeclarativeGroup(
  input: unknown,
  expected: JsonValue | undefined,
  path: CodecPath,
  kind: "skill" | "prompt-template" | "theme",
): JsonObject {
  if (expected === undefined || expected === null || Array.isArray(expected) || typeof expected !== "object") {
    throw new Error("invalid bootstrap fixture resource group");
  }
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["mode", "projectResources", "snapshots"], [], path);
  decodeExactFixtureValue(object.mode, (expected as JsonObject).mode!, at(path, "mode"));
  decodeExactFixtureValue(object.projectResources, (expected as JsonObject).projectResources!, at(path, "projectResources"));
  const snapshots = decodeBoundedArray(object.snapshots, (value, itemPath) => {
    const entry = decodePlainObject(value, itemPath);
    requireExactFields(entry, ["kind", "snapshotId", "displayName", "artifactRef", "integrityDigest"], [], itemPath);
    if (entry.kind !== kind) codecFail(at(itemPath, "kind"), "invalid-format", `expected ${kind}`);
    return {
      kind,
      snapshotId: decodeServiceId("AgentResourceSnapshot", entry.snapshotId, at(itemPath, "snapshotId")),
      displayName: decodeDisplayName(entry.displayName, at(itemPath, "displayName")),
      artifactRef: decodeArtifactRef(entry.artifactRef, at(itemPath, "artifactRef")),
      integrityDigest: decodeIntegrityDigest(entry.integrityDigest, at(itemPath, "integrityDigest")),
    } as JsonObject;
  }, { maximumItems: 32, uniqueBy: (entry) => `${entry.kind}:${entry.snapshotId}` }, at(path, "snapshots"));
  return { mode: "pinned", projectResources: "disabled", snapshots };
}

function decodeExtensionGroup(input: unknown, expected: JsonValue | undefined, path: CodecPath): JsonObject {
  if (expected === undefined || expected === null || Array.isArray(expected) || typeof expected !== "object") {
    throw new Error("invalid bootstrap fixture extension group");
  }
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["mode", "loading", "promptLifecycle", "grants"], [], path);
  for (const key of ["mode", "loading", "promptLifecycle"] as const) {
    decodeExactFixtureValue(object[key], (expected as JsonObject)[key]!, at(path, key));
  }
  const grants = decodeBoundedArray(object.grants, (value, itemPath) => {
    const entry = decodePlainObject(value, itemPath);
    requireExactFields(entry, [
      "extensionId", "extensionRef", "extensionRevisionId", "revision",
      "displayName", "configurationSchema",
      "revisionArtifactRef", "revisionIntegrityDigest", "grantSnapshotId", "grantIntegrityDigest",
      "ownerUseGrant", "capabilityIds", "promptLifecycle", "configuration",
    ], [], itemPath);
    if (entry.revision !== 1) codecFail(at(itemPath, "revision"), "invalid-format", "first-slice extension revisions are positive immutable revisions");
    if (entry.promptLifecycle !== "agent-loop-preserving") codecFail(at(itemPath, "promptLifecycle"), "invalid-format", "extension must preserve the agent loop");
    const schema = decodeExactFixtureValue(
      entry.configurationSchema,
      CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA,
      at(itemPath, "configurationSchema"),
    ) as JsonObject;
    const configuration = decodeSecretFreeJsonObject(entry.configuration, { forbiddenPaths: "all" }, at(itemPath, "configuration"));
    if (Object.keys(configuration).length !== 0) {
      codecFail(
        at(itemPath, "configuration"),
        "unsupported-discriminant",
        "only the reviewed closed empty extension configuration is supported",
      );
    }
    return {
      extensionId: decodeServiceId("Extension", entry.extensionId, at(itemPath, "extensionId")),
      extensionRef: decodeArtifactRef(entry.extensionRef, at(itemPath, "extensionRef")),
      extensionRevisionId: decodeServiceId(
        "ExtensionRevision",
        entry.extensionRevisionId,
        at(itemPath, "extensionRevisionId"),
      ),
      revision: 1,
      displayName: decodeDisplayName(entry.displayName, at(itemPath, "displayName")),
      configurationSchema: schema,
      revisionArtifactRef: decodeArtifactRef(entry.revisionArtifactRef, at(itemPath, "revisionArtifactRef")),
      revisionIntegrityDigest: decodeIntegrityDigest(entry.revisionIntegrityDigest, at(itemPath, "revisionIntegrityDigest")),
      grantSnapshotId: decodeServiceId("ExtensionGrantSnapshot", entry.grantSnapshotId, at(itemPath, "grantSnapshotId")),
      grantIntegrityDigest: decodeIntegrityDigest(entry.grantIntegrityDigest, at(itemPath, "grantIntegrityDigest")),
      ownerUseGrant: decodeExactFixtureValue(
        entry.ownerUseGrant,
        "required",
        at(itemPath, "ownerUseGrant"),
      ),
      capabilityIds: decodeBoundedArray(entry.capabilityIds, (capability, capabilityPath) => decodeServiceId("ExtensionCapability", capability, capabilityPath), { maximumItems: 32, uniqueBy: String }, at(itemPath, "capabilityIds")),
      promptLifecycle: "agent-loop-preserving",
      configuration,
    } as JsonObject;
  }, { maximumItems: 32, uniqueBy: (entry) => `${entry.extensionId}:${entry.revision}` }, at(path, "grants"));
  return { mode: "granted-only", loading: "explicit-pinned", promptLifecycle: "agent-loop-preserving", grants };
}

function decodeDisplayName(input: unknown, path: CodecPath): string {
  return decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: 128,
      label: "bootstrap display name",
    },
    path,
  );
}

function decodeArtifactRef(input: unknown, path: CodecPath): string {
  if (typeof input !== "string" || !/^[a-z][a-z0-9-]{0,127}$/u.test(input)) codecFail(path, "invalid-format", "expected an installation-bundled artifact reference");
  return input;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  required: Object.freeze([]),
  additionalProperties: false,
}) as unknown as JsonObject;

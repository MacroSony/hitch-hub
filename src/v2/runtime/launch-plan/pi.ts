/**
 * Pure Pi 0.82 launch/resource projection.
 *
 * This boundary consumes only already-authorized sandbox names and immutable
 * resource/grant metadata.  It deliberately has no process, host filesystem,
 * credential, provider-origin, environment, or authorization dependency.
 */

import type {
  AgentDriverLaunchProfileId,
  AgentProfileRevisionId,
  AgentResourceSnapshotId,
  ExtensionGrantSnapshotId,
  ExtensionId,
  ExtensionRevisionId,
  IntegrityDigest,
  SandboxPath,
  SessionSpecId,
  WorkspaceResourceId,
  WorkspaceRevisionId,
} from "../../model/primitives.js";
import {
  decodeBoundedArray,
  decodeIntegrityDigest,
  decodePositiveSafeInteger,
  decodeSandboxPath,
  decodeServiceId,
} from "../../codecs/index.js";
import { codecFail, type CodecPath } from "../../codecs/errors.js";
import {
  at,
  decodeEnum,
  decodeLiteral,
  decodePlainObject,
  requireExactFields,
} from "../../codecs/structure.js";

const MAX_LOADED_RESOURCES = 32;

const PI_082_AMBIENT_DISCOVERY_SWITCHES = Object.freeze([
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const);

export const PI_082_VERSION = "0.82.0" as const;

export const PI_082_REVIEWED_AMBIENT_DISCOVERY_SWITCHES =
  PI_082_AMBIENT_DISCOVERY_SWITCHES;

/**
 * Pi 0.82 compatibility fixture: each explicit path flag remains additive
 * after its paired global/project discovery switch is disabled.  A later
 * trusted renderer may turn these fixed pairs into argv; this module does not.
 */
export const PI_082_REVIEWED_EXPLICIT_PATH_FLAGS = Object.freeze({
  extension: "--extension",
  skill: "--skill",
  "prompt-template": "--prompt-template",
  theme: "--theme",
} as const);

export const PI_082_REVIEWED_TOOL_SELECTION_ARGUMENTS = Object.freeze([
  "--tools",
  "read,write,edit,ls",
] as const);

export type PiDeclarativeResourceKind =
  | "skill"
  | "prompt-template"
  | "theme";

export interface PiResourceSource {
  readonly kind: "profile";
}

export interface PiPinnedDeclarativeResource {
  readonly snapshotId: AgentResourceSnapshotId;
  readonly kind: PiDeclarativeResourceKind;
  readonly source: PiResourceSource;
  readonly trust: "agent-instruction";
  readonly integrityDigest: IntegrityDigest;
  readonly sandboxPath: SandboxPath;
}

export interface PiGrantedExtension {
  readonly grantSnapshotId: ExtensionGrantSnapshotId;
  readonly extensionId: ExtensionId;
  readonly extensionRevisionId: ExtensionRevisionId;
  readonly trust: "worker-executable";
  /** Digest of the exact executable ExtensionRevision artifact. */
  readonly revisionIntegrityDigest: IntegrityDigest;
  /** Digest of the exact immutable ExtensionGrantSnapshot. */
  readonly grantIntegrityDigest: IntegrityDigest;
  readonly sandboxPath: SandboxPath;
  readonly loading: "explicit-pinned";
  readonly promptLifecycle: "agent-loop-preserving";
  /**
   * The executable first slice supports exactly this pinned closed-empty
   * schema. Later reviewed typed schema variants can extend this union without
   * accepting generic JSON Schema or arbitrary configuration here.
   */
  readonly configurationSchema: PiClosedEmptyExtensionConfigurationSchema;
  /** Exact decoded configuration for the pinned closed-empty schema. */
  readonly configuration: PiClosedEmptyExtensionConfiguration;
}

export interface PiClosedEmptyExtensionConfigurationSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, never>>;
  readonly required: readonly [];
  readonly additionalProperties: false;
}

export type PiClosedEmptyExtensionConfiguration = Readonly<
  Record<string, never>
>;

export interface PiDeclarativeResourcePolicy {
  readonly mode: "pinned";
  readonly projectResources: "disabled";
}

export interface PiExtensionResourcePolicy {
  readonly mode: "granted-only";
  readonly discovery: "explicit-only";
  readonly hotReload: false;
  readonly promptLifecycle: "agent-loop-preserving";
}

export interface PiResourcePolicy {
  readonly skills: PiDeclarativeResourcePolicy;
  readonly promptTemplates: PiDeclarativeResourcePolicy;
  readonly themes: PiDeclarativeResourcePolicy;
  readonly extensions: PiExtensionResourcePolicy;
}

export interface PiLaunchSessionPin {
  readonly sessionSpecId: SessionSpecId;
  readonly agentProfileRevisionId: AgentProfileRevisionId;
  readonly workspaceRevisionId: WorkspaceRevisionId;
  readonly agentResourceSnapshotIds: readonly AgentResourceSnapshotId[];
  readonly extensionGrantSnapshotIds: readonly ExtensionGrantSnapshotId[];
}

export interface PiLaunchProfilePin {
  readonly driver: "pi-rpc";
  /** Resolved only by a trusted supervisor to a reviewed executable/base args. */
  readonly launchProfileId: AgentDriverLaunchProfileId;
  readonly piVersion: typeof PI_082_VERSION;
  readonly agentProfileRevisionId: AgentProfileRevisionId;
  readonly agentResourceSnapshotIds: readonly AgentResourceSnapshotId[];
  readonly extensionGrantSnapshotIds: readonly ExtensionGrantSnapshotId[];
  readonly resourcePolicy: PiResourcePolicy;
}

export interface PiAuthorizedAccessCeilings {
  readonly workspaceAccess: "read-write";
  readonly process: "deny";
  readonly shell: "deny";
  readonly network: "deny";
  readonly memoryBytes: number;
  readonly maximumProcesses: number;
  readonly temporaryStorageBytes: number;
  readonly outputBytes: number;
}

export interface PiWorkspaceDestination {
  readonly resourceId: WorkspaceResourceId;
  readonly sandboxPath: SandboxPath;
  readonly access: "read-write";
}

export interface PiReservedDestination {
  readonly sandboxPath: SandboxPath;
}

export interface PiSandboxAllocation {
  readonly workspace: PiWorkspaceDestination;
  readonly state: PiReservedDestination;
  readonly runtime: PiReservedDestination;
  readonly bridgeSocket: PiReservedDestination;
  /** The sole parent allocation below which explicit resource artifacts live. */
  readonly resources: PiReservedDestination;
}

/**
 * A closed, data-only input.  Notably absent: executable, base arguments,
 * environment, host paths, loader settings, provider origins, and credentials.
 */
export interface PiLaunchPlanInput {
  readonly version: 1;
  readonly session: PiLaunchSessionPin;
  readonly profile: PiLaunchProfilePin;
  readonly accessCeilings: PiAuthorizedAccessCeilings;
  readonly allocation: PiSandboxAllocation;
  readonly resources: readonly PiPinnedDeclarativeResource[];
  readonly extensions: readonly PiGrantedExtension[];
}

export type PiExplicitPathArgument =
  | {
      readonly kind: "extension";
      readonly flag: (typeof PI_082_REVIEWED_EXPLICIT_PATH_FLAGS)["extension"];
      readonly grantSnapshotId: ExtensionGrantSnapshotId;
      readonly extensionId: ExtensionId;
      readonly extensionRevisionId: ExtensionRevisionId;
      readonly revisionIntegrityDigest: IntegrityDigest;
      readonly grantIntegrityDigest: IntegrityDigest;
      readonly sandboxPath: SandboxPath;
      readonly trust: "worker-executable";
      readonly configurationSchema: PiClosedEmptyExtensionConfigurationSchema;
      readonly configuration: PiClosedEmptyExtensionConfiguration;
    }
  | {
      readonly kind: PiDeclarativeResourceKind;
      readonly flag: Exclude<
        (typeof PI_082_REVIEWED_EXPLICIT_PATH_FLAGS)[keyof typeof PI_082_REVIEWED_EXPLICIT_PATH_FLAGS],
        "--extension"
      >;
      readonly snapshotId: AgentResourceSnapshotId;
      readonly integrityDigest: IntegrityDigest;
      readonly sandboxPath: SandboxPath;
      readonly trust: "agent-instruction";
    };

export interface PiLaunchPlan {
  readonly version: 1;
  readonly driver: "pi-rpc";
  readonly piVersion: typeof PI_082_VERSION;
  readonly launchProfileId: AgentDriverLaunchProfileId;
  readonly session: PiLaunchSessionPin;
  readonly workingDirectory: SandboxPath;
  readonly accessCeilings: PiAuthorizedAccessCeilings;
  /**
   * Supervisor-facing reserved namespace.  These are sandbox names only and
   * must be independently reverified against mount sources at launch.
   */
  readonly protectedDestinations: PiSandboxAllocation;
  readonly ambientDiscoveryArguments: typeof PI_082_AMBIENT_DISCOVERY_SWITCHES;
  /**
   * Fixed Pi 0.82 model-facing tool allowlist. `bash` and every
   * extension/custom tool name remain disabled because Pi treats `--tools` as
   * the complete initial allowlist.
   */
  readonly toolSelectionArguments: typeof PI_082_REVIEWED_TOOL_SELECTION_ARGUMENTS;
  readonly resources: readonly PiPinnedDeclarativeResource[];
  readonly extensions: readonly PiGrantedExtension[];
  /** Exact, typed mappings for a later trusted Pi renderer. */
  readonly explicitPathArguments: readonly PiExplicitPathArgument[];
  /** These are fixed constraints, never caller-selected process options. */
  readonly workerAuthority: {
    readonly process: "deny";
    readonly shell: "deny";
    readonly network: "deny";
    readonly ambientContext: "deny";
    readonly hotReload: false;
  };
}

function exact(
  input: unknown,
  required: readonly string[],
  path: CodecPath,
): Record<string, unknown> {
  const object = decodePlainObject(input, path);
  requireExactFields(object, required, [], path);
  return object;
}

function pathAt(path: CodecPath, ...segments: readonly (string | number)[]): CodecPath {
  return segments.reduce(at, path);
}

function decodeExactLiteral<Literal extends string | number | boolean>(
  input: unknown,
  value: Literal,
  path: CodecPath,
): Literal {
  if (input !== value) {
    codecFail(path, "invalid-format", `expected ${JSON.stringify(value)}`);
  }
  return value;
}

function decodeDeclarativePolicy(
  input: unknown,
  path: CodecPath,
): PiDeclarativeResourcePolicy {
  const object = exact(input, ["mode", "projectResources"], path);
  return frozen({
    mode: decodeLiteral(object.mode, "pinned", at(path, "mode")),
    projectResources: decodeLiteral(
      object.projectResources,
      "disabled",
      at(path, "projectResources"),
    ),
  });
}

function decodeExtensionPolicy(
  input: unknown,
  path: CodecPath,
): PiExtensionResourcePolicy {
  const object = exact(
    input,
    ["mode", "discovery", "hotReload", "promptLifecycle"],
    path,
  );
  return frozen({
    mode: decodeLiteral(object.mode, "granted-only", at(path, "mode")),
    discovery: decodeLiteral(
      object.discovery,
      "explicit-only",
      at(path, "discovery"),
    ),
    hotReload: decodeExactLiteral(object.hotReload, false, at(path, "hotReload")),
    promptLifecycle: decodeLiteral(
      object.promptLifecycle,
      "agent-loop-preserving",
      at(path, "promptLifecycle"),
    ),
  });
}

function decodeResourcePolicy(input: unknown, path: CodecPath): PiResourcePolicy {
  const object = exact(
    input,
    ["skills", "promptTemplates", "themes", "extensions"],
    path,
  );
  return frozen({
    skills: decodeDeclarativePolicy(object.skills, at(path, "skills")),
    promptTemplates: decodeDeclarativePolicy(
      object.promptTemplates,
      at(path, "promptTemplates"),
    ),
    themes: decodeDeclarativePolicy(object.themes, at(path, "themes")),
    extensions: decodeExtensionPolicy(object.extensions, at(path, "extensions")),
  });
}

function decodeSessionPin(input: unknown, path: CodecPath): PiLaunchSessionPin {
  const object = exact(
    input,
    [
      "sessionSpecId",
      "agentProfileRevisionId",
      "workspaceRevisionId",
      "agentResourceSnapshotIds",
      "extensionGrantSnapshotIds",
    ],
    path,
  );
  return frozen({
    sessionSpecId: decodeServiceId("SessionSpec", object.sessionSpecId, at(path, "sessionSpecId")),
    agentProfileRevisionId: decodeServiceId(
      "AgentProfileRevision",
      object.agentProfileRevisionId,
      at(path, "agentProfileRevisionId"),
    ),
    workspaceRevisionId: decodeServiceId(
      "WorkspaceRevision",
      object.workspaceRevisionId,
      at(path, "workspaceRevisionId"),
    ),
    agentResourceSnapshotIds: decodeBoundedArray(
      object.agentResourceSnapshotIds,
      (item, itemPath) => decodeServiceId("AgentResourceSnapshot", item, itemPath),
      { maximumItems: MAX_LOADED_RESOURCES, uniqueBy: String },
      at(path, "agentResourceSnapshotIds"),
    ),
    extensionGrantSnapshotIds: decodeBoundedArray(
      object.extensionGrantSnapshotIds,
      (item, itemPath) => decodeServiceId("ExtensionGrantSnapshot", item, itemPath),
      { maximumItems: MAX_LOADED_RESOURCES, uniqueBy: String },
      at(path, "extensionGrantSnapshotIds"),
    ),
  });
}

function decodeProfilePin(input: unknown, path: CodecPath): PiLaunchProfilePin {
  const object = exact(
    input,
    [
      "driver",
      "launchProfileId",
      "piVersion",
      "agentProfileRevisionId",
      "agentResourceSnapshotIds",
      "extensionGrantSnapshotIds",
      "resourcePolicy",
    ],
    path,
  );
  return frozen({
    driver: decodeLiteral(object.driver, "pi-rpc", at(path, "driver")),
    launchProfileId: decodeServiceId(
      "AgentDriverLaunchProfile",
      object.launchProfileId,
      at(path, "launchProfileId"),
    ),
    piVersion: decodeLiteral(object.piVersion, PI_082_VERSION, at(path, "piVersion")),
    agentProfileRevisionId: decodeServiceId(
      "AgentProfileRevision",
      object.agentProfileRevisionId,
      at(path, "agentProfileRevisionId"),
    ),
    agentResourceSnapshotIds: decodeBoundedArray(
      object.agentResourceSnapshotIds,
      (item, itemPath) => decodeServiceId("AgentResourceSnapshot", item, itemPath),
      { maximumItems: MAX_LOADED_RESOURCES, uniqueBy: String },
      at(path, "agentResourceSnapshotIds"),
    ),
    extensionGrantSnapshotIds: decodeBoundedArray(
      object.extensionGrantSnapshotIds,
      (item, itemPath) => decodeServiceId("ExtensionGrantSnapshot", item, itemPath),
      { maximumItems: MAX_LOADED_RESOURCES, uniqueBy: String },
      at(path, "extensionGrantSnapshotIds"),
    ),
    resourcePolicy: decodeResourcePolicy(object.resourcePolicy, at(path, "resourcePolicy")),
  });
}

function decodeAccessCeilings(
  input: unknown,
  path: CodecPath,
): PiAuthorizedAccessCeilings {
  const object = exact(
    input,
    [
      "workspaceAccess",
      "process",
      "shell",
      "network",
      "memoryBytes",
      "maximumProcesses",
      "temporaryStorageBytes",
      "outputBytes",
    ],
    path,
  );
  return frozen({
    workspaceAccess: decodeLiteral(
      object.workspaceAccess,
      "read-write",
      at(path, "workspaceAccess"),
    ),
    process: decodeLiteral(object.process, "deny", at(path, "process")),
    shell: decodeLiteral(object.shell, "deny", at(path, "shell")),
    network: decodeLiteral(object.network, "deny", at(path, "network")),
    memoryBytes: decodePositiveSafeInteger(object.memoryBytes, at(path, "memoryBytes")),
    maximumProcesses: decodePositiveSafeInteger(
      object.maximumProcesses,
      at(path, "maximumProcesses"),
    ),
    temporaryStorageBytes: decodePositiveSafeInteger(
      object.temporaryStorageBytes,
      at(path, "temporaryStorageBytes"),
    ),
    outputBytes: decodePositiveSafeInteger(object.outputBytes, at(path, "outputBytes")),
  });
}

function decodeReservedDestination(
  input: unknown,
  path: CodecPath,
): PiReservedDestination {
  const object = exact(input, ["sandboxPath"], path);
  return frozen({ sandboxPath: decodeSandboxPath(object.sandboxPath, at(path, "sandboxPath")) });
}

function decodeAllocation(input: unknown, path: CodecPath): PiSandboxAllocation {
  const object = exact(
    input,
    ["workspace", "state", "runtime", "bridgeSocket", "resources"],
    path,
  );
  const workspace = exact(
    object.workspace,
    ["resourceId", "sandboxPath", "access"],
    at(path, "workspace"),
  );
  return frozen({
    workspace: frozen({
      resourceId: decodeServiceId(
        "WorkspaceResource",
        workspace.resourceId,
        pathAt(path, "workspace", "resourceId"),
      ),
      sandboxPath: decodeSandboxPath(
        workspace.sandboxPath,
        pathAt(path, "workspace", "sandboxPath"),
      ),
      access: decodeLiteral(
        workspace.access,
        "read-write",
        pathAt(path, "workspace", "access"),
      ),
    }),
    state: decodeReservedDestination(object.state, at(path, "state")),
    runtime: decodeReservedDestination(object.runtime, at(path, "runtime")),
    bridgeSocket: decodeReservedDestination(
      object.bridgeSocket,
      at(path, "bridgeSocket"),
    ),
    resources: decodeReservedDestination(object.resources, at(path, "resources")),
  });
}

function decodeResourceSource(input: unknown, path: CodecPath): PiResourceSource {
  const object = exact(input, ["kind"], path);
  return frozen({
    kind: decodeLiteral(object.kind, "profile", at(path, "kind")),
  });
}

function decodePinnedResource(
  input: unknown,
  path: CodecPath,
): PiPinnedDeclarativeResource {
  const object = exact(
    input,
    ["snapshotId", "kind", "source", "integrityDigest", "sandboxPath"],
    path,
  );
  return frozen({
    snapshotId: decodeServiceId(
      "AgentResourceSnapshot",
      object.snapshotId,
      at(path, "snapshotId"),
    ),
    kind: decodeEnum(
      object.kind,
      ["skill", "prompt-template", "theme"] as const,
      at(path, "kind"),
    ),
    source: decodeResourceSource(object.source, at(path, "source")),
    trust: "agent-instruction",
    integrityDigest: decodeIntegrityDigest(
      object.integrityDigest,
      at(path, "integrityDigest"),
    ),
    sandboxPath: decodeSandboxPath(object.sandboxPath, at(path, "sandboxPath")),
  });
}

function decodeGrantedExtension(input: unknown, path: CodecPath): PiGrantedExtension {
  const object = exact(
    input,
    [
      "grantSnapshotId",
      "extensionId",
      "extensionRevisionId",
      "revisionIntegrityDigest",
      "grantIntegrityDigest",
      "sandboxPath",
      "loading",
      "promptLifecycle",
      "configurationSchema",
      "configuration",
    ],
    path,
  );
  return frozen({
    grantSnapshotId: decodeServiceId(
      "ExtensionGrantSnapshot",
      object.grantSnapshotId,
      at(path, "grantSnapshotId"),
    ),
    extensionId: decodeServiceId("Extension", object.extensionId, at(path, "extensionId")),
    extensionRevisionId: decodeServiceId(
      "ExtensionRevision",
      object.extensionRevisionId,
      at(path, "extensionRevisionId"),
    ),
    trust: "worker-executable",
    revisionIntegrityDigest: decodeIntegrityDigest(
      object.revisionIntegrityDigest,
      at(path, "revisionIntegrityDigest"),
    ),
    grantIntegrityDigest: decodeIntegrityDigest(
      object.grantIntegrityDigest,
      at(path, "grantIntegrityDigest"),
    ),
    sandboxPath: decodeSandboxPath(object.sandboxPath, at(path, "sandboxPath")),
    loading: decodeLiteral(object.loading, "explicit-pinned", at(path, "loading")),
    promptLifecycle: decodeLiteral(
      object.promptLifecycle,
      "agent-loop-preserving",
      at(path, "promptLifecycle"),
    ),
    configurationSchema: decodeClosedEmptyExtensionConfigurationSchema(
      object.configurationSchema,
      at(path, "configurationSchema"),
    ),
    configuration: decodeClosedEmptyExtensionConfiguration(
      object.configuration,
      at(path, "configuration"),
    ),
  });
}

function decodeClosedEmptyExtensionConfigurationSchema(
  input: unknown,
  path: CodecPath,
): PiClosedEmptyExtensionConfigurationSchema {
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
        "first-slice extension configuration schema has no required fields",
      ),
    { maximumItems: 0 },
    at(path, "required"),
  ) as readonly [];
  return frozen({
    type: decodeLiteral(object.type, "object", at(path, "type")),
    properties: frozen({}) as Readonly<Record<string, never>>,
    required,
    additionalProperties: decodeExactLiteral(
      object.additionalProperties,
      false,
      at(path, "additionalProperties"),
    ),
  });
}

function decodeClosedEmptyExtensionConfiguration(
  input: unknown,
  path: CodecPath,
): PiClosedEmptyExtensionConfiguration {
  exact(input, [], path);
  return frozen({}) as PiClosedEmptyExtensionConfiguration;
}

/** Decode and detach the closed semantic launch-planning input. */
export function decodePiLaunchPlanInput(
  input: unknown,
  path: CodecPath = [],
): PiLaunchPlanInput {
  const object = exact(
    input,
    [
      "version",
      "session",
      "profile",
      "accessCeilings",
      "allocation",
      "resources",
      "extensions",
    ],
    path,
  );
  const decoded: PiLaunchPlanInput = frozen({
    version: decodeExactLiteral(object.version, 1, at(path, "version")),
    session: decodeSessionPin(object.session, at(path, "session")),
    profile: decodeProfilePin(object.profile, at(path, "profile")),
    accessCeilings: decodeAccessCeilings(
      object.accessCeilings,
      at(path, "accessCeilings"),
    ),
    allocation: decodeAllocation(object.allocation, at(path, "allocation")),
    resources: decodeBoundedArray(
      object.resources,
      decodePinnedResource,
      { maximumItems: MAX_LOADED_RESOURCES, uniqueBy: (resource) => resource.snapshotId },
      at(path, "resources"),
    ),
    extensions: decodeBoundedArray(
      object.extensions,
      decodeGrantedExtension,
      {
        maximumItems: MAX_LOADED_RESOURCES,
        uniqueBy: (extension) => extension.grantSnapshotId,
      },
      at(path, "extensions"),
    ),
  });
  validatePiLaunchInput(decoded, path);
  return decoded;
}

/**
 * Decode and render the deterministic, non-executable Pi launch projection.
 * This is intentionally the only operation exported for normal consumption.
 */
export function projectPiLaunchPlan(input: unknown): PiLaunchPlan {
  const decoded = decodePiLaunchPlanInput(input);
  const resources = [...decoded.resources].sort(compareResources);
  const extensions = [...decoded.extensions].sort(compareExtensions);
  const explicitPathArguments = [
    ...extensions.map(toExtensionArgument),
    ...resources.map(toResourceArgument),
  ];

  return frozen({
    version: 1,
    driver: "pi-rpc",
    piVersion: PI_082_VERSION,
    launchProfileId: decoded.profile.launchProfileId,
    session: cloneSessionPin(decoded.session),
    workingDirectory: decoded.allocation.workspace.sandboxPath,
    accessCeilings: cloneAccessCeilings(decoded.accessCeilings),
    protectedDestinations: cloneAllocation(decoded.allocation),
    ambientDiscoveryArguments: [...PI_082_AMBIENT_DISCOVERY_SWITCHES],
    toolSelectionArguments: [...PI_082_REVIEWED_TOOL_SELECTION_ARGUMENTS],
    resources: resources.map(cloneResource),
    extensions: extensions.map(cloneExtension),
    explicitPathArguments,
    workerAuthority: {
      process: "deny",
      shell: "deny",
      network: "deny",
      ambientContext: "deny",
      hotReload: false,
    },
  }) as PiLaunchPlan;
}

function validatePiLaunchInput(input: PiLaunchPlanInput, path: CodecPath): void {
  if (input.session.agentProfileRevisionId !== input.profile.agentProfileRevisionId) {
    codecFail(
      pathAt(path, "profile", "agentProfileRevisionId"),
      "invalid-format",
      "profile revision does not match the immutable SessionSpec pin",
    );
  }
  assertExactSet(
    input.profile.extensionGrantSnapshotIds,
    input.session.extensionGrantSnapshotIds,
    pathAt(path, "profile", "extensionGrantSnapshotIds"),
    "profile and SessionSpec extension grants differ",
  );
  assertExactSet(
    input.profile.agentResourceSnapshotIds,
    input.session.agentResourceSnapshotIds,
    pathAt(path, "profile", "agentResourceSnapshotIds"),
    "profile and SessionSpec resources differ",
  );
  assertLoadedResourcesAreSessionBijection(input, path);
  assertProtectedDestinationLayout(input.allocation, at(path, "allocation"));
  assertArtifactDestinations(input, path);
}

function assertLoadedResourcesAreSessionBijection(
  input: PiLaunchPlanInput,
  path: CodecPath,
): void {
  assertExactSet(
    input.session.agentResourceSnapshotIds,
    input.resources.map((resource) => resource.snapshotId),
    at(path, "resources"),
    "loaded resource snapshots do not exactly match the SessionSpec",
  );
  assertExactSet(
    input.session.extensionGrantSnapshotIds,
    input.extensions.map((extension) => extension.grantSnapshotId),
    at(path, "extensions"),
    "loaded extension grants do not exactly match the SessionSpec",
  );
}

function assertProtectedDestinationLayout(
  allocation: PiSandboxAllocation,
  path: CodecPath,
): void {
  const destinations = [
    ["workspace", allocation.workspace.sandboxPath],
    ["state", allocation.state.sandboxPath],
    ["runtime", allocation.runtime.sandboxPath],
    ["bridgeSocket", allocation.bridgeSocket.sandboxPath],
    ["resources", allocation.resources.sandboxPath],
  ] as const;
  assertNoEqualOrNestedPaths(destinations, path, "protected destinations");
}

function assertArtifactDestinations(input: PiLaunchPlanInput, path: CodecPath): void {
  const artifactPaths: Array<readonly [string, SandboxPath]> = [];
  for (const resource of input.resources) {
    assertStrictChild(
      input.allocation.resources.sandboxPath,
      resource.sandboxPath,
      at(path, "resources"),
      "resource path",
    );
    artifactPaths.push([`resource:${resource.snapshotId}`, resource.sandboxPath]);
  }
  const extensionIds = new Set<string>();
  const extensionRevisionIds = new Set<string>();
  for (const extension of input.extensions) {
    assertStrictChild(
      input.allocation.resources.sandboxPath,
      extension.sandboxPath,
      at(path, "extensions"),
      "extension path",
    );
    assertUnique(extensionIds, extension.extensionId, at(path, "extensions"), "extension ID");
    assertUnique(
      extensionRevisionIds,
      extension.extensionRevisionId,
      at(path, "extensions"),
      "extension revision ID",
    );
    artifactPaths.push([`extension:${extension.grantSnapshotId}`, extension.sandboxPath]);
  }
  assertNoEqualOrNestedPaths(
    artifactPaths,
    pathAt(path, "allocation", "resources"),
    "resource artifacts",
  );
}

function assertStrictChild(
  parent: SandboxPath,
  child: SandboxPath,
  path: CodecPath,
  label: string,
): void {
  if (!child.startsWith(`${parent}/`)) {
    codecFail(path, "forbidden-path", `${label} must be inside the reviewed resources allocation`);
  }
}

function assertNoEqualOrNestedPaths(
  entries: readonly (readonly [string, SandboxPath])[],
  path: CodecPath,
  label: string,
): void {
  for (let left = 0; left < entries.length; left += 1) {
    const leftEntry = entries[left];
    if (leftEntry === undefined) continue;
    for (let right = left + 1; right < entries.length; right += 1) {
      const rightEntry = entries[right];
      if (rightEntry === undefined) continue;
      if (pathsCollideOrNest(leftEntry[1], rightEntry[1])) {
        codecFail(
          path,
          "forbidden-path",
          `${label} ${leftEntry[0]} and ${rightEntry[0]} collide or shadow one another`,
        );
      }
    }
  }
}

function pathsCollideOrNest(left: SandboxPath, right: SandboxPath): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertExactSet(
  expected: readonly string[],
  actual: readonly string[],
  path: CodecPath,
  message: string,
): void {
  if (expected.length !== actual.length) codecFail(path, "invalid-format", message);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    expectedSet.size !== expected.length ||
    actualSet.size !== actual.length ||
    expectedSet.size !== actualSet.size ||
    [...expectedSet].some((value) => !actualSet.has(value))
  ) {
    codecFail(path, "invalid-format", message);
  }
}

function assertUnique(
  values: Set<string>,
  value: string,
  path: CodecPath,
  label: string,
): void {
  if (values.has(value)) codecFail(path, "duplicate-item", `duplicate ${label}`);
  values.add(value);
}

function compareResources(
  left: PiPinnedDeclarativeResource,
  right: PiPinnedDeclarativeResource,
): number {
  const rank: Record<PiDeclarativeResourceKind, number> = {
    skill: 0,
    "prompt-template": 1,
    theme: 2,
  };
  return (
    rank[left.kind] - rank[right.kind] ||
    compareCodeUnits(left.snapshotId, right.snapshotId) ||
    compareCodeUnits(left.sandboxPath, right.sandboxPath)
  );
}

function compareExtensions(left: PiGrantedExtension, right: PiGrantedExtension): number {
  return (
    compareCodeUnits(left.extensionId, right.extensionId) ||
    compareCodeUnits(left.extensionRevisionId, right.extensionRevisionId) ||
    compareCodeUnits(left.grantSnapshotId, right.grantSnapshotId) ||
    compareCodeUnits(left.sandboxPath, right.sandboxPath)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function toResourceArgument(resource: PiPinnedDeclarativeResource): PiExplicitPathArgument {
  const flag =
    resource.kind === "skill"
      ? PI_082_REVIEWED_EXPLICIT_PATH_FLAGS.skill
      : resource.kind === "prompt-template"
        ? PI_082_REVIEWED_EXPLICIT_PATH_FLAGS["prompt-template"]
        : PI_082_REVIEWED_EXPLICIT_PATH_FLAGS.theme;
  return frozen({
    kind: resource.kind,
    flag,
    snapshotId: resource.snapshotId,
    integrityDigest: resource.integrityDigest,
    sandboxPath: resource.sandboxPath,
    trust: "agent-instruction",
  }) as PiExplicitPathArgument;
}

function toExtensionArgument(extension: PiGrantedExtension): PiExplicitPathArgument {
  return frozen({
    kind: "extension",
    flag: PI_082_REVIEWED_EXPLICIT_PATH_FLAGS.extension,
    grantSnapshotId: extension.grantSnapshotId,
    extensionId: extension.extensionId,
    extensionRevisionId: extension.extensionRevisionId,
    revisionIntegrityDigest: extension.revisionIntegrityDigest,
    grantIntegrityDigest: extension.grantIntegrityDigest,
    sandboxPath: extension.sandboxPath,
    trust: "worker-executable",
    configurationSchema: cloneConfigurationSchema(extension.configurationSchema),
    configuration: frozen({}),
  }) as PiExplicitPathArgument;
}

function cloneSessionPin(value: PiLaunchSessionPin): PiLaunchSessionPin {
  return frozen({
    sessionSpecId: value.sessionSpecId,
    agentProfileRevisionId: value.agentProfileRevisionId,
    workspaceRevisionId: value.workspaceRevisionId,
    agentResourceSnapshotIds: [...value.agentResourceSnapshotIds].sort(compareCodeUnits),
    extensionGrantSnapshotIds: [...value.extensionGrantSnapshotIds].sort(compareCodeUnits),
  });
}

function cloneAccessCeilings(value: PiAuthorizedAccessCeilings): PiAuthorizedAccessCeilings {
  return frozen({ ...value });
}

function cloneAllocation(value: PiSandboxAllocation): PiSandboxAllocation {
  return frozen({
    workspace: { ...value.workspace },
    state: { ...value.state },
    runtime: { ...value.runtime },
    bridgeSocket: { ...value.bridgeSocket },
    resources: { ...value.resources },
  });
}

function cloneResource(value: PiPinnedDeclarativeResource): PiPinnedDeclarativeResource {
  return frozen({
    ...value,
    source: { kind: "profile" },
  });
}

function cloneExtension(value: PiGrantedExtension): PiGrantedExtension {
  return frozen({
    ...value,
    configurationSchema: cloneConfigurationSchema(value.configurationSchema),
    configuration: {},
  });
}

function cloneConfigurationSchema(
  value: PiClosedEmptyExtensionConfigurationSchema,
): PiClosedEmptyExtensionConfigurationSchema {
  return frozen({
    type: value.type,
    properties: {},
    required: [],
    additionalProperties: value.additionalProperties,
  });
}

function frozen<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      frozen(child);
    }
    Object.freeze(value);
  }
  return value;
}

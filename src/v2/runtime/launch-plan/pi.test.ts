import assert from "node:assert/strict";
import { test } from "node:test";

import { CodecDecodeError } from "../../codecs/errors.js";
import { scenarioCase } from "../../acceptance/runner.js";
import {
  PI_082_REVIEWED_AMBIENT_DISCOVERY_SWITCHES,
  PI_082_REVIEWED_EXPLICIT_PATH_FLAGS,
  PI_082_REVIEWED_TOOL_SELECTION_ARGUMENTS,
  PI_082_VERSION,
  decodePiLaunchPlanInput,
  projectPiLaunchPlan,
} from "./index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const OFFICIAL_PI_082_DISCOVERY_SWITCHES = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
] as const;
const OFFICIAL_PI_082_EXPLICIT_PATH_FLAGS = {
  extension: "--extension",
  skill: "--skill",
  "prompt-template": "--prompt-template",
  theme: "--theme",
} as const;
const OFFICIAL_PI_082_TOOL_SELECTION_ARGUMENTS = [
  "--tools",
  "read,write,edit,ls",
] as const;
const CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

function validInput(): Record<string, unknown> {
  return {
    version: 1,
    session: {
      sessionSpecId: "session-spec:001",
      agentProfileRevisionId: "profile-revision:001",
      workspaceRevisionId: "workspace-revision:001",
      agentResourceSnapshotIds: [
        "resource.skill:001",
        "resource.template:001",
        "resource.theme:001",
      ],
      extensionGrantSnapshotIds: ["extension-grant:001"],
    },
    profile: {
      driver: "pi-rpc",
      launchProfileId: "pi-launch-profile:001",
      piVersion: "0.82.0",
      agentProfileRevisionId: "profile-revision:001",
      agentResourceSnapshotIds: [
        "resource.skill:001",
        "resource.template:001",
        "resource.theme:001",
      ],
      extensionGrantSnapshotIds: ["extension-grant:001"],
      resourcePolicy: {
        skills: { mode: "pinned", projectResources: "disabled" },
        promptTemplates: {
          mode: "pinned",
          projectResources: "disabled",
        },
        themes: { mode: "pinned", projectResources: "disabled" },
        extensions: {
          mode: "granted-only",
          discovery: "explicit-only",
          hotReload: false,
          promptLifecycle: "agent-loop-preserving",
        },
      },
    },
    accessCeilings: {
      workspaceAccess: "read-write",
      process: "deny",
      shell: "deny",
      network: "deny",
      memoryBytes: 256_000_000,
      maximumProcesses: 8,
      temporaryStorageBytes: 1_000_000,
      outputBytes: 100_000,
    },
    allocation: {
      workspace: {
        resourceId: "workspace-resource:001",
        sandboxPath: "/workspace",
        access: "read-write",
      },
      state: { sandboxPath: "/hitch-state" },
      runtime: { sandboxPath: "/hitch-runtime" },
      bridgeSocket: { sandboxPath: "/hitch-bridge.sock" },
      resources: { sandboxPath: "/hitch-resources" },
    },
    resources: [
      {
        snapshotId: "resource.theme:001",
        kind: "theme",
        source: { kind: "profile" },
        integrityDigest: digest("c"),
        sandboxPath: "/hitch-resources/theme-one",
      },
      {
        snapshotId: "resource.template:001",
        kind: "prompt-template",
        source: { kind: "profile" },
        integrityDigest: digest("b"),
        sandboxPath: "/hitch-resources/template-one",
      },
      {
        snapshotId: "resource.skill:001",
        kind: "skill",
        source: { kind: "profile" },
        integrityDigest: digest("a"),
        sandboxPath: "/hitch-resources/skill-one",
      },
    ],
    extensions: [
      {
        grantSnapshotId: "extension-grant:001",
        extensionId: "extension:001",
        extensionRevisionId: "extension-revision:001",
        // Content-addressed artifacts may legitimately share bytes.
        revisionIntegrityDigest: digest("a"),
        grantIntegrityDigest: digest("d"),
        sandboxPath: "/hitch-resources/extension-one",
        loading: "explicit-pinned",
        promptLifecycle: "agent-loop-preserving",
        configurationSchema: clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
        configuration: {},
      },
    ],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function expectCodecFailure(operation: () => unknown, label?: string): void {
  assert.throws(operation, CodecDecodeError, label);
}

function asObject(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}

function extensionRecord(input: Record<string, unknown>): Record<string, unknown> {
  return asObject((input.extensions as unknown[])[0]);
}

function unsafeBoundaryInputs(): readonly {
  readonly label: string;
  readonly input: Record<string, unknown>;
}[] {
  const cases: Array<{
    readonly label: string;
    readonly input: Record<string, unknown>;
  }> = [];
  const add = (
    label: string,
    mutate: (input: Record<string, unknown>) => void,
  ): void => {
    const input = validInput();
    mutate(input);
    cases.push({ label, input });
  };
  const extensionConfiguration = (field: string, value: unknown): void =>
    add(`extension configuration ${field}`, (input) => {
      extensionRecord(input).configuration = { [field]: value };
    });

  extensionConfiguration("bearerToken", "not-forwardable");
  extensionConfiguration("loader", "custom-loader");
  extensionConfiguration("args", ["--unsafe"]);
  extensionConfiguration("argv", ["--unsafe"]);
  extensionConfiguration("environment", { NODE_OPTIONS: "--require=evil" });
  extensionConfiguration("env", { NODE_OPTIONS: "--require=evil" });
  extensionConfiguration("command", "/bin/sh");
  extensionConfiguration("credential", "credential-value");
  extensionConfiguration("origin", "https://unreviewed.example");
  extensionConfiguration("header", "Authorization: Bearer value");
  extensionConfiguration("headers", { authorization: "Bearer value" });
  extensionConfiguration("endpoint", "https://unreviewed.example/api");
  extensionConfiguration("path", "/etc/shadow");

  add("top-level command", (input) => {
    input.command = "/bin/sh -c evil";
  });
  add("profile base arguments", (input) => {
    asObject(input.profile).baseArgs = ["--load", "evil"];
  });
  add("top-level environment", (input) => {
    input.environment = { NODE_OPTIONS: "--require=evil" };
  });
  add("top-level env", (input) => {
    input.env = { NODE_OPTIONS: "--require=evil" };
  });
  add("canonical host path", (input) => {
    asObject(input.allocation).canonicalHostPath =
      "/home/operator/.config/pi/auth.json";
  });
  add("worker network authority", (input) => {
    asObject(input.accessCeilings).network = "host-network";
  });
  add("worker process authority", (input) => {
    asObject(input.accessCeilings).process = "allow";
  });
  add("worker shell authority", (input) => {
    asObject(input.accessCeilings).shell = "allow";
  });
  add("escaping resource sandbox path", (input) => {
    asObject((input.resources as unknown[])[0]).sandboxPath =
      "/hitch-resources/../hitch-state";
  });

  add("schema type drift", (input) => {
    extensionRecord(input).configurationSchema = {
      ...clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
      type: "array",
    };
  });
  add("schema properties drift", (input) => {
    extensionRecord(input).configurationSchema = {
      ...clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
      properties: { args: { type: "array" } },
    };
  });
  add("schema required drift", (input) => {
    extensionRecord(input).configurationSchema = {
      ...clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
      required: ["command"],
    };
  });
  add("schema additional-properties drift", (input) => {
    extensionRecord(input).configurationSchema = {
      ...clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
      additionalProperties: true,
    };
  });
  add("schema unknown-field drift", (input) => {
    extensionRecord(input).configurationSchema = {
      ...clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
      $schema: "https://json-schema.org/draft/2020-12/schema",
    };
  });

  return cases;
}

test("Pi planner emits only fixed discovery switches and typed explicit resource flags", () => {
  const plan = projectPiLaunchPlan(validInput());

  assert.equal(plan.piVersion, "0.82.0");
  assert.equal(PI_082_VERSION, "0.82.0");
  assert.deepEqual(
    PI_082_REVIEWED_AMBIENT_DISCOVERY_SWITCHES,
    OFFICIAL_PI_082_DISCOVERY_SWITCHES,
  );
  assert.deepEqual(
    PI_082_REVIEWED_EXPLICIT_PATH_FLAGS,
    OFFICIAL_PI_082_EXPLICIT_PATH_FLAGS,
  );
  assert.deepEqual(
    plan.ambientDiscoveryArguments,
    OFFICIAL_PI_082_DISCOVERY_SWITCHES,
  );
  assert.deepEqual(
    PI_082_REVIEWED_TOOL_SELECTION_ARGUMENTS,
    OFFICIAL_PI_082_TOOL_SELECTION_ARGUMENTS,
  );
  assert.deepEqual(
    plan.toolSelectionArguments,
    OFFICIAL_PI_082_TOOL_SELECTION_ARGUMENTS,
  );
  assert.deepEqual(
    plan.explicitPathArguments.map((argument) => [argument.flag, argument.sandboxPath]),
    [
      ["--extension", "/hitch-resources/extension-one"],
      ["--skill", "/hitch-resources/skill-one"],
      ["--prompt-template", "/hitch-resources/template-one"],
      ["--theme", "/hitch-resources/theme-one"],
    ],
  );
  assert.deepEqual(plan.resources.map((resource) => resource.snapshotId), [
    "resource.skill:001",
    "resource.template:001",
    "resource.theme:001",
  ]);
  assert.equal(plan.extensions[0]?.trust, "worker-executable");
  assert.equal(plan.extensions[0]?.revisionIntegrityDigest, digest("a"));
  assert.equal(plan.extensions[0]?.grantIntegrityDigest, digest("d"));
  assert.deepEqual(
    plan.extensions[0]?.configurationSchema,
    CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA,
  );
  assert.deepEqual(plan.extensions[0]?.configuration, {});
  const extensionArgument = plan.explicitPathArguments[0];
  assert.equal(extensionArgument?.kind, "extension");
  if (extensionArgument?.kind === "extension") {
    assert.equal(extensionArgument.revisionIntegrityDigest, digest("a"));
    assert.equal(extensionArgument.grantIntegrityDigest, digest("d"));
    assert.deepEqual(
      extensionArgument.configurationSchema,
      CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA,
    );
    assert.deepEqual(extensionArgument.configuration, {});
  }
  assert.deepEqual(plan.workerAuthority, {
    process: "deny",
    shell: "deny",
    network: "deny",
    ambientContext: "deny",
    hotReload: false,
  });
  assert.equal("command" in (plan as object), false);
  assert.equal("environment" in (plan as object), false);
  assert.equal("baseArgs" in (plan as object), false);
  assert.equal(
    (plan.toolSelectionArguments as readonly string[]).includes("bash"),
    false,
  );
});

test("Pi planner permits empty approved resource and extension sets", () => {
  const input = validInput();
  const session = asObject(input.session);
  const profile = asObject(input.profile);
  session.agentResourceSnapshotIds = [];
  session.extensionGrantSnapshotIds = [];
  profile.agentResourceSnapshotIds = [];
  profile.extensionGrantSnapshotIds = [];
  input.resources = [];
  input.extensions = [];

  const plan = projectPiLaunchPlan(input);
  assert.deepEqual(plan.resources, []);
  assert.deepEqual(plan.extensions, []);
  assert.deepEqual(plan.explicitPathArguments, []);
  assert.deepEqual(plan.ambientDiscoveryArguments, OFFICIAL_PI_082_DISCOVERY_SWITCHES);
});

test("Pi planner canonicalizes semantic ordering without changing pins", () => {
  const first = validInput();
  const second = clone(first);
  const secondSession = asObject(second.session);
  const secondProfile = asObject(second.profile);
  second.resources = [...(second.resources as unknown[])].reverse();
  second.extensions = [...(second.extensions as unknown[])].reverse();
  secondSession.agentResourceSnapshotIds = [
    "resource.theme:001",
    "resource.template:001",
    "resource.skill:001",
  ];
  secondProfile.agentResourceSnapshotIds = [
    "resource.theme:001",
    "resource.template:001",
    "resource.skill:001",
  ];

  assert.deepEqual(projectPiLaunchPlan(first), projectPiLaunchPlan(second));
});

test("Pi planner orders mixed case and punctuation by locale-independent code units", () => {
  const input = validInput();
  const session = asObject(input.session);
  const profile = asObject(input.profile);
  const resourceIds = [
    "resource.skill:i",
    "resource.skill:_a",
    "resource.skill:I",
    "resource.skill:-a",
    "resource.skill:001",
  ];
  session.agentResourceSnapshotIds = resourceIds;
  profile.agentResourceSnapshotIds = [...resourceIds].reverse();
  input.resources = resourceIds.map((snapshotId, index) => ({
    snapshotId,
    kind: "skill",
    source: { kind: "profile" },
    integrityDigest: digest("a"),
    sandboxPath: `/hitch-resources/skill-${index}`,
  }));

  const extensionIds = [
    "extension:i",
    "extension:_a",
    "extension:I",
    "extension:-a",
  ];
  const grants = extensionIds.map((extensionId, index) => ({
    grantSnapshotId: `extension-grant:${index}`,
    extensionId,
    extensionRevisionId: `extension-revision:${index}`,
    revisionIntegrityDigest: digest("a"),
    grantIntegrityDigest: digest("d"),
    sandboxPath: `/hitch-resources/extension-${index}`,
    loading: "explicit-pinned",
    promptLifecycle: "agent-loop-preserving",
    configurationSchema: clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
    configuration: {},
  }));
  session.extensionGrantSnapshotIds = grants.map((grant) => grant.grantSnapshotId);
  profile.extensionGrantSnapshotIds = grants
    .map((grant) => grant.grantSnapshotId)
    .reverse();
  input.extensions = grants;

  const plan = projectPiLaunchPlan(input);
  assert.deepEqual(
    plan.resources.map((resource) => resource.snapshotId),
    [
      "resource.skill:-a",
      "resource.skill:001",
      "resource.skill:I",
      "resource.skill:_a",
      "resource.skill:i",
    ],
  );
  assert.deepEqual(
    plan.extensions.map((extension) => extension.extensionId),
    ["extension:-a", "extension:I", "extension:_a", "extension:i"],
  );
});

test("Pi planner enforces exact SessionSpec/profile resource and grant bijections", () => {
  const missingSessionResource = validInput();
  asObject(missingSessionResource.session).agentResourceSnapshotIds = [
    "resource.skill:001",
    "resource.theme:001",
  ];
  expectCodecFailure(() => projectPiLaunchPlan(missingSessionResource));

  const profileDrift = validInput();
  asObject(profileDrift.profile).agentProfileRevisionId = "profile-revision:other";
  expectCodecFailure(() => projectPiLaunchPlan(profileDrift));

  const grantDrift = validInput();
  asObject(grantDrift.profile).extensionGrantSnapshotIds = [];
  expectCodecFailure(() => projectPiLaunchPlan(grantDrift));

  const sessionOnlyResource = validInput();
  asObject(sessionOnlyResource.profile).agentResourceSnapshotIds = [
    "resource.skill:001",
    "resource.theme:001",
  ];
  expectCodecFailure(() => projectPiLaunchPlan(sessionOnlyResource));
});

test("Pi planner rejects deferred resource-policy, source, and workspace-access discriminants", () => {
  const projectPolicy = validInput();
  asObject(asObject(projectPolicy.profile).resourcePolicy).promptTemplates = {
    mode: "pinned",
    projectResources: "snapshot-at-session-creation",
  };
  expectCodecFailure(() => projectPiLaunchPlan(projectPolicy));

  const disabledDeclarativePolicy = validInput();
  asObject(asObject(disabledDeclarativePolicy.profile).resourcePolicy).skills = {
    mode: "disabled",
  };
  expectCodecFailure(() => projectPiLaunchPlan(disabledDeclarativePolicy));

  const disabledExtensionPolicy = validInput();
  asObject(asObject(disabledExtensionPolicy.profile).resourcePolicy).extensions = {
    mode: "disabled",
  };
  expectCodecFailure(() => projectPiLaunchPlan(disabledExtensionPolicy));

  const projectSource = validInput();
  asObject((projectSource.resources as unknown[])[1]).source = {
    kind: "project-snapshot",
    workspaceRevisionId: "workspace-revision:001",
  };
  expectCodecFailure(() => projectPiLaunchPlan(projectSource));

  const readOnlyCeiling = validInput();
  asObject(readOnlyCeiling.accessCeilings).workspaceAccess = "read-only";
  expectCodecFailure(() => projectPiLaunchPlan(readOnlyCeiling));

  const readOnlyAllocation = validInput();
  asObject(asObject(readOnlyAllocation.allocation).workspace).access = "read-only";
  expectCodecFailure(() => projectPiLaunchPlan(readOnlyAllocation));
});

test("Pi planner bounds pin arrays and rejects duplicate or non-bijective extension grants", () => {
  const oversizedResourcePins = validInput();
  asObject(oversizedResourcePins.session).agentResourceSnapshotIds = Array.from(
    { length: 33 },
    (_, index) => `resource.skill:${index}`,
  );
  expectCodecFailure(() => projectPiLaunchPlan(oversizedResourcePins));

  const duplicateResourcePin = validInput();
  asObject(duplicateResourcePin.session).agentResourceSnapshotIds = [
    "resource.skill:001",
    "resource.skill:001",
  ];
  expectCodecFailure(() => projectPiLaunchPlan(duplicateResourcePin));

  const missingLoadedGrant = validInput();
  missingLoadedGrant.extensions = [];
  expectCodecFailure(() => projectPiLaunchPlan(missingLoadedGrant));

  const additionalLoadedGrant = validInput();
  const secondExtension = clone(extensionRecord(additionalLoadedGrant));
  secondExtension.grantSnapshotId = "extension-grant:002";
  secondExtension.extensionId = "extension:002";
  secondExtension.extensionRevisionId = "extension-revision:002";
  secondExtension.sandboxPath = "/hitch-resources/extension-two";
  additionalLoadedGrant.extensions = [
    ...(additionalLoadedGrant.extensions as unknown[]),
    secondExtension,
  ];
  expectCodecFailure(() => projectPiLaunchPlan(additionalLoadedGrant));
});

test("Pi planner rejects protected destination collision, shadowing, nesting, and artifact escape", () => {
  const duplicateProtected = validInput();
  asObject(asObject(duplicateProtected.allocation).state).sandboxPath = "/workspace";
  expectCodecFailure(() => projectPiLaunchPlan(duplicateProtected));

  const nestedProtected = validInput();
  asObject(asObject(nestedProtected.allocation).bridgeSocket).sandboxPath = "/hitch-runtime/bridge.sock";
  expectCodecFailure(() => projectPiLaunchPlan(nestedProtected));

  const artifactEscape = validInput();
  asObject((artifactEscape.resources as unknown[])[0]).sandboxPath = "/workspace/themed";
  expectCodecFailure(() => projectPiLaunchPlan(artifactEscape));

  const artifactShadowing = validInput();
  const resources = artifactShadowing.resources as unknown[];
  asObject(resources[1]).sandboxPath = "/hitch-resources/skill-one/child";
  asObject(resources[2]).sandboxPath = "/hitch-resources/skill-one";
  expectCodecFailure(() => projectPiLaunchPlan(artifactShadowing));

  const duplicateArtifactPath = validInput();
  asObject((duplicateArtifactPath.extensions as unknown[])[0]).sandboxPath =
    "/hitch-resources/skill-one";
  expectCodecFailure(() => projectPiLaunchPlan(duplicateArtifactPath));
});

test("Pi planner permits shared content digests but rejects duplicate extension identity drift", () => {
  const sharedDigest = projectPiLaunchPlan(validInput());
  assert.equal(
    sharedDigest.resources[0]?.integrityDigest,
    sharedDigest.extensions[0]?.revisionIntegrityDigest,
  );

  const crossKindRawIdentity = validInput();
  asObject(crossKindRawIdentity.session).extensionGrantSnapshotIds = [
    "resource.skill:001",
  ];
  asObject(crossKindRawIdentity.profile).extensionGrantSnapshotIds = [
    "resource.skill:001",
  ];
  extensionRecord(crossKindRawIdentity).grantSnapshotId = "resource.skill:001";
  assert.equal(
    projectPiLaunchPlan(crossKindRawIdentity).extensions[0]?.grantSnapshotId,
    "resource.skill:001",
  );

  const duplicateExtension = validInput();
  const session = asObject(duplicateExtension.session);
  const profile = asObject(duplicateExtension.profile);
  session.extensionGrantSnapshotIds = ["extension-grant:001", "extension-grant:002"];
  profile.extensionGrantSnapshotIds = ["extension-grant:001", "extension-grant:002"];
  duplicateExtension.extensions = [
    ...(duplicateExtension.extensions as unknown[]),
    {
      grantSnapshotId: "extension-grant:002",
      extensionId: "extension:001",
      extensionRevisionId: "extension-revision:002",
      revisionIntegrityDigest: digest("a"),
      grantIntegrityDigest: digest("d"),
      sandboxPath: "/hitch-resources/extension-two",
      loading: "explicit-pinned",
      promptLifecycle: "agent-loop-preserving",
      configurationSchema: clone(CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA),
      configuration: {},
    },
  ];
  expectCodecFailure(() => projectPiLaunchPlan(duplicateExtension));
});

test("Pi planner rejects arbitrary configuration, schema drift, and runtime authority seams", () => {
  for (const unsafe of unsafeBoundaryInputs()) {
    expectCodecFailure(() => projectPiLaunchPlan(unsafe.input), unsafe.label);
  }
});

test("Pi planner detaches and deeply freezes its plan and configuration", () => {
  const input = validInput();
  const plan = projectPiLaunchPlan(input);
  const inputExtension = asObject((input.extensions as unknown[])[0]);
  inputExtension.sandboxPath = "/hitch-resources/changed";
  asObject(inputExtension.configurationSchema).type = "array";
  asObject(inputExtension.configuration).loader = "evil";
  asObject(asObject(input.allocation).workspace).sandboxPath = "/changed-workspace";

  assert.equal(plan.extensions[0]?.sandboxPath, "/hitch-resources/extension-one");
  assert.deepEqual(
    plan.extensions[0]?.configurationSchema,
    CLOSED_EMPTY_EXTENSION_CONFIGURATION_SCHEMA,
  );
  assert.deepEqual(plan.extensions[0]?.configuration, {});
  assert.equal(plan.workingDirectory, "/workspace");
  assert.equal(isDeepFrozen(plan), true);
  assert.throws(() => {
    (plan.resources as unknown as unknown[]).push("mutation");
  }, TypeError);
});

test("Pi planner decoder returns a closed frozen semantic projection", () => {
  const decoded = decodePiLaunchPlanInput(validInput());
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.extensions[0]?.configuration ?? {}), true);
  expectCodecFailure(() =>
    decodePiLaunchPlanInput({ ...validInput(), unsupportedLoader: "evil" }),
  );
});

scenarioCase({
  scenarioId: "V2-S07",
  caseId: "pi-launch-pins-and-ceilings",
  title: "Pi projection preserves every supplied immutable pin and authorized runtime ceiling",
  run: () => {
    const plan = projectPiLaunchPlan(validInput());
    assert.deepEqual(plan.session, {
      sessionSpecId: "session-spec:001",
      agentProfileRevisionId: "profile-revision:001",
      workspaceRevisionId: "workspace-revision:001",
      agentResourceSnapshotIds: [
        "resource.skill:001",
        "resource.template:001",
        "resource.theme:001",
      ],
      extensionGrantSnapshotIds: ["extension-grant:001"],
    });
    assert.equal(plan.launchProfileId, "pi-launch-profile:001");
    assert.deepEqual(plan.accessCeilings, {
      workspaceAccess: "read-write",
      process: "deny",
      shell: "deny",
      network: "deny",
      memoryBytes: 256_000_000,
      maximumProcesses: 8,
      temporaryStorageBytes: 1_000_000,
      outputBytes: 100_000,
    });
    assert.equal(plan.protectedDestinations.workspace.resourceId, "workspace-resource:001");
    assert.equal(plan.protectedDestinations.workspace.access, "read-write");
    const widened = validInput();
    asObject(widened.accessCeilings).workspaceAccess = "read-only";
    expectCodecFailure(() => projectPiLaunchPlan(widened));
  },
});

scenarioCase({
  scenarioId: "V2-S13",
  caseId: "pi-resource-discovery-disabled",
  title: "Pi projection pairs discovery-off switches with only pinned explicit sandbox resource paths",
  run: () => {
    const plan = projectPiLaunchPlan(validInput());
    assert.deepEqual(
      plan.ambientDiscoveryArguments,
      OFFICIAL_PI_082_DISCOVERY_SWITCHES,
    );
    assert.deepEqual(
      plan.explicitPathArguments.map((argument) => [
        argument.flag,
        argument.sandboxPath,
      ]),
      [
        ["--extension", "/hitch-resources/extension-one"],
        ["--skill", "/hitch-resources/skill-one"],
        ["--prompt-template", "/hitch-resources/template-one"],
        ["--theme", "/hitch-resources/theme-one"],
      ],
    );
  },
});

scenarioCase({
  scenarioId: "V2-S14",
  caseId: "pi-launch-plan-rejects-secrets-and-authority",
  title: "Pi projection rejects every arbitrary configuration, host-path, command, and authority seam",
  run: () => {
    for (const unsafe of unsafeBoundaryInputs()) {
      expectCodecFailure(() => projectPiLaunchPlan(unsafe.input), unsafe.label);
    }
  },
});

scenarioCase({
  scenarioId: "V2-S20",
  caseId: "pi-082-reviewed-resource-flags",
  title: "Pi 0.82 projection uses the reviewed discovery and explicit resource compatibility flags",
  run: () => {
    const plan = projectPiLaunchPlan(validInput());
    assert.equal(plan.piVersion, "0.82.0");
    assert.deepEqual(
      plan.ambientDiscoveryArguments,
      [
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
      ],
    );
    assert.deepEqual(plan.explicitPathArguments.map((argument) => argument.flag), [
      "--extension",
      "--skill",
      "--prompt-template",
      "--theme",
    ]);
  },
});

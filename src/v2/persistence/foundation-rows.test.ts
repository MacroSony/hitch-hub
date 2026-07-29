import assert from "node:assert/strict";
import { test } from "node:test";

import { FIRST_SLICE_CONFIGURATION_V1 } from "../bootstrap/fixture-v1.js";
import { projectBootstrapPublication } from "../bootstrap/publication-projection.js";
import type { BootstrapPublicationRecords } from "../model/application.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  BOOTSTRAP_FOUNDATION_TABLES,
  BootstrapFoundationRowError,
  projectBootstrapFoundationRows,
} from "./foundation-rows.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import {
  HITCH_V2_SCHEMA_DIGEST,
  HITCH_V2_SCHEMA_MANIFEST,
} from "./schema.js";

function projectionInput(): Record<string, unknown> {
  const configuration = structuredClone(FIRST_SLICE_CONFIGURATION_V1);
  const resources = configuration.resources as Record<string, unknown>;
  const skills = resources.skills as Record<string, unknown>;
  (skills.snapshots as unknown[]).push({
    kind: "skill",
    snapshotId: "profile-skill-v1",
    displayName: "Profile skill",
    artifactRef: "profile-skill-bundle-v1",
    integrityDigest: `sha256:${"a".repeat(64)}`,
  });
  (skills.snapshots as unknown[]).push({
    kind: "skill",
    snapshotId: "profile-skill-v2",
    displayName: "Second profile skill",
    artifactRef: "profile-skill-bundle-v2",
    integrityDigest: `sha256:${"d".repeat(64)}`,
  });
  const extensions = resources.extensions as Record<string, unknown>;
  (extensions.grants as unknown[]).push({
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
    capabilityIds: [
      "extension-capability-v1",
      "shared-extension-capability-v1",
    ],
    promptLifecycle: "agent-loop-preserving",
    configuration: {},
  });
  (extensions.grants as unknown[]).push({
    extensionId: "profile-extension-v2",
    extensionRef: "profile-extension-v2",
    extensionRevisionId: "profile-extension-revision-v2",
    revision: 1,
    displayName: "Second profile extension",
    configurationSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    revisionArtifactRef: "profile-extension-bundle-v2",
    revisionIntegrityDigest: `sha256:${"d".repeat(64)}`,
    grantSnapshotId: "profile-extension-grant-v2",
    grantIntegrityDigest: `sha256:${"e".repeat(64)}`,
    ownerUseGrant: "required",
    capabilityIds: [
      "extension-capability-v2",
      "shared-extension-capability-v1",
    ],
    promptLifecycle: "agent-loop-preserving",
    configuration: {},
  });
  return {
    configuration,
    resolved: {
      timestamp: "2026-07-29T12:00:00.000Z",
      auditActor: { kind: "bootstrap" },
      serviceSchemaDigest: HITCH_V2_SCHEMA_DIGEST,
      sourceReferences: {
        installationRef: "hitch-v2-first-slice",
        principalRef: "bootstrap-owner-v1",
        localHostRef: "local-host-v1",
        identityBindingRef: "bootstrap-owner-local-peer-v1",
        subjectRef: "service-owner-local-peer-v1",
        subjectResolution: "service-owner-effective-uid",
        endpointRef: "local-endpoint-v1",
        workspaceBindingRef: "workspace-binding-v1",
      },
      ids: {
        installationId: "installation-v1",
        ownerId: "owner-v1",
        identityBindingId: "owner-binding-v1",
        endpointId: "endpoint-v1",
        installationRoleGrantId: "role-grant-v1",
        localHostId: "local-host-v1",
        authenticationSubjectId: "local-owner-subject-v1",
        localEndpointId: "local-endpoint-v1",
        workspaceId: "workspace-v1",
        workspaceRevisionId: "workspace-revision-v1",
        profileId: "pi-profile-v1",
        profileRevisionId: "pi-profile-revision-v1",
        executionPolicyId: "execution-policy-v1",
        executionPolicySnapshotId: "execution-policy-snapshot-v1",
        turnPolicyId: "turn-policy-v1",
        turnPolicySnapshotId: "turn-policy-snapshot-v1",
        providerConnectionId: "pi-native-openai-codex-v1",
        credentialBindingId: "openai-codex-pi-auth-v1",
        configurationUseGrantIds: {
          workspace: "grant-workspace-v1",
          profile: "grant-profile-v1",
          executionPolicy: "grant-execution-v1",
          turnPolicy: "grant-turn-v1",
          credentialBinding: "grant-credential-v1",
        },
        extensionUseGrantIds: [
          {
            extensionId: "profile-extension-v1",
            grantId: "grant-extension-v1",
          },
          {
            extensionId: "profile-extension-v2",
            grantId: "grant-extension-v2",
          },
        ],
      },
      trustedWorkspaceBinding: {
        bindingRef: "workspace-binding-v1",
        workspaceReference: "workspace-v1",
        revision: 1,
        root: {
          id: "workspace-root-v1",
          canonicalHostPath: "/srv/hitch-workspace",
          sandboxPath: "/workspace",
          maximumAccess: "read-write",
        },
        mounts: [],
      },
    },
  };
}

function records(): BootstrapPublicationRecords {
  return projectBootstrapPublication(projectionInput()).records;
}

function mutable(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function mutableArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

test("bootstrap foundation mapper covers every first-slice table deterministically", () => {
  const first = projectBootstrapFoundationRows(records());
  const second = projectBootstrapFoundationRows(
    structuredClone(records()),
  );

  assert.deepEqual(second, first);
  assert.equal(first.rows.length, 81);
  assert.deepEqual(
    new Set(first.rows.map((row) => row.table)),
    new Set(BOOTSTRAP_FOUNDATION_TABLES),
  );
  assert.equal(first.schemaDigest, HITCH_V2_SCHEMA_DIGEST);
  assert.match(first.semanticDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.rows));
  assert.ok(first.rows.every((row) => Object.isFrozen(row)));

  const installation = first.rows.find(
    (row) => row.table === "installations",
  );
  assert.ok(installation);
  const ceilingsIndex = installation.columns.indexOf("hard_ceilings_json");
  assert.ok(ceilingsIndex >= 0);
  assert.deepEqual(
    JSON.parse(String(installation.values[ceilingsIndex])),
    records().installation.hardCeilings,
  );

  const manifestTables = new Map(
    HITCH_V2_SCHEMA_MANIFEST.tables.map((table) => [
      table.name,
      new Set(table.columns.map((column) => column.name)),
    ]),
  );
  for (const row of first.rows) {
    const columns = manifestTables.get(row.table);
    assert.ok(columns);
    assert.ok(row.columns.every((column) => columns.has(column)));
    assert.equal(row.columns.length, row.values.length);
    assert.ok(row.primaryKey.every((column) => row.columns.includes(column)));
  }
});

test("bootstrap foundation digest ignores relational set ordering", () => {
  const original = records();
  const reordered = structuredClone(original);
  mutableArray(reordered.accessGrants).reverse();
  mutableArray(
    reordered.executionPolicySnapshot.resourceGrants,
  ).reverse();
  mutableArray(reordered.executionPolicySnapshot.tools).reverse();
  mutableArray(
    reordered.providerConnection.allowedUpstreamOrigins,
  ).reverse();
  const model = reordered.providerConnection.models[0]!;
  assert.equal(model.imageInput.kind, "supported");
  mutableArray(model.imageInput.acceptedMimeTypes).reverse();
  assert.equal(model.reasoning.kind, "portable-efforts");
  mutableArray(model.reasoning.supportedEfforts).reverse();
  for (const grant of reordered.extensionGrantSnapshots) {
    mutableArray(grant.capabilities).reverse();
  }

  assert.equal(
    projectBootstrapFoundationRows(reordered).semanticDigest,
    projectBootstrapFoundationRows(original).semanticDigest,
  );
});

test("bootstrap foundation rows satisfy the canonical schema and foreign keys", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const projection = projectBootstrapFoundationRows(records());
      database.transaction((transaction) => {
        for (const foundationRow of projection.rows) {
          const columns = foundationRow.columns
            .map((column) => `"${column}"`)
            .join(", ");
          const placeholders = foundationRow.columns.map(() => "?").join(", ");
          transaction.run(
            `INSERT INTO "${foundationRow.table}" (${columns}) VALUES (${placeholders})`,
            foundationRow.values,
          );
        }
      });
      const persisted = database.transaction((transaction) =>
        transaction.get(
          "SELECT COUNT(*) AS count FROM installations",
        ),
      );
      assert.equal(persisted?.count, 1);
    } finally {
      database.close();
    }
  });
});

test("bootstrap foundation mapper rejects schema, reference, artifact, and object-shape drift", () => {
  const wrongSchema = structuredClone(records());
  mutable(wrongSchema.installation.serviceSchema).schemaDigest =
    `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => projectBootstrapFoundationRows(wrongSchema),
    BootstrapFoundationRowError,
  );

  const wrongReference = structuredClone(records());
  mutable(wrongReference.referenceBindings.owner).principalId =
    "other-owner-v1";
  assert.throws(
    () => projectBootstrapFoundationRows(wrongReference),
    BootstrapFoundationRowError,
  );

  const wrongArtifact = structuredClone(records());
  mutable(
    wrongArtifact.artifactBindings.declarative[0],
  ).integrityDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => projectBootstrapFoundationRows(wrongArtifact),
    BootstrapFoundationRowError,
  );

  const duplicateAuthority = structuredClone(records());
  const workspaceGrant = duplicateAuthority.accessGrants.find(
    (grant) =>
      grant.kind === "session-configuration-use" &&
      grant.resource.kind === "workspace",
  );
  assert.ok(workspaceGrant);
  const duplicateWorkspaceGrant = structuredClone(workspaceGrant);
  mutable(duplicateWorkspaceGrant).id = "duplicate-workspace-grant-v1";
  mutableArray(duplicateAuthority.accessGrants).push(
    duplicateWorkspaceGrant,
  );
  assert.throws(
    () => projectBootstrapFoundationRows(duplicateAuthority),
    BootstrapFoundationRowError,
  );

  const duplicateArtifactReferences = structuredClone(records());
  const declarative =
    duplicateArtifactReferences.artifactBindings.declarative;
  assert.ok(declarative.length >= 2);
  mutable(declarative[1]).artifactReference =
    declarative[0]!.artifactReference;
  assert.throws(
    () => projectBootstrapFoundationRows(duplicateArtifactReferences),
    BootstrapFoundationRowError,
  );

  const duplicateExtensionArtifactReferences = structuredClone(records());
  const extensions =
    duplicateExtensionArtifactReferences.artifactBindings.extensions;
  assert.ok(extensions.length >= 2);
  mutable(extensions[1]).artifactReference =
    extensions[0]!.artifactReference;
  assert.throws(
    () =>
      projectBootstrapFoundationRows(
        duplicateExtensionArtifactReferences,
      ),
    BootstrapFoundationRowError,
  );

  const prototyped = structuredClone(records());
  mutable(prototyped).owner = Object.assign(
    Object.create({ inherited: true }),
    prototyped.owner,
  );
  assert.throws(
    () => projectBootstrapFoundationRows(prototyped),
    BootstrapFoundationRowError,
  );
});

test("bootstrap foundation mapper rejects values wider than fixed schema policy", () => {
  const mutations: Array<(candidate: BootstrapPublicationRecords) => void> = [
    (candidate) => {
      mutable(candidate.turnPolicySnapshot.admission).maxQueuedTurns = 4;
    },
    (candidate) => {
      mutable(candidate.turnPolicySnapshot.interaction).approval =
        "policy-only";
    },
    (candidate) => {
      mutable(candidate.turnPolicySnapshot.interaction).inputRequests =
        "ask-originator";
    },
    (candidate) => {
      const model = candidate.providerConnection.models[0]!;
      assert.equal(model.imageInput.kind, "supported");
      mutable(model.imageInput).maximumImagesPerRequest = 2;
    },
    (candidate) => {
      const model = candidate.providerConnection.models[0]!;
      assert.equal(model.imageInput.kind, "supported");
      mutable(model.imageInput).maximumTotalImageBytesPerRequest =
        model.imageInput.maximumImageBytesEach * 2;
    },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(records());
    mutate(candidate);
    assert.throws(
      () => projectBootstrapFoundationRows(candidate),
      BootstrapFoundationRowError,
    );
  }
});

test("bootstrap foundation mapper revalidates raw scalar and nested shapes", () => {
  const mutations: Array<(candidate: BootstrapPublicationRecords) => void> = [
    (candidate) => {
      mutable(candidate.owner).displayName = { forged: true };
    },
    (candidate) => {
      mutable(candidate.localIdentityBinding).subjectId = "unsafe subject";
    },
    (candidate) => {
      assert.equal(candidate.localEndpoint.address.kind, "local-client");
      mutable(candidate.localEndpoint.address).localEndpointId =
        "unsafe endpoint";
    },
    (candidate) => {
      const grant = candidate.accessGrants.find(
        (item) => item.kind === "session-configuration-use",
      );
      assert.ok(grant);
      assert.equal(grant.kind, "session-configuration-use");
      mutable(grant.resource).unexpected = true;
    },
    (candidate) => {
      mutable(candidate.referenceBindings.owner).unexpected = true;
    },
    (candidate) => {
      mutable(
        candidate.artifactBindings.declarative[0],
      ).unexpected = true;
    },
    (candidate) => {
      Object.setPrototypeOf(
        candidate.extensionRevisions,
        Object.create(Array.prototype),
      );
    },
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(records());
    mutate(candidate);
    assert.throws(() => projectBootstrapFoundationRows(candidate));
  }
});

test("bootstrap foundation projection detaches retained row values", () => {
  const source = structuredClone(records());
  const projection = projectBootstrapFoundationRows(source);
  mutable(source.installation.hardCeilings).maximumActiveWorkMs = 1;

  const installation = projection.rows.find(
    (row) => row.table === "installations",
  );
  assert.ok(installation);
  const ceilings = JSON.parse(
    String(
      installation.values[
        installation.columns.indexOf("hard_ceilings_json")
      ],
    ),
  ) as Record<string, unknown>;
  assert.equal(ceilings.maximumActiveWorkMs, 3_600_000);
});

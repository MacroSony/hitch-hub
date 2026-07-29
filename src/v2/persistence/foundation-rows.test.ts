import assert from "node:assert/strict";
import { test } from "node:test";

import type { BootstrapPublicationRecords } from "../model/application.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  BOOTSTRAP_FOUNDATION_PRIMARY_KEYS,
  BOOTSTRAP_FOUNDATION_TABLES,
  BootstrapFoundationRowError,
  projectBootstrapFoundationRows,
} from "./foundation-rows.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import {
  HITCH_V2_SCHEMA_DIGEST,
  HITCH_V2_SCHEMA_MANIFEST,
} from "./schema.js";

function records(): BootstrapPublicationRecords {
  return createBootstrapPublicationRecords();
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
    assert.deepEqual(
      row.primaryKey,
      BOOTSTRAP_FOUNDATION_PRIMARY_KEYS[row.table],
    );
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

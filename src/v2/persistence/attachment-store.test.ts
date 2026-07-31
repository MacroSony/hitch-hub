import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createFirstSliceAuthorizationTrust } from "../application/authorization-contexts.js";
import type { StagedPrivateImageAttachment } from "../model/external-runtime.js";
import type { Attachment } from "../model/records.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  AttachmentIntakeError,
  AttachmentStoreIntegrityError,
  createLocalImageIntakeVault,
  LocalPrivateAttachmentStore,
  type LocalImageIntakeVault,
} from "./attachment-store.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "./bootstrap-publication.js";
import type { V2Database } from "./database.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import { V2DataRootError } from "./errors.js";
import type { AuthenticationRequestId } from "../model/primitives.js";

const CLOCK_START = "2026-07-29T12:05:00.000Z";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5,
]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 6, 7]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9,
]);

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function publishAndAuthenticate(database: V2Database): Promise<{
  readonly authenticationRequestId: AuthenticationRequestId;
}> {
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(createBootstrapPublicationRecords());
  const trust = createFirstSliceAuthorizationTrust({
    database,
    clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
    ids: new DeterministicIdSource("authorization"),
  });
  const authentication = await trust.localAuthentication.authenticate(
    trust.localConnectionIssuer.issueAcceptedConnection(),
  );
  assert.equal(authentication.status, "authenticated");
  if (authentication.status !== "authenticated") {
    throw new Error("test authentication unexpectedly failed");
  }
  return Object.freeze({
    authenticationRequestId:
      authentication.context.actor.requestId as AuthenticationRequestId,
  });
}

function createStore(
  database: V2Database,
  intake: LocalImageIntakeVault,
): LocalPrivateAttachmentStore {
  return new LocalPrivateAttachmentStore({
    database,
    clock: new DeterministicClock(CLOCK_START),
    ids: new DeterministicIdSource("store"),
    intake,
  });
}

function admittedWith(
  attachment: Attachment,
): Parameters<
  LocalPrivateAttachmentStore["finalizeAdmittedImage"]
>[0]["admission"] {
  return { status: "admitted", attachment } as Parameters<
    LocalPrivateAttachmentStore["finalizeAdmittedImage"]
  >[0]["admission"];
}

function stagePaths(
  database: V2Database,
  attachment: Attachment,
): { readonly staged: string; readonly final: string } {
  const name = attachment.blob.blobId;
  return Object.freeze({
    staged: join(database.root.path, "attachments", "stage", name),
    final: join(database.root.path, "attachments", name),
  });
}

test("[V2-S12/attachment-store-staging] staging sniffs, hashes, and privately copies each supported image type", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { authenticationRequestId } =
        await publishAndAuthenticate(database);
      const intake = createLocalImageIntakeVault();
      const store = createStore(database, intake);
      const records = createBootstrapPublicationRecords();

      const cases = [
        { bytes: JPEG, mimeType: "image/jpeg" },
        { bytes: PNG, mimeType: "image/png" },
        { bytes: GIF, mimeType: "image/gif" },
        { bytes: WEBP, mimeType: "image/webp" },
      ] as const;
      let sequence = 0;
      for (const entry of cases) {
        sequence += 1;
        const upload = intake.seal({
          bytes: entry.bytes,
          authenticationRequestId,
        });
        assert.equal(upload.byteLength, entry.bytes.length);
        assert.ok(Object.isFrozen(upload));
        const staged = await store.stageBoundedImage(upload);
        assert.equal(staged.status, "staged");
        if (staged.status !== "staged") continue;
        const { attachment } = staged.stage.preparedAdmission;
        assert.deepEqual(attachment, {
          id: `store:Attachment:${String(sequence).padStart(4, "0")}`,
          installationId: records.installation.id,
          mediaType: "image",
          mimeType: entry.mimeType,
          byteLength: entry.bytes.length,
          integrityDigest: sha256(entry.bytes),
          blob: {
            storage: "installation-private",
            blobId: `store:PrivateBlob:${String(sequence).padStart(4, "0")}`,
          },
          admittedFrom: {
            kind: "local-cli",
            authenticationRequestId,
          },
          createdAt: CLOCK_START,
        });
        assert.ok(Object.isFrozen(attachment));
        assert.ok(Object.isFrozen(staged.stage));

        const paths = stagePaths(database, attachment);
        assert.equal(lstatSync(paths.staged).isFile(), true);
        assert.equal(lstatSync(paths.staged).mode & 0o777, 0o600);
        assert.equal(existsSync(paths.final), false);
        const persisted = Buffer.from(
          await import("node:fs/promises").then((fs) =>
            fs.readFile(paths.staged),
          ),
        );
        assert.deepEqual(persisted, entry.bytes);
        assert.notEqual(persisted.buffer, entry.bytes.buffer);

        assert.equal(intake.consume(upload), undefined);
      }
      assert.equal(
        lstatSync(join(database.root.path, "attachments")).mode & 0o777,
        0o700,
      );
      assert.equal(
        lstatSync(join(database.root.path, "attachments", "stage")).mode &
          0o777,
        0o700,
      );
    } finally {
      database.close();
    }
  });
});

test("staging rejects empty, oversized, and unsupported uploads", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { authenticationRequestId } =
        await publishAndAuthenticate(database);
      const intake = createLocalImageIntakeVault();
      const store = createStore(database, intake);

      assert.throws(
        () =>
          intake.seal({
            bytes: new Uint8Array(0),
            authenticationRequestId,
          }),
        AttachmentIntakeError,
      );
      assert.throws(
        () =>
          intake.seal({
            bytes: new Uint8Array(8 * 1024 * 1024 + 1),
            authenticationRequestId,
          }),
        AttachmentIntakeError,
      );
      assert.throws(
        () =>
          intake.seal({
            bytes: new Uint8Array(4),
            authenticationRequestId: "../escape" as AuthenticationRequestId,
          }),
        /AuthenticationRequest ID/u,
      );

      const unsupported = await store.stageBoundedImage(
        intake.seal({
          bytes: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
          authenticationRequestId,
        }),
      );
      assert.deepEqual(unsupported, {
        status: "rejected",
        reason: "unsupported-image-type",
      });
      const riffButNotWebp = await store.stageBoundedImage(
        intake.seal({
          bytes: Buffer.from([
            0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x41, 0x56, 0x49, 0x20,
          ]),
          authenticationRequestId,
        }),
      );
      assert.deepEqual(riffButNotWebp, {
        status: "rejected",
        reason: "unsupported-image-type",
      });
    } finally {
      database.close();
    }
  });
});

test("[V2-S12/attachment-store-finalization] finalization verifies the staged copy and promotes it exactly once", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { authenticationRequestId } =
        await publishAndAuthenticate(database);
      const intake = createLocalImageIntakeVault();
      const store = createStore(database, intake);

      const staged = await store.stageBoundedImage(
        intake.seal({ bytes: PNG, authenticationRequestId }),
      );
      assert.equal(staged.status, "staged");
      if (staged.status !== "staged") return;
      const { attachment } = staged.stage.preparedAdmission;
      const paths = stagePaths(database, attachment);

      const finalized = await store.finalizeAdmittedImage({
        stage: staged.stage,
        admission: admittedWith(attachment),
      });
      assert.deepEqual(finalized, {
        status: "finalized",
        attachmentId: attachment.id,
      });
      assert.equal(existsSync(paths.staged), false);
      assert.equal(lstatSync(paths.final).mode & 0o777, 0o600);

      const again = await store.finalizeAdmittedImage({
        stage: staged.stage,
        admission: admittedWith(attachment),
      });
      assert.deepEqual(again, { status: "already-resolved" });

      const tampered = await store.stageBoundedImage(
        intake.seal({ bytes: GIF, authenticationRequestId }),
      );
      assert.equal(tampered.status, "staged");
      if (tampered.status !== "staged") return;
      const tamperedPaths = stagePaths(
        database,
        tampered.stage.preparedAdmission.attachment,
      );
      writeFileSync(tamperedPaths.staged, JPEG, { mode: 0o600 });
      const mismatch = await store.finalizeAdmittedImage({
        stage: tampered.stage,
        admission: admittedWith(tampered.stage.preparedAdmission.attachment),
      });
      assert.deepEqual(mismatch, {
        status: "finalization-failed",
        reason: "integrity-mismatch",
      });
      assert.equal(existsSync(tamperedPaths.final), false);
    } finally {
      database.close();
    }
  });
});

test("rollback removes an unfinalized stage exactly once and finalization after rollback fails closed", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { authenticationRequestId } =
        await publishAndAuthenticate(database);
      const intake = createLocalImageIntakeVault();
      const store = createStore(database, intake);

      const staged = await store.stageBoundedImage(
        intake.seal({ bytes: WEBP, authenticationRequestId }),
      );
      assert.equal(staged.status, "staged");
      if (staged.status !== "staged") return;
      const { attachment } = staged.stage.preparedAdmission;
      const paths = stagePaths(database, attachment);

      const rolledBack = await store.rollbackUnfinalizedImage({
        stage: staged.stage,
        reason: "duplicate-turn",
      });
      assert.deepEqual(rolledBack, { status: "rolled-back" });
      assert.equal(existsSync(paths.staged), false);

      const again = await store.rollbackUnfinalizedImage({
        stage: staged.stage,
        reason: "admission-rejected",
      });
      assert.deepEqual(again, { status: "already-resolved" });

      await assert.rejects(
        store.finalizeAdmittedImage({
          stage: staged.stage,
          admission: admittedWith(attachment),
        }),
        AttachmentStoreIntegrityError,
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-S02/attachment-store-authority] the store rejects forged stages, foreign uploads, and mismatched admissions", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { authenticationRequestId } =
        await publishAndAuthenticate(database);
      const intake = createLocalImageIntakeVault();
      const store = createStore(database, intake);

      const staged = await store.stageBoundedImage(
        intake.seal({ bytes: JPEG, authenticationRequestId }),
      );
      assert.equal(staged.status, "staged");
      if (staged.status !== "staged") return;
      const { attachment } = staged.stage.preparedAdmission;

      const forgedUpload = Object.freeze({
        byteLength: 4,
      }) as Parameters<LocalPrivateAttachmentStore["stageBoundedImage"]>[0];
      await assert.rejects(
        store.stageBoundedImage(forgedUpload),
        AttachmentStoreIntegrityError,
      );
      const foreignIntake = createLocalImageIntakeVault();
      await assert.rejects(
        store.stageBoundedImage(
          foreignIntake.seal({ bytes: PNG, authenticationRequestId }),
        ),
        AttachmentStoreIntegrityError,
      );

      const forgedStage = structuredClone(
        staged.stage,
      ) as StagedPrivateImageAttachment;
      await assert.rejects(
        store.finalizeAdmittedImage({
          stage: forgedStage,
          admission: admittedWith(attachment),
        }),
        AttachmentStoreIntegrityError,
      );
      await assert.rejects(
        store.rollbackUnfinalizedImage({
          stage: forgedStage,
          reason: "application-aborted",
        }),
        AttachmentStoreIntegrityError,
      );

      const mismatched = {
        ...attachment,
        id: "store:Attachment:9999",
      } as Attachment;
      await assert.rejects(
        store.finalizeAdmittedImage({
          stage: staged.stage,
          admission: admittedWith(mismatched),
        }),
        AttachmentStoreIntegrityError,
      );
      const paths = stagePaths(database, attachment);
      assert.equal(existsSync(paths.staged), true);
    } finally {
      database.close();
    }
  });
});

test("staging fails closed when the attachment directory is unsafe", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const { authenticationRequestId } =
        await publishAndAuthenticate(database);
      const intake = createLocalImageIntakeVault();
      const store = createStore(database, intake);

      const attachments = join(database.root.path, "attachments");
      const { mkdirSync: mkdir } = await import("node:fs");
      mkdir(attachments, { mode: 0o700 });
      chmodSync(attachments, 0o755);
      await assert.rejects(
        store.stageBoundedImage(
          intake.seal({ bytes: PNG, authenticationRequestId }),
        ),
        V2DataRootError,
      );
      chmodSync(attachments, 0o700);

      const staged = await store.stageBoundedImage(
        intake.seal({ bytes: PNG, authenticationRequestId }),
      );
      assert.equal(staged.status, "staged");
    } finally {
      database.close();
    }
  });
});

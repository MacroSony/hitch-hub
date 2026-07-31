/**
 * V2-009B: connector-owned image intake, MIME sniffing, bounded private copy,
 * and stage finalization/rollback.
 *
 * The intake vault is the trusted byte channel between the local connector
 * and the store: the connector seals bounded, frame-validated bytes with
 * their authentication request, and the store consumes them exactly once.
 * The staged value never exposes a host path, a durable AttachmentId chosen
 * by the caller, or a caller-owned byte array.
 *
 * This module implements the staging/finalization/rollback subset of
 * `PrivateAttachmentStoragePort`. Orphan discovery claims and quiescence
 * recovery arrive with the startup-recovery slice; the durable
 * `private_blobs`/`attachments` rows are appended by the Turn-admission
 * transaction (V2-009C), never by file staging.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

import { decodeServiceId } from "../codecs/primitives.js";
import type {
  BoundedConnectorImageUpload,
  Clock,
  IdSource,
  PreparedAttachmentAdmission,
} from "../model/application.js";
import type {
  AttachmentFinalizationResult,
  AttachmentRollbackResult,
  AttachmentStagingResult,
  PrivateAttachmentStoragePort,
  StagedPrivateImageAttachment,
} from "../model/external-runtime.js";
import type {
  AgentImageMimeType,
  AuthenticationRequestId,
  InstallationId,
  IntegrityDigest,
} from "../model/primitives.js";
import type { Attachment } from "../model/records.js";
import type { V2Database, V2RepositoryTransaction } from "./database.js";
import { revalidateV2DataRoot } from "./root.js";

export class AttachmentStoreIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentStoreIntegrityError";
  }
}

export class AttachmentIntakeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentIntakeError";
  }
}

export const PRIVATE_IMAGE_LIMITS = Object.freeze({
  /** Matches the installation request-framing image byte ceiling. */
  maximumImageBytes: 8 * 1024 * 1024,
  blobDirectoryMode: 0o700,
  blobFileMode: 0o600,
});

const BLOB_DIRECTORY = "attachments";
const STAGE_DIRECTORY = "stage";
const SAFE_BLOB_FILENAME = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u;

/** Trusted one-shot intake channel shared by the connector and the store. */
export interface LocalImageIntakeVault {
  seal(input: {
    readonly bytes: Uint8Array;
    readonly authenticationRequestId: AuthenticationRequestId;
  }): BoundedConnectorImageUpload;
  consume(upload: BoundedConnectorImageUpload):
    | {
        readonly bytes: Uint8Array;
        readonly authenticationRequestId: AuthenticationRequestId;
      }
    | undefined;
}

/**
 * Creates the process-local intake channel. Sealed uploads are branded,
 * frozen, and consumable exactly once through the same vault; a forged,
 * cloned, or foreign upload has no entry.
 */
export function createLocalImageIntakeVault(): LocalImageIntakeVault {
  const entries = new WeakMap<
    object,
    {
      readonly bytes: Uint8Array;
      readonly authenticationRequestId: AuthenticationRequestId;
    }
  >();
  return Object.freeze({
    seal(input: {
      readonly bytes: Uint8Array;
      readonly authenticationRequestId: AuthenticationRequestId;
    }) {
      if (
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.length < 1 ||
        input.bytes.length > PRIVATE_IMAGE_LIMITS.maximumImageBytes
      ) {
        throw new AttachmentIntakeError(
          "image intake requires 1 byte up to the installation image ceiling",
        );
      }
      const authenticationRequestId = decodeServiceId(
        "AuthenticationRequest",
        input.authenticationRequestId,
      );
      const entry = Object.freeze({
        // A private copy; typed arrays with elements cannot be frozen.
        bytes: Buffer.from(input.bytes),
        authenticationRequestId,
      });
      const upload = Object.freeze({
        byteLength: entry.bytes.length,
      }) as BoundedConnectorImageUpload;
      entries.set(upload, entry);
      return upload;
    },
    consume(upload: BoundedConnectorImageUpload) {
      if (typeof upload !== "object" || upload === null) return undefined;
      const entry = entries.get(upload);
      if (entry === undefined) return undefined;
      entries.delete(upload);
      return entry;
    },
  });
}

function sniffImageMimeType(
  bytes: Uint8Array,
): AgentImageMimeType | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function sha256Digest(bytes: Uint8Array): IntegrityDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as IntegrityDigest;
}

interface FilesystemIdentity {
  readonly device: number;
  readonly inode: number;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function requireBlobDirectory(path: string): FilesystemIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new AttachmentStoreIntegrityError(
      "unable to inspect the private blob directory",
      { cause: error },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AttachmentStoreIntegrityError(
      "private blob path must be a real directory",
    );
  }
  if (
    process.platform !== "win32" &&
    stat.uid !== process.getuid?.()
  ) {
    throw new AttachmentStoreIntegrityError(
      "private blob directory must be owned by the service account",
    );
  }
  if ((stat.mode & 0o777) !== PRIVATE_IMAGE_LIMITS.blobDirectoryMode) {
    throw new AttachmentStoreIntegrityError(
      "private blob directory must have mode 700",
    );
  }
  return { device: stat.dev, inode: stat.ino };
}

function requireIdentity(
  actual: FilesystemIdentity,
  expected: FilesystemIdentity,
  subject: string,
): void {
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode
  ) {
    throw new AttachmentStoreIntegrityError(
      `${subject} was replaced after validation`,
    );
  }
}

function prepareBlobDirectories(
  database: V2Database,
): { readonly blobPath: string; readonly stagePath: string; readonly blobIdentity: FilesystemIdentity; readonly stageIdentity: FilesystemIdentity } {
  revalidateV2DataRoot(database.root);
  const blobPath = join(database.root.path, BLOB_DIRECTORY);
  const stagePath = join(blobPath, STAGE_DIRECTORY);
  for (const path of [blobPath, stagePath]) {
    try {
      mkdirSync(path, { mode: PRIVATE_IMAGE_LIMITS.blobDirectoryMode });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new AttachmentStoreIntegrityError(
          "unable to create the private blob directory",
          { cause: error },
        );
      }
    }
  }
  const blobIdentity = requireBlobDirectory(blobPath);
  const stageIdentity = requireBlobDirectory(stagePath);
  revalidateV2DataRoot(database.root);
  requireIdentity(
    requireBlobDirectory(blobPath),
    blobIdentity,
    "private blob directory",
  );
  return { blobPath, stagePath, blobIdentity, stageIdentity };
}

function blobFileName(blobId: string): string {
  if (!SAFE_BLOB_FILENAME.test(blobId) || blobId.includes("..")) {
    throw new AttachmentStoreIntegrityError(
      "private blob identifier is not a safe storage filename",
    );
  }
  return blobId;
}

function writeFileExclusive(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_IMAGE_LIMITS.blobFileMode,
  );
  try {
    writeSync(descriptor, bytes, 0, bytes.length, 0);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readFileBounded(path: string, maximumBytes: number): Buffer {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maximumBytes ||
      (stat.mode & 0o777) !== PRIVATE_IMAGE_LIMITS.blobFileMode
    ) {
      throw new AttachmentStoreIntegrityError(
        "staged private blob has an unexpected size or mode",
      );
    }
    const buffer = Buffer.alloc(stat.size);
    readSync(descriptor, buffer, 0, stat.size, 0);
    return buffer;
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export interface LocalPrivateAttachmentStoreOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly intake: LocalImageIntakeVault;
}

type AdmittedImageTurn = Parameters<
  PrivateAttachmentStoragePort["finalizeAdmittedImage"]
>[0]["admission"];

/**
 * The durable data root owns the `attachments` directory (see
 * `V2_OWNED_DIRECTORY_NAMES`); staging writes the Hitch-owned copy
 * beneath `<data-root>/attachments/stage/`; finalization verifies the copy
 * against the staged digest and atomically promotes it beside the durable
 * reference; rollback removes it. Instances accept only stages they minted.
 */
export class LocalPrivateAttachmentStore {
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #intake: LocalImageIntakeVault;
  readonly #mintedStages = new WeakSet<object>();

  constructor(options: LocalPrivateAttachmentStoreOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#intake = options.intake;
  }

  async stageBoundedImage(
    upload: BoundedConnectorImageUpload,
  ): Promise<AttachmentStagingResult> {
    const entry = this.#intake.consume(upload);
    if (entry === undefined) {
      throw new AttachmentStoreIntegrityError(
        "image upload was not sealed by this installation's intake vault or was already consumed",
      );
    }
    const { bytes, authenticationRequestId } = entry;
    if (bytes.length < 1) {
      return Object.freeze({ status: "rejected" as const, reason: "empty" as const });
    }
    if (bytes.length > PRIVATE_IMAGE_LIMITS.maximumImageBytes) {
      return Object.freeze({
        status: "rejected" as const,
        reason: "byte-limit-exceeded" as const,
      });
    }
    const mimeType = sniffImageMimeType(bytes);
    if (mimeType === undefined) {
      return Object.freeze({
        status: "rejected" as const,
        reason: "unsupported-image-type" as const,
      });
    }
    const integrityDigest = sha256Digest(bytes);
    const installationId = this.#soleInstallationId();
    const attachmentId = this.#ids.next("Attachment");
    const blobId = this.#ids.next("PrivateBlob");
    const createdAt = this.#clock.now();

    const directories = prepareBlobDirectories(this.#database);
    const stagedPath = join(directories.stagePath, blobFileName(blobId));
    try {
      writeFileExclusive(stagedPath, bytes);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new AttachmentStoreIntegrityError(
          "minted private blob stage collided with an existing stage",
          { cause: error },
        );
      }
      return Object.freeze({
        status: "rejected" as const,
        reason: "private-storage-unavailable" as const,
      });
    }
    requireIdentity(
      requireBlobDirectory(directories.stagePath),
      directories.stageIdentity,
      "private blob stage directory",
    );

    const attachment: Attachment = Object.freeze({
      id: attachmentId,
      installationId,
      mediaType: "image",
      mimeType,
      byteLength: bytes.length,
      integrityDigest,
      blob: Object.freeze({
        storage: "installation-private" as const,
        blobId,
      }),
      admittedFrom: Object.freeze({
        kind: "local-cli" as const,
        authenticationRequestId,
      }),
      createdAt,
    });
    const stage = Object.freeze({
      preparedAdmission: Object.freeze({
        attachment,
      }) as PreparedAttachmentAdmission,
    }) as StagedPrivateImageAttachment;
    this.#mintedStages.add(stage);
    return Object.freeze({
      status: "staged" as const,
      stage,
    });
  }

  async finalizeAdmittedImage(input: {
    readonly stage: StagedPrivateImageAttachment;
    readonly admission: AdmittedImageTurn;
  }): Promise<AttachmentFinalizationResult> {
    const stage = this.#requireMintedStage(input.stage);
    const attachment = this.#requireMatchingAttachment(
      stage,
      input.admission,
    );
    const blobId = attachment.blob.blobId;
    const directories = prepareBlobDirectories(this.#database);
    const stagedPath = join(directories.stagePath, blobFileName(blobId));
    const finalPath = join(directories.blobPath, blobFileName(blobId));

    let staged: Buffer;
    try {
      staged = readFileBounded(
        stagedPath,
        PRIVATE_IMAGE_LIMITS.maximumImageBytes,
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        try {
          statSync(finalPath);
          return Object.freeze({ status: "already-resolved" as const });
        } catch {
          throw new AttachmentStoreIntegrityError(
            "private blob stage resolved before its finalization",
            { cause: error },
          );
        }
      }
      if (error instanceof AttachmentStoreIntegrityError) throw error;
      return Object.freeze({
        status: "finalization-failed" as const,
        reason: "private-storage-unavailable" as const,
      });
    }
    if (
      staged.length !== attachment.byteLength ||
      sha256Digest(staged) !== attachment.integrityDigest
    ) {
      return Object.freeze({
        status: "finalization-failed" as const,
        reason: "integrity-mismatch" as const,
      });
    }
    try {
      renameSync(stagedPath, finalPath);
      fsyncDirectory(directories.blobPath);
    } catch {
      return Object.freeze({
        status: "finalization-failed" as const,
        reason: "private-storage-unavailable" as const,
      });
    }
    requireIdentity(
      requireBlobDirectory(directories.blobPath),
      directories.blobIdentity,
      "private blob directory",
    );
    return Object.freeze({
      status: "finalized" as const,
      attachmentId: attachment.id,
    });
  }

  async rollbackUnfinalizedImage(input: {
    readonly stage: StagedPrivateImageAttachment;
    readonly reason:
      | "duplicate-turn"
      | "admission-rejected"
      | "attachment-mismatch"
      | "application-aborted";
  }): Promise<AttachmentRollbackResult> {
    const stage = this.#requireMintedStage(input.stage);
    const blobId =
      stage.preparedAdmission.attachment.blob.blobId;
    const directories = prepareBlobDirectories(this.#database);
    const stagedPath = join(directories.stagePath, blobFileName(blobId));
    try {
      unlinkSync(stagedPath);
      fsyncDirectory(directories.stagePath);
      return Object.freeze({ status: "rolled-back" as const });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return Object.freeze({ status: "already-resolved" as const });
      }
      return Object.freeze({ status: "cleanup-failed" as const });
    }
  }

  #requireMintedStage(
    stage: StagedPrivateImageAttachment,
  ): StagedPrivateImageAttachment {
    if (
      typeof stage !== "object" ||
      stage === null ||
      !this.#mintedStages.has(stage)
    ) {
      throw new AttachmentStoreIntegrityError(
        "image stage was not minted by this attachment store",
      );
    }
    return stage;
  }

  #requireMatchingAttachment(
    stage: StagedPrivateImageAttachment,
    admission: AdmittedImageTurn,
  ): Attachment {
    const stagedAttachment = stage.preparedAdmission.attachment;
    const admitted = admission.attachment;
    if (
      admitted.id !== stagedAttachment.id ||
      admitted.installationId !== stagedAttachment.installationId ||
      admitted.mediaType !== stagedAttachment.mediaType ||
      admitted.mimeType !== stagedAttachment.mimeType ||
      admitted.byteLength !== stagedAttachment.byteLength ||
      admitted.integrityDigest !== stagedAttachment.integrityDigest ||
      admitted.blob.storage !== stagedAttachment.blob.storage ||
      admitted.blob.blobId !== stagedAttachment.blob.blobId ||
      admitted.admittedFrom.kind !== stagedAttachment.admittedFrom.kind ||
      admitted.admittedFrom.authenticationRequestId !==
        stagedAttachment.admittedFrom.authenticationRequestId ||
      admitted.createdAt !== stagedAttachment.createdAt
    ) {
      throw new AttachmentStoreIntegrityError(
        "admitted Turn does not carry the exact staged Attachment",
      );
    }
    return stagedAttachment;
  }

  #soleInstallationId(): InstallationId {
    return this.#database.transaction(
      (transaction: V2RepositoryTransaction) => {
        const rows = transaction.all("SELECT id FROM installations", []);
        if (rows.length !== 1) {
          throw new AttachmentStoreIntegrityError(
            "attachment staging requires exactly one published installation",
          );
        }
        return decodeServiceId("Installation", rows[0]!.id);
      },
    );
  }
}

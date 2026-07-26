import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import {
  V2DataRootError,
  V2InstallationMarkerError,
  V2UnknownDataRootContentsError,
} from "./errors.js";

export const V2_DATABASE_FILENAME = "hitch.sqlite";
export const V2_INSTALLATION_MARKER_FILENAME = ".hitch-v2-installation";
/** Reserved direct children. Their owning components validate their contents. */
export const V2_OWNED_DIRECTORY_NAMES = ["attachments", "run"] as const;
const INSTALLATION_MARKER = "hitch-v2-installation-root-v1\n";
const INSTALLATION_MARKER_BYTES = Buffer.from(INSTALLATION_MARKER, "utf8");
const INSPECTION_DIRECTORY_PREFIX = ".hitch-v2-database-inspection-";
const INSPECTION_OWNER_FILENAME = ".hitch-v2-inspection-owner";
const INSPECTION_OWNER_VERSION = "hitch-v2-database-inspection-v1";
const SQLITE_AUXILIARY_FILENAMES = new Set([
  `${V2_DATABASE_FILENAME}-wal`,
  `${V2_DATABASE_FILENAME}-shm`,
  `${V2_DATABASE_FILENAME}-journal`,
]);

export interface PreparedV2DataRoot {
  readonly path: string;
  readonly databasePath: string;
  readonly newlyCreated: boolean;
  readonly databaseExisted: boolean;
  /** Identity snapshots let the caller reject a path replaced after validation. */
  readonly parentDevice: number;
  readonly parentInode: number;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly databaseDevice?: number;
  readonly databaseInode?: number;
}

export interface V2DatabaseInspectionSnapshot {
  readonly directoryPath: string;
  readonly databasePath: string;
  readonly ownerMarker: string;
}

function failUnsafe(message: string): never {
  throw new V2DataRootError(message);
}

function currentUserOwns(stat: Stats, subject: string): void {
  if (process.platform !== "win32" && stat.uid !== process.getuid?.()) {
    failUnsafe(`${subject} must be owned by the current user`);
  }
}

function requireExactMode(stat: Stats, expected: number, subject: string): void {
  if ((stat.mode & 0o777) !== expected) {
    failUnsafe(`${subject} must have mode ${expected.toString(8)}`);
  }
}

function requireRegularPrivateChild(path: string, subject: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    failUnsafe(`${subject} must be a regular file, never a symlink`);
  }
  currentUserOwns(stat, subject);
  requireExactMode(stat, 0o600, subject);
  if (process.platform !== "win32" && stat.nlink !== 1) {
    failUnsafe(`${subject} must not have hard links`);
  }
}

function requireOwnedDirectory(path: string, subject: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    failUnsafe(`${subject} must be a real directory, never a symlink`);
  }
  currentUserOwns(stat, subject);
  requireExactMode(stat, 0o700, subject);
}

function requireSafeParent(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    failUnsafe("v2 data-root parent must be a real directory");
  }
  currentUserOwns(stat, "v2 data-root parent");
  if ((stat.mode & 0o022) !== 0) {
    failUnsafe("v2 data-root parent must not be writable by group or world");
  }
}

function cleanupNewRootIfExact(rootPath: string): void {
  try {
    requireOwnedDirectory(rootPath, "new v2 data root");
    const entries = readdirSync(rootPath);
    if (entries.length === 0) {
      rmdirSync(rootPath);
      return;
    }
    if (entries.length !== 1 || entries[0] !== V2_INSTALLATION_MARKER_FILENAME) return;
    const markerPath = join(rootPath, V2_INSTALLATION_MARKER_FILENAME);
    requireExactInstallationMarker(markerPath, "new v2 installation marker");
    unlinkSync(markerPath);
    rmdirSync(rootPath);
  } catch {
    // A changed or uncertain root must remain for manual inspection.
  }
}

function requireExactInstallationMarker(path: string, subject: string): void {
  requireRegularPrivateChild(path, subject);
  if (lstatSync(path).size !== INSTALLATION_MARKER_BYTES.byteLength) {
    throw new V2InstallationMarkerError(`${subject} has an unexpected byte length`);
  }
  if (!readFileSync(path).equals(INSTALLATION_MARKER_BYTES)) {
    throw new V2InstallationMarkerError("v2 installation marker does not match this implementation");
  }
}

/**
 * Validates one explicitly configured v2 root. It never resolves a path from
 * cwd, home, environment, or a caller-provided SQLite filename.
 */
export function prepareV2DataRoot(configuredRoot: string): PreparedV2DataRoot {
  return inspectOrCreateV2DataRoot(configuredRoot, true);
}

/** Validates an existing root only; it never creates missing replacement state. */
export function inspectExistingV2DataRoot(configuredRoot: string): PreparedV2DataRoot {
  return inspectOrCreateV2DataRoot(configuredRoot, false);
}

function inspectOrCreateV2DataRoot(configuredRoot: string, allowCreate: boolean): PreparedV2DataRoot {
  if (process.platform === "win32") {
    failUnsafe("v2 persistence is intentionally unsupported on Windows until equivalent ownership and mode guarantees exist");
  }
  if (!isAbsolute(configuredRoot) || configuredRoot !== normalize(configuredRoot)) {
    failUnsafe("v2 data root must be an explicitly configured normalized absolute path");
  }
  const name = basename(configuredRoot);
  if (name === "." || name === ".." || configuredRoot === dirname(configuredRoot)) {
    failUnsafe("v2 data root must name a direct child of an existing parent directory");
  }

  const configuredParent = dirname(configuredRoot);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(configuredParent);
  } catch (error) {
    throw new V2DataRootError("v2 data-root parent must already exist", { cause: error });
  }
  if (canonicalParent !== configuredParent) {
    failUnsafe("v2 data-root parent must not contain symlinked or noncanonical components");
  }
  requireSafeParent(configuredParent);
  const parentStat = lstatSync(configuredParent);
  const rootPath = join(configuredParent, name);

  let newlyCreated = false;
  try {
    const rootStat = lstatSync(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      failUnsafe("v2 data root must be a real directory, never a symlink");
    }
    currentUserOwns(rootStat, "v2 data root");
    requireExactMode(rootStat, 0o700, "v2 data root");
    if (realpathSync(rootPath) !== rootPath) {
      failUnsafe("v2 data root canonical path changed during validation");
    }
  } catch (error) {
    if (error instanceof V2DataRootError) {
      throw error;
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" && allowCreate) {
      try {
        mkdirSync(rootPath, { mode: 0o700 });
      } catch (creationError) {
        throw new V2DataRootError("unable to create the configured v2 data root", { cause: creationError });
      }
      newlyCreated = true;
    } else if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new V2DataRootError("configured v2 data root no longer exists", { cause: error });
    } else {
      throw new V2DataRootError("unable to inspect configured v2 data root", { cause: error });
    }
  }

  // Recheck after mkdir: never proceed if another actor replaced the root.
  requireOwnedDirectory(rootPath, "v2 data root");
  if (realpathSync(rootPath) !== rootPath) {
    failUnsafe("v2 data root canonical path changed during creation");
  }

  const markerPath = join(rootPath, V2_INSTALLATION_MARKER_FILENAME);
  if (newlyCreated) {
    try {
      writeFileSync(markerPath, INSTALLATION_MARKER, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      cleanupNewRootIfExact(rootPath);
      throw new V2InstallationMarkerError("unable to create the v2 installation marker", { cause: error });
    }
  }
  try {
    requireExactInstallationMarker(markerPath, "v2 installation marker");
  } catch (error) {
    if (newlyCreated) cleanupNewRootIfExact(rootPath);
    if (error instanceof V2DataRootError) {
      throw error;
    }
    throw new V2InstallationMarkerError("v2 data root is missing its installation marker", { cause: error });
  }

  const databasePath = join(rootPath, V2_DATABASE_FILENAME);
  const allowed = new Set([
    V2_INSTALLATION_MARKER_FILENAME,
    V2_DATABASE_FILENAME,
    ...SQLITE_AUXILIARY_FILENAMES,
    ...V2_OWNED_DIRECTORY_NAMES,
  ]);
  let rootEntries = readdirSync(rootPath);
  if (allowCreate) {
    recoverOrphanedInspectionSnapshots(rootPath, rootEntries);
    rootEntries = readdirSync(rootPath);
  }
  for (const entry of rootEntries) {
    if (entry.startsWith(INSPECTION_DIRECTORY_PREFIX)) {
      validateInspectionSnapshotDirectory(join(rootPath, entry));
      continue;
    }
    if (!allowed.has(entry)) {
      throw new V2UnknownDataRootContentsError(`v2 data root contains unknown entry: ${entry}`);
    }
    if ((V2_OWNED_DIRECTORY_NAMES as readonly string[]).includes(entry)) {
      requireOwnedDirectory(join(rootPath, entry), `v2 owned directory ${entry}`);
    } else if (entry !== V2_INSTALLATION_MARKER_FILENAME) {
      requireRegularPrivateChild(join(rootPath, entry), `v2 data-root entry ${entry}`);
    }
  }
  const databaseExisted = rootEntries.includes(V2_DATABASE_FILENAME);
  if (!databaseExisted && rootEntries.some((entry) => SQLITE_AUXILIARY_FILENAMES.has(entry))) {
    throw new V2UnknownDataRootContentsError("v2 data root contains SQLite auxiliary state without hitch.sqlite");
  }
  let databaseStat: Stats | undefined;
  if (databaseExisted) {
    requireRegularPrivateChild(databasePath, "v2 SQLite database");
    databaseStat = lstatSync(databasePath);
  }
  const finalParentStat = lstatSync(configuredParent);
  requireSafeParent(configuredParent);
  if (finalParentStat.dev !== parentStat.dev || finalParentStat.ino !== parentStat.ino) {
    failUnsafe("v2 data-root parent changed during validation");
  }
  const finalRootStat = lstatSync(rootPath);
  return {
    path: rootPath,
    databasePath,
    newlyCreated,
    databaseExisted,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    rootDevice: finalRootStat.dev,
    rootInode: finalRootStat.ino,
    ...(databaseStat === undefined ? {} : {
      databaseDevice: databaseStat.dev,
      databaseInode: databaseStat.ino,
    }),
  };
}

/**
 * Revalidates an already-prepared root before a live connection is used. Node
 * lacks dirfd/openat primitives, so a same-UID attacker can still race any
 * pathname operation; this detects replacement before the next boundary.
 */
export function revalidateV2DataRoot(prepared: PreparedV2DataRoot): void {
  const verified = inspectExistingV2DataRoot(prepared.path);
  if (
    verified.parentDevice !== prepared.parentDevice ||
    verified.parentInode !== prepared.parentInode ||
    verified.rootDevice !== prepared.rootDevice ||
    verified.rootInode !== prepared.rootInode ||
    verified.databaseDevice !== prepared.databaseDevice ||
    verified.databaseInode !== prepared.databaseInode
  ) {
    failUnsafe("v2 data root or its parent was replaced after validation");
  }
}

/**
 * Reserves a new private SQLite file before SQLite opens it. `wx` makes an
 * unexpected pre-existing file a refusal rather than something this process
 * opens or repairs.
 */
export function createNewV2DatabaseFile(databasePath: string): void {
  try {
    writeFileSync(databasePath, Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
    requireRegularPrivateChild(databasePath, "v2 SQLite database");
  } catch (error) {
    if (error instanceof V2DataRootError) {
      throw error;
    }
    throw new V2DataRootError("unable to reserve a new private v2 SQLite database file", {
      cause: error,
    });
  }
}

/**
 * Creates a managed inspection namespace inside the installation root. A
 * process crash may leave it behind, so the exact owner marker is recovered by
 * the next initial root preparation rather than becoming an unmanaged copy.
 */
export function createV2DatabaseInspectionSnapshot(
  prepared: PreparedV2DataRoot,
): V2DatabaseInspectionSnapshot {
  revalidateV2DataRoot(prepared);
  const directoryPath = mkdtempSync(
    join(prepared.path, INSPECTION_DIRECTORY_PREFIX),
  );
  try {
    chmodSync(directoryPath, 0o700);
    requireOwnedDirectory(directoryPath, "v2 database inspection directory");
    const ownerMarker = formatInspectionOwnerMarker();
    writeFileSync(join(directoryPath, INSPECTION_OWNER_FILENAME), ownerMarker, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    requireExactInspectionOwnerMarker(
      join(directoryPath, INSPECTION_OWNER_FILENAME),
      ownerMarker,
    );
    return Object.freeze({
      directoryPath,
      databasePath: join(directoryPath, V2_DATABASE_FILENAME),
      ownerMarker,
    });
  } catch (error) {
    try {
      if (readdirSync(directoryPath).length === 0) rmdirSync(directoryPath);
    } catch {
      // Leave uncertain state for the exact startup recovery path.
    }
    throw new V2DataRootError(
      "unable to create managed v2 database inspection snapshot",
      { cause: error },
    );
  }
}

/** Removes only the exact managed snapshot returned by the creator above. */
export function removeV2DatabaseInspectionSnapshot(
  prepared: PreparedV2DataRoot,
  snapshot: V2DatabaseInspectionSnapshot,
): void {
  if (
    dirname(snapshot.directoryPath) !== prepared.path ||
    !basename(snapshot.directoryPath).startsWith(
      INSPECTION_DIRECTORY_PREFIX,
    ) ||
    snapshot.databasePath !==
      join(snapshot.directoryPath, V2_DATABASE_FILENAME)
  ) {
    failUnsafe("refusing to remove an unrecognized database inspection path");
  }
  cleanupInspectionSnapshotDirectory(
    snapshot.directoryPath,
    snapshot.ownerMarker,
  );
}

function recoverOrphanedInspectionSnapshots(
  rootPath: string,
  rootEntries: readonly string[],
): void {
  for (const entry of rootEntries) {
    if (!entry.startsWith(INSPECTION_DIRECTORY_PREFIX)) continue;
    const directoryPath = join(rootPath, entry);
    requireOwnedDirectory(directoryPath, "v2 database inspection directory");
    const entries = readdirSync(directoryPath);
    if (entries.length === 0) {
      rmdirSync(directoryPath);
      continue;
    }
    const ownerMarker = readInspectionOwnerMarker(directoryPath);
    if (inspectionOwnerIsActive(ownerMarker)) continue;
    cleanupInspectionSnapshotDirectory(directoryPath, ownerMarker.raw);
  }
}

function validateInspectionSnapshotDirectory(directoryPath: string): void {
  requireOwnedDirectory(directoryPath, "v2 database inspection directory");
  const entries = readdirSync(directoryPath);
  if (entries.length === 0) {
    throw new V2UnknownDataRootContentsError(
      "v2 database inspection directory is missing its owner marker",
    );
  }
  readInspectionOwnerMarker(directoryPath);
  const allowed = new Set([
    INSPECTION_OWNER_FILENAME,
    V2_DATABASE_FILENAME,
    `${V2_DATABASE_FILENAME}-wal`,
    `${V2_DATABASE_FILENAME}-shm`,
    `${V2_DATABASE_FILENAME}-journal`,
  ]);
  for (const entry of entries) {
    if (!allowed.has(entry)) {
      throw new V2UnknownDataRootContentsError(
        `v2 database inspection directory contains unknown entry: ${entry}`,
      );
    }
    requireRegularPrivateChild(
      join(directoryPath, entry),
      `v2 database inspection entry ${entry}`,
    );
  }
}

function cleanupInspectionSnapshotDirectory(
  directoryPath: string,
  expectedOwnerMarker: string,
): void {
  validateInspectionSnapshotDirectory(directoryPath);
  requireExactInspectionOwnerMarker(
    join(directoryPath, INSPECTION_OWNER_FILENAME),
    expectedOwnerMarker,
  );
  for (const entry of readdirSync(directoryPath)) {
    if (entry === INSPECTION_OWNER_FILENAME) continue;
    unlinkSync(join(directoryPath, entry));
  }
  unlinkSync(join(directoryPath, INSPECTION_OWNER_FILENAME));
  rmdirSync(directoryPath);
}

function formatInspectionOwnerMarker(): string {
  const identity = readProcessIdentity(process.pid);
  const start = identity?.start ?? "unavailable";
  return `${INSPECTION_OWNER_VERSION}\npid=${process.pid}\nstart=${start}\n`;
}

function requireExactInspectionOwnerMarker(
  markerPath: string,
  expected: string,
): void {
  requireRegularPrivateChild(markerPath, "v2 database inspection owner marker");
  const stat = lstatSync(markerPath);
  if (stat.size !== Buffer.byteLength(expected, "utf8")) {
    throw new V2UnknownDataRootContentsError(
      "v2 database inspection owner marker has an unexpected byte length",
    );
  }
  if (readFileSync(markerPath, "utf8") !== expected) {
    throw new V2UnknownDataRootContentsError(
      "v2 database inspection owner marker changed",
    );
  }
}

function readInspectionOwnerMarker(directoryPath: string): {
  readonly raw: string;
  readonly pid: number;
  readonly start: string;
} {
  const markerPath = join(directoryPath, INSPECTION_OWNER_FILENAME);
  requireRegularPrivateChild(markerPath, "v2 database inspection owner marker");
  const stat = lstatSync(markerPath);
  if (stat.size > 256) {
    throw new V2UnknownDataRootContentsError(
      "v2 database inspection owner marker is oversized",
    );
  }
  const raw = readFileSync(markerPath, "utf8");
  const match =
    /^hitch-v2-database-inspection-v1\npid=([1-9][0-9]*)\nstart=([A-Za-z0-9]+)\n$/u.exec(
      raw,
    );
  if (match === null) {
    throw new V2UnknownDataRootContentsError(
      "v2 database inspection owner marker is invalid",
    );
  }
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new V2UnknownDataRootContentsError(
      "v2 database inspection owner PID is invalid",
    );
  }
  return { raw, pid, start: match[2]! };
}

function inspectionOwnerIsActive(owner: {
  readonly pid: number;
  readonly start: string;
}): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
  const identity = readProcessIdentity(owner.pid);
  if (identity === undefined || owner.start === "unavailable") return true;
  return (
    identity.start === owner.start &&
    identity.state !== "Z" &&
    identity.state !== "X"
  );
}

function readProcessIdentity(
  pid: number,
): { readonly state: string; readonly start: string } | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const state = fields[0];
    const start = fields[19];
    if (
      state === undefined ||
      start === undefined ||
      !/^[A-Z]$/u.test(state) ||
      !/^[0-9]+$/u.test(start)
    ) {
      return undefined;
    }
    return { state, start };
  } catch {
    return undefined;
  }
}

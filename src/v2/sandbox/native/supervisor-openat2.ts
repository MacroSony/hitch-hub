import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  constants,
} from "node:fs";
export type Sha256Digest = `sha256:${string}`;

export interface SupervisorOpenat2Build {
  readonly compilerPath: string;
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly nodeIncludePath: string;
}

export interface SupervisorOpenat2Artifact {
  readonly sourceDigest: Sha256Digest;
  readonly artifactDigest: Sha256Digest;
  readonly outputPath: string;
}

export interface SecureBubblewrapLauncherBuild {
  readonly compilerPath: string;
  readonly sourcePath: string;
  readonly outputPath: string;
}

interface NativeOpenResult {
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly linkCount: bigint;
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly size: bigint;
  readonly ancestorIdentities: readonly string[];
}

interface NativeSealedExecutableResult {
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly size: bigint;
}

interface NativeModule {
  openSource(path: string, kind: "file" | "directory"): NativeOpenResult;
  sealExecutable(fd: number): NativeSealedExecutableResult;
}

function digest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestFd(fd: number, size: bigint): Sha256Digest {
  if (size < 0n || size > 16n * 1024n * 1024n) {
    throw new Error("reviewed artifact is outside the 16 MiB bound");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (BigInt(position) < size) {
    const remaining = Number(size - BigInt(position));
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), position);
    if (count <= 0) throw new Error("reviewed artifact changed while hashing");
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return `sha256:${hash.digest("hex")}`;
}

async function compile(
  executable: string,
  arguments_: readonly string[],
  failure: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => reject(new Error(`${failure} failed to start`)));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(failure));
    });
  });
}

export async function compileSupervisorOpenat2Addon(
  build: SupervisorOpenat2Build,
): Promise<SupervisorOpenat2Artifact> {
  await compile(
    build.compilerPath,
    [
      "-std=c11",
      "-shared",
      "-fPIC",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      `-I${build.nodeIncludePath}`,
      build.sourcePath,
      "-o",
      build.outputPath,
    ],
    "native supervisor addon compilation failed",
  );
  chmodSync(build.outputPath, 0o555);
  return Object.freeze({
    sourceDigest: digest(readFileSync(build.sourcePath)),
    artifactDigest: digest(readFileSync(build.outputPath)),
    outputPath: build.outputPath,
  });
}

export async function compileSecureBubblewrapLauncher(
  build: SecureBubblewrapLauncherBuild,
): Promise<SupervisorOpenat2Artifact> {
  await compile(
    build.compilerPath,
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      build.sourcePath,
      "-o",
      build.outputPath,
      "-lcrypto",
    ],
    "secure Bubblewrap launcher compilation failed",
  );
  chmodSync(build.outputPath, 0o555);
  return Object.freeze({
    sourceDigest: digest(readFileSync(build.sourcePath)),
    artifactDigest: digest(readFileSync(build.outputPath)),
    outputPath: build.outputPath,
  });
}

const verifiedSources = new WeakSet<object>();
const sourceStates = new WeakMap<object, SourceState>();
const sourceBrand: unique symbol = Symbol("verifiedSandboxSource");

interface SourceState {
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly linkCount: bigint;
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly size: bigint;
  readonly kind: "file" | "directory";
  readonly sourcePath: string;
  readonly ancestorIdentities: readonly string[];
  readonly reviewedDigest: Sha256Digest | undefined;
  readonly native: NativeModule;
  closed: boolean;
}

export interface VerifiedSandboxSource {
  readonly [sourceBrand]: true;
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly linkCount: bigint;
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly size: bigint;
  readonly kind: "file" | "directory";
  readonly sourcePath: string;
  readonly ancestorIdentities: readonly string[];
  readonly reviewedDigest: Sha256Digest | undefined;
  readonly isClosed: boolean;
  close(): void;
}

class VerifiedSandboxSourceEvidence implements VerifiedSandboxSource {
  constructor(state: SourceState) {
    verifiedSources.add(this);
    sourceStates.set(this, state);
    Object.freeze(this);
  }

  close(): void {
    const state = sourceStates.get(this);
    if (state === undefined || state.closed) return;
    closeSync(state.fd);
    state.closed = true;
  }

  get [sourceBrand](): true { return true; }
  get fd(): number { return sourceStates.get(this)!.fd; }
  get device(): bigint { return sourceStates.get(this)!.device; }
  get inode(): bigint { return sourceStates.get(this)!.inode; }
  get mode(): number { return sourceStates.get(this)!.mode; }
  get linkCount(): bigint { return sourceStates.get(this)!.linkCount; }
  get ownerUid(): number { return sourceStates.get(this)!.ownerUid; }
  get ownerGid(): number { return sourceStates.get(this)!.ownerGid; }
  get size(): bigint { return sourceStates.get(this)!.size; }
  get kind(): "file" | "directory" { return sourceStates.get(this)!.kind; }
  get sourcePath(): string { return sourceStates.get(this)!.sourcePath; }
  get ancestorIdentities(): readonly string[] {
    return sourceStates.get(this)!.ancestorIdentities;
  }
  get reviewedDigest(): Sha256Digest | undefined {
    return sourceStates.get(this)!.reviewedDigest;
  }
  get isClosed(): boolean {
    return sourceStates.get(this)?.closed ?? true;
  }
}
Object.freeze(VerifiedSandboxSourceEvidence.prototype);

function validNativeResult(result: NativeOpenResult): boolean {
  return (
    Number.isSafeInteger(result.fd) &&
    result.fd >= 0 &&
    typeof result.device === "bigint" &&
    typeof result.inode === "bigint" &&
    Number.isSafeInteger(result.mode) &&
    typeof result.linkCount === "bigint" &&
    Number.isSafeInteger(result.ownerUid) &&
    Number.isSafeInteger(result.ownerGid) &&
    typeof result.size === "bigint" &&
    Array.isArray(result.ancestorIdentities) &&
    result.ancestorIdentities.every((value) => /^\d+:\d+$/.test(value))
  );
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    throw new Error("reviewed artifacts require a Linux effective uid");
  }
  return uid;
}

function createEvidence(
  native: NativeModule,
  path: string,
  kind: "file" | "directory",
  expectedDigest?: Sha256Digest,
): VerifiedSandboxSource {
  const result = native.openSource(path, kind);
  if (!validNativeResult(result)) {
    if (Number.isSafeInteger(result.fd) && result.fd >= 0) closeSync(result.fd);
    throw new Error("supervisor openat2 addon returned invalid evidence");
  }
  try {
    if (expectedDigest !== undefined) {
      if (
        kind !== "file" ||
        result.linkCount !== 1n ||
        result.ownerUid !== currentUid() ||
        (result.mode & 0o222) !== 0
      ) {
        throw new Error("reviewed artifact is not single-link and read-only owner evidence");
      }
      if (digestFd(result.fd, result.size) !== expectedDigest) {
        throw new Error("reviewed artifact digest mismatch");
      }
    }
    return new VerifiedSandboxSourceEvidence({
      fd: result.fd,
      device: result.device,
      inode: result.inode,
      mode: result.mode,
      linkCount: result.linkCount,
      ownerUid: result.ownerUid,
      ownerGid: result.ownerGid,
      size: result.size,
      kind,
      sourcePath: path,
      ancestorIdentities: Object.freeze([...result.ancestorIdentities]),
      reviewedDigest: expectedDigest,
      native,
      closed: false,
    });
  } catch (error) {
    closeSync(result.fd);
    throw error;
  }
}

export interface SupervisorSourceOpener {
  openDirectory(path: string): VerifiedSandboxSource;
  openReviewedFile(path: string, expectedDigest: Sha256Digest): VerifiedSandboxSource;
}

export function loadSupervisorSourceOpener(input: {
  readonly artifactPath: string;
  readonly expectedArtifactDigest: Sha256Digest;
}): SupervisorSourceOpener {
  if (!input.artifactPath.startsWith("/") || input.artifactPath.includes("\0")) {
    throw new Error("supervisor openat2 artifact path is invalid");
  }
  const artifactFd = openSync(
    input.artifactPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let native: NativeModule;
  try {
    const stat = fstatSync(artifactFd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(currentUid()) ||
      (stat.mode & 0o222n) !== 0n ||
      digestFd(artifactFd, stat.size) !== input.expectedArtifactDigest
    ) {
      throw new Error("supervisor openat2 artifact identity or digest mismatch");
    }
    const loaded: { exports: unknown } = { exports: {} };
    process.dlopen(loaded, `/proc/self/fd/${artifactFd}`);
    native = loaded.exports as NativeModule;
  } finally {
    closeSync(artifactFd);
  }
  return Object.freeze({
    openDirectory(path: string): VerifiedSandboxSource {
      return createEvidence(native, path, "directory");
    },
    openReviewedFile(path: string, expectedDigest: Sha256Digest): VerifiedSandboxSource {
      return createEvidence(native, path, "file", expectedDigest);
    },
  });
}

export function assertLiveVerifiedSandboxSource(
  value: unknown,
): asserts value is VerifiedSandboxSource {
  if (
    typeof value !== "object" ||
    value === null ||
    !verifiedSources.has(value) ||
    (value as VerifiedSandboxSource).isClosed
  ) {
    throw new Error("sandbox source is not live sealed evidence");
  }
  const source = value as VerifiedSandboxSource;
  const state = sourceStates.get(source);
  if (state === undefined || state.closed) {
    throw new Error("sandbox source state is unavailable");
  }
  const stat = fstatSync(state.fd, { bigint: true });
  if (
    stat.dev !== state.device ||
    stat.ino !== state.inode ||
    stat.mode !== BigInt(state.mode) ||
    stat.nlink !== state.linkCount ||
    stat.uid !== BigInt(state.ownerUid) ||
    stat.gid !== BigInt(state.ownerGid) ||
    stat.size !== state.size
  ) {
    throw new Error("sandbox source identity changed after verification");
  }
  if (
    state.reviewedDigest !== undefined &&
    digestFd(state.fd, state.size) !== state.reviewedDigest
  ) {
    throw new Error("reviewed artifact changed after verification");
  }
}

const sealedExecutables = new WeakSet<object>();
const sealedExecutableStates = new WeakMap<object, SealedExecutableState>();
const sealedExecutableBrand: unique symbol = Symbol("verifiedSealedExecutable");

interface SealedExecutableState {
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: number;
  readonly size: bigint;
  closed: boolean;
}

export interface VerifiedSealedExecutable {
  readonly [sealedExecutableBrand]: true;
  readonly fd: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly isClosed: boolean;
  close(): void;
}

class SealedExecutableEvidence implements VerifiedSealedExecutable {
  constructor(state: SealedExecutableState) {
    sealedExecutables.add(this);
    sealedExecutableStates.set(this, state);
    Object.freeze(this);
  }

  get [sealedExecutableBrand](): true { return true; }
  get fd(): number { return sealedExecutableStates.get(this)!.fd; }
  get device(): bigint { return sealedExecutableStates.get(this)!.device; }
  get inode(): bigint { return sealedExecutableStates.get(this)!.inode; }
  get isClosed(): boolean { return sealedExecutableStates.get(this)?.closed ?? true; }

  close(): void {
    const state = sealedExecutableStates.get(this);
    if (state === undefined || state.closed) return;
    closeSync(state.fd);
    state.closed = true;
  }
}
Object.freeze(SealedExecutableEvidence.prototype);

export function sealVerifiedExecutable(
  source: VerifiedSandboxSource,
): VerifiedSealedExecutable {
  assertLiveVerifiedSandboxSource(source);
  const state = sourceStates.get(source)!;
  if (state.reviewedDigest === undefined || (state.mode & 0o111) === 0) {
    throw new Error("sealed executable source is not reviewed executable evidence");
  }
  const result = state.native.sealExecutable(state.fd);
  if (
    !Number.isSafeInteger(result.fd) ||
    result.fd < 0 ||
    typeof result.device !== "bigint" ||
    typeof result.inode !== "bigint" ||
    !Number.isSafeInteger(result.mode) ||
    typeof result.size !== "bigint"
  ) {
    if (Number.isSafeInteger(result.fd) && result.fd >= 0) closeSync(result.fd);
    throw new Error("native executable sealing returned invalid evidence");
  }
  try {
    const stat = fstatSync(result.fd, { bigint: true });
    if (
      stat.dev !== result.device ||
      stat.ino !== result.inode ||
      stat.mode !== BigInt(result.mode) ||
      stat.size !== result.size ||
      (result.mode & 0o222) !== 0 ||
      (result.mode & 0o111) === 0 ||
      digestFd(result.fd, result.size) !== state.reviewedDigest
    ) {
      throw new Error("sealed executable does not match reviewed bytes");
    }
    return new SealedExecutableEvidence({
      fd: result.fd,
      device: result.device,
      inode: result.inode,
      mode: result.mode,
      size: result.size,
      closed: false,
    });
  } catch (error) {
    closeSync(result.fd);
    throw error;
  }
}

export function assertProcessExecutableMatches(
  executable: VerifiedSealedExecutable,
  processId: number,
): void {
  if (
    typeof executable !== "object" ||
    executable === null ||
    !sealedExecutables.has(executable)
  ) {
    throw new Error("sealed launcher executable is not verified evidence");
  }
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("launcher process identifier is invalid");
  }
  const state = sealedExecutableStates.get(executable)!;
  if (state.closed) throw new Error("sealed launcher executable is closed");
  const executableFd = openSync(
    `/proc/${processId}/exe`,
    constants.O_RDONLY,
  );
  try {
    const executable = fstatSync(executableFd, { bigint: true });
    if (executable.dev !== state.device || executable.ino !== state.inode) {
      throw new Error("running launcher executable does not match reviewed evidence");
    }
  } finally {
    closeSync(executableFd);
  }
}

const verifiedLaunchers = new WeakSet<object>();
const launcherBrand: unique symbol = Symbol("verifiedSecureBubblewrapLauncher");

export interface VerifiedSecureBubblewrapLauncher {
  readonly [launcherBrand]: true;
  readonly source: VerifiedSandboxSource;
}

class SecureBubblewrapLauncherEvidence implements VerifiedSecureBubblewrapLauncher {
  readonly [launcherBrand] = true as const;

  constructor(readonly source: VerifiedSandboxSource) {
    verifiedLaunchers.add(this);
    Object.freeze(this);
  }
}

export function loadSecureBubblewrapLauncher(input: {
  readonly opener: SupervisorSourceOpener;
  readonly artifactPath: string;
  readonly expectedArtifactDigest: Sha256Digest;
}): VerifiedSecureBubblewrapLauncher {
  const source = input.opener.openReviewedFile(
    input.artifactPath,
    input.expectedArtifactDigest,
  );
  if ((source.mode & 0o111) === 0) {
    source.close();
    throw new Error("secure Bubblewrap launcher is not executable");
  }
  return new SecureBubblewrapLauncherEvidence(source);
}

export function assertLiveVerifiedSecureBubblewrapLauncher(
  value: unknown,
): asserts value is VerifiedSecureBubblewrapLauncher {
  if (typeof value !== "object" || value === null || !verifiedLaunchers.has(value)) {
    throw new Error("secure Bubblewrap launcher is not sealed evidence");
  }
  assertLiveVerifiedSandboxSource(
    (value as VerifiedSecureBubblewrapLauncher).source,
  );
}

import { createHash, randomBytes } from "node:crypto";

import {
  assertLiveVerifiedSandboxSource,
  assertLiveVerifiedSecureBubblewrapLauncher,
  type VerifiedSandboxSource,
  type VerifiedSecureBubblewrapLauncher,
} from "./native/supervisor-openat2.js";

export interface EphemeralWorkerIdentity {
  readonly installationId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly workerLeaseId: string;
  readonly workerFencingToken: number;
  readonly containerGeneration: number;
}

export interface EffectiveWorkerLimits {
  readonly wallTimeMilliseconds: number;
  readonly memoryBytes: number;
  readonly maximumProcesses: number;
  readonly temporaryStorageBytes: number;
  readonly outputBytes: number;
}

export interface VerifiedSandboxMount {
  readonly source: VerifiedSandboxSource;
  readonly sandboxPath: string;
  readonly access: "read-only" | "read-write";
  readonly purpose:
    | "workspace"
    | "runtime"
    | "workspace-tools-extension"
    | "workspace-tools-addon";
}

export interface BubblewrapPlanInput {
  readonly identity: EphemeralWorkerIdentity;
  readonly limits: EffectiveWorkerLimits;
  readonly mounts: readonly VerifiedSandboxMount[];
  readonly executableSandboxPath: string;
  readonly arguments: readonly string[];
  readonly secureLauncher: VerifiedSecureBubblewrapLauncher;
}

export interface RenderedEphemeralWorkerCommand {
  readonly unitName: string;
  readonly command: "/usr/bin/systemd-run";
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface ConsumedEphemeralWorkerCommand {
  readonly unitName: string;
  readonly command: "/usr/bin/systemd-run";
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly heldSources: readonly VerifiedSandboxSource[];
  readonly sensitiveMountFrame: Uint8Array;
  readonly expectedHandoffPrefix: string;
  readonly expectedUnitDescription: string;
  readonly launcherSource: VerifiedSandboxSource;
  readonly limits: EffectiveWorkerLimits;
}

interface SealedPlanData extends ConsumedEphemeralWorkerCommand {
  readonly launcher: VerifiedSecureBubblewrapLauncher;
}

const sealedPlans = new WeakMap<object, SealedPlanData>();
const consumedPlans = new WeakSet<object>();

const FIXED_ARTIFACT_DESTINATIONS = Object.freeze({
  "workspace-tools-extension": "/hitch-runtime/workspace-tools.mjs",
  "workspace-tools-addon": "/hitch-runtime/workspace-tools.node",
});

const IDENTITY_KEYS = Object.freeze([
  "installationId",
  "principalId",
  "sessionId",
  "turnId",
  "attemptId",
  "workerLeaseId",
  "workerFencingToken",
  "containerGeneration",
] as const);

function positive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function strictSandboxPath(value: string): void {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((part) => part === "." || part === "..") ||
    value.includes("\0")
  ) {
    throw new Error("sandbox path is not strict absolute syntax");
  }
}

function canonicalIdentity(identity: EphemeralWorkerIdentity): readonly unknown[] {
  if (
    typeof identity !== "object" ||
    identity === null ||
    Object.getPrototypeOf(identity) !== Object.prototype ||
    Object.keys(identity).sort().join("\0") !== [...IDENTITY_KEYS].sort().join("\0")
  ) {
    throw new Error("worker identity must contain the exact canonical fields");
  }
  const strings = [
    identity.installationId,
    identity.principalId,
    identity.sessionId,
    identity.turnId,
    identity.attemptId,
    identity.workerLeaseId,
  ];
  if (
    strings.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 256 ||
        value.includes("\0"),
    )
  ) {
    throw new Error("worker identity contains an invalid string field");
  }
  positive(identity.workerFencingToken, "workerFencingToken");
  positive(identity.containerGeneration, "containerGeneration");
  return Object.freeze([
    ...strings,
    identity.workerFencingToken,
    identity.containerGeneration,
  ]);
}

function identityUnitName(identity: EphemeralWorkerIdentity): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalIdentity(identity)))
    .digest("hex");
  return `hitch-v2-worker-${digest.slice(0, 32)}.scope`;
}

function sourceIdentity(source: VerifiedSandboxSource): string {
  return `${source.device}:${source.inode}`;
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
  );
}

function sourcesOverlap(
  left: VerifiedSandboxSource,
  right: VerifiedSandboxSource,
): boolean {
  const leftIdentity = sourceIdentity(left);
  const rightIdentity = sourceIdentity(right);
  return (
    leftIdentity === rightIdentity ||
    left.ancestorIdentities.includes(rightIdentity) ||
    right.ancestorIdentities.includes(leftIdentity)
  );
}

function verifyMounts(
  mounts: readonly VerifiedSandboxMount[],
  launcher: VerifiedSecureBubblewrapLauncher,
): void {
  if (mounts.length < 4 || mounts.length > 16) {
    throw new Error("sandbox mount count is outside the fixed MVP bound");
  }
  assertLiveVerifiedSecureBubblewrapLauncher(launcher);
  const destinations: string[] = [];
  const sources: VerifiedSandboxSource[] = [launcher.source];
  const purposes = new Map<string, number>();
  for (const mount of mounts) {
    assertLiveVerifiedSandboxSource(mount.source);
    strictSandboxPath(mount.sandboxPath);
    if (destinations.some((destination) => pathsOverlap(destination, mount.sandboxPath))) {
      throw new Error("sandbox mount destinations overlap");
    }
    destinations.push(mount.sandboxPath);
    if (sources.some((source) => sourcesOverlap(source, mount.source))) {
      throw new Error("sandbox mount source overlaps protected authority");
    }
    sources.push(mount.source);
    purposes.set(mount.purpose, (purposes.get(mount.purpose) ?? 0) + 1);

    if (mount.purpose === "workspace") {
      if (
        mount.sandboxPath !== "/workspace" ||
        mount.access !== "read-write" ||
        mount.source.kind !== "directory" ||
        mount.source.reviewedDigest !== undefined
      ) {
        throw new Error("workspace mount is not the exact writable directory");
      }
    } else if (mount.purpose === "runtime") {
      if (
        mount.access !== "read-only" ||
        mount.source.kind !== "directory" ||
        mount.source.reviewedDigest !== undefined ||
        !["/usr", "/etc/ssl"].includes(mount.sandboxPath)
      ) {
        throw new Error("runtime mount is outside the reviewed read-only set");
      }
    } else if (
      mount.sandboxPath !== FIXED_ARTIFACT_DESTINATIONS[mount.purpose] ||
      mount.access !== "read-only" ||
      mount.source.kind !== "file" ||
      mount.source.reviewedDigest === undefined ||
      mount.source.linkCount !== 1n ||
      (mount.source.mode & 0o222) !== 0
    ) {
      throw new Error("workspace-tool artifact mount is not immutable reviewed evidence");
    }
  }
  if (
    purposes.get("workspace") !== 1 ||
    purposes.get("workspace-tools-extension") !== 1 ||
    purposes.get("workspace-tools-addon") !== 1 ||
    (purposes.get("runtime") ?? 0) < 1
  ) {
    throw new Error("sandbox mount purposes are incomplete or duplicated");
  }
}

function frameForMounts(
  nonce: string,
  mounts: readonly VerifiedSandboxMount[],
): Uint8Array {
  const lines = mounts.map((mount) => {
    const source = mount.source;
    const encodedPath = Buffer.from(source.sourcePath, "utf8").toString("hex");
    const directory = source.kind === "directory" ? 1 : 0;
    const sealed = source.reviewedDigest === undefined ? 0 : 1;
    const expectedDigest = source.reviewedDigest?.slice("sha256:".length) ?? "-";
    return [
      source.device,
      source.inode,
      source.mode,
      source.linkCount,
      source.ownerUid,
      source.ownerGid,
      source.size,
      directory,
      sealed,
      expectedDigest,
      encodedPath,
    ].join(" ");
  });
  const payload = Buffer.from(`${nonce} ${mounts.length}\n${lines.join("\n")}\n`, "utf8");
  if (payload.length > 131_072) throw new Error("secure mount frame is too large");
  const header = Buffer.allocUnsafe(12);
  header.write("HITCHB1\n", 0, "ascii");
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

export function renderEphemeralWorkerCommand(
  input: BubblewrapPlanInput,
): RenderedEphemeralWorkerCommand {
  canonicalIdentity(input.identity);
  positive(input.limits.wallTimeMilliseconds, "wallTimeMilliseconds");
  positive(input.limits.memoryBytes, "memoryBytes");
  positive(input.limits.maximumProcesses, "maximumProcesses");
  positive(input.limits.temporaryStorageBytes, "temporaryStorageBytes");
  positive(input.limits.outputBytes, "outputBytes");
  if (input.limits.outputBytes > 16 * 1024 * 1024) {
    throw new Error("outputBytes exceeds the fixed 16 MiB supervisor bound");
  }
  strictSandboxPath(input.executableSandboxPath);
  if (
    !input.executableSandboxPath.startsWith("/usr/") &&
    !input.executableSandboxPath.startsWith("/hitch-runtime/")
  ) {
    throw new Error("worker executable is outside reviewed runtime destinations");
  }
  if (input.arguments.length > 128 || input.arguments.some((arg) => arg.includes("\0"))) {
    throw new Error("worker argument vector is outside the fixed bound");
  }
  verifyMounts(input.mounts, input.secureLauncher);

  const bwrap = [
    "/usr/bin/bwrap",
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--disable-userns",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--unshare-net",
    "--hostname",
    "hitch-worker",
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/bin:/bin",
    "--setenv",
    "HOME",
    "/tmp",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(input.limits.temporaryStorageBytes),
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--dir",
    "/workspace",
    "--dir",
    "/hitch-runtime",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
  ];
  input.mounts.forEach((mount, index) => {
    if (mount.source.reviewedDigest !== undefined) {
      bwrap.push(
        "--perms",
        "0444",
        "--ro-bind-data",
        String(100 + index),
        mount.sandboxPath,
      );
    } else {
      bwrap.push(
        mount.access === "read-only" ? "--ro-bind-fd" : "--bind-fd",
        String(100 + index),
        mount.sandboxPath,
      );
    }
  });
  bwrap.push(
    "--remount-ro",
    "/proc",
    "--remount-ro",
    "/dev",
    "--remount-ro",
    "/",
    "--chdir",
    "/workspace",
    "--",
    input.executableSandboxPath,
    ...input.arguments,
  );

  const unitName = identityUnitName(input.identity);
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    throw new Error("worker supervisor requires a Linux effective uid");
  }
  const runtimeDirectory = `/run/user/${uid}`;
  const nonce = randomBytes(32).toString("hex");
  const expectedUnitDescription = `Hitch V2 worker ${nonce}`;
  const arguments_ = Object.freeze([
    "--user",
    "--scope",
    "--quiet",
    `--unit=${unitName.slice(0, -".scope".length)}`,
    `--description=${expectedUnitDescription}`,
    "--property=CollectMode=inactive-or-failed",
    "--property=KillMode=control-group",
    "--property=MemoryAccounting=yes",
    `--property=MemoryMax=${input.limits.memoryBytes}`,
    "--property=MemorySwapMax=0",
    "--property=TasksAccounting=yes",
    `--property=TasksMax=${input.limits.maximumProcesses}`,
    `--property=RuntimeMaxSec=${input.limits.wallTimeMilliseconds}ms`,
    "--",
    "/proc/self/fd/2",
    ...bwrap,
  ]);
  const environment = Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    XDG_RUNTIME_DIR: runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
  });
  const publicPlan = Object.freeze({
    unitName,
    command: "/usr/bin/systemd-run" as const,
    arguments: arguments_,
    environment,
  });
  const heldSources = Object.freeze([
    input.secureLauncher.source,
    ...input.mounts.map((mount) => mount.source),
  ]);
  sealedPlans.set(
    publicPlan,
    Object.freeze({
      ...publicPlan,
      heldSources,
      sensitiveMountFrame: frameForMounts(nonce, input.mounts),
      expectedHandoffPrefix: `HITCH_BWRAP_HANDOFF_V1 ${nonce} `,
      expectedUnitDescription,
      launcherSource: input.secureLauncher.source,
      limits: Object.freeze({ ...input.limits }),
      launcher: input.secureLauncher,
    }),
  );
  return publicPlan;
}

export function consumeRenderedEphemeralWorkerCommand(
  plan: RenderedEphemeralWorkerCommand,
): ConsumedEphemeralWorkerCommand {
  const sealed = sealedPlans.get(plan);
  if (sealed === undefined || consumedPlans.has(plan)) {
    throw new Error("ephemeral launch plan is not fresh sealed evidence");
  }
  consumedPlans.add(plan);
  try {
    if (sealed.command !== "/usr/bin/systemd-run") {
      throw new Error("ephemeral launch command is not the fixed supervisor");
    }
    assertLiveVerifiedSecureBubblewrapLauncher(sealed.launcher);
    for (const source of sealed.heldSources) assertLiveVerifiedSandboxSource(source);
  } catch (error) {
    for (const source of sealed.heldSources) source.close();
    throw error;
  }
  return Object.freeze({
    unitName: sealed.unitName,
    command: sealed.command,
    arguments: sealed.arguments,
    environment: sealed.environment,
    heldSources: sealed.heldSources,
    sensitiveMountFrame: Buffer.from(sealed.sensitiveMountFrame),
    expectedHandoffPrefix: sealed.expectedHandoffPrefix,
    expectedUnitDescription: sealed.expectedUnitDescription,
    launcherSource: sealed.launcherSource,
    limits: sealed.limits,
  });
}

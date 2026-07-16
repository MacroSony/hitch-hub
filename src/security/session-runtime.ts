import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isPathInsideAllowedRoots } from "../core/path-policy.js";
import {
  executionPolicySchema,
  mountPlanSchema,
  type ExecutionPolicy,
  type PlannedMount,
  type SessionSecurityMetadata,
} from "./policy.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type SessionBridgePaths = {
  bridgePath: string;
  outboxPath: string;
  resultDir: string;
};

export class SessionRuntimeStore {
  readonly dataDir: string;
  readonly stateRoot: string;
  private migratedLegacyToolStateCount = 0;

  constructor(dataDir: string) {
    const resolvedDataDir = path.resolve(dataDir);
    mkdirSync(resolvedDataDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    this.dataDir = realpathSync.native(resolvedDataDir);
    chmodSync(this.dataDir, PRIVATE_DIRECTORY_MODE);
    this.stateRoot = ensurePrivateDirectory(path.join(this.dataDir, "session-state"));
  }

  migrateLegacySharedPiState(
    principalIds: readonly string[],
    configScope: "hitch" | "system",
    assignedPrincipalId?: string,
  ): number {
    if (configScope !== "hitch") {
      return 0;
    }
    const legacyPiRoot = path.join(this.dataDir, "pi");
    if (!existsSync(legacyPiRoot)) {
      return 0;
    }
    assertPrivateDirectory(legacyPiRoot, "Legacy Pi state root");
    const entries = readdirSync(legacyPiRoot);
    const unknownEntries = entries.filter((entry) => entry !== "agent" && entry !== "sessions");
    if (unknownEntries.length > 0) {
      throw new Error(
        `Legacy Hitch Pi state contains unknown entries (${unknownEntries.join(", ")}); move or back up ${legacyPiRoot} before starting.`,
      );
    }
    const sources = ["agent", "sessions"].filter((entry) => existsSync(path.join(legacyPiRoot, entry)));
    if (sources.length === 0) {
      return 0;
    }
    if (!assignedPrincipalId) {
      throw new Error(
        `Legacy shared Hitch Pi state at ${legacyPiRoot} needs an explicit owner. Back it up, then set agents.pi.legacy_state_principal to one configured principal before starting.`,
      );
    }
    if (!principalIds.includes(assignedPrincipalId)) {
      throw new Error(`Legacy Hitch Pi state principal is not configured: ${assignedPrincipalId}`);
    }

    const sharedPiRoot = this.sharedPiRoot(assignedPrincipalId);
    let migrated = 0;
    for (const entry of sources) {
      const source = path.join(legacyPiRoot, entry);
      assertPrivateDirectory(source, `Legacy Pi ${entry} directory`);
      hardenPrivateTree(source);
      const destination = path.join(sharedPiRoot, entry);
      if (existsSync(destination)) {
        throw new Error(
          `Both legacy and principal-scoped Pi state exist for ${entry}; resolve ${source} and ${destination} before starting.`,
        );
      }
      renameSync(source, destination);
      assertPrivateDirectory(destination, `Migrated Pi ${entry} directory`);
      migrated += 1;
    }
    return migrated;
  }

  materialize(
    principalId: string,
    sessionId: string,
    workspacePath: string,
    policy: ExecutionPolicy,
    allowedRoots: readonly string[],
  ): SessionSecurityMetadata {
    const canonicalWorkspace = canonicalExistingPath(workspacePath, "Session workspace");
    if (!statSync(canonicalWorkspace).isDirectory()) {
      throw new Error(`Session workspace is not a directory: ${workspacePath}`);
    }
    if (!isPathInsideAllowedRoots(canonicalWorkspace, allowedRoots)) {
      throw new Error(`Session workspace is outside the principal's allowed roots: ${workspacePath}`);
    }

    const principalState = this.principalStateRoot(principalId);
    const sessionsRoot = ensurePrivateDirectory(path.join(principalState, "sessions"));
    const statePath = ensurePrivateDirectory(path.join(sessionsRoot, stableSegment(sessionId)));
    const workerStatePath = ensurePrivateDirectory(path.join(statePath, "worker"));
    const bridge = this.materializeBridgeState(sessionId, statePath);
    const sharedPiRoot = this.sharedPiRoot(principalId);
    const piAgentPath = ensurePrivateDirectory(path.join(sharedPiRoot, "agent"));
    const piSessionsPath = ensurePrivateDirectory(path.join(sharedPiRoot, "sessions"));
    const normalizedPolicy = normalizeExecutionPolicy(policy, allowedRoots);
    const mounts: PlannedMount[] = [
      {
        hostPath: workerStatePath,
        sandboxPath: "/state",
        mode: "rw",
        purpose: "state",
      },
      {
        hostPath: bridge.bridgePath,
        sandboxPath: "/hitch",
        mode: "rw",
        purpose: "state",
      },
      {
        hostPath: bridge.resultDir,
        sandboxPath: "/hitch/results",
        mode: "ro",
        purpose: "state",
      },
      {
        hostPath: piAgentPath,
        sandboxPath: "/agent-config",
        mode: "rw",
        purpose: "agent-config",
      },
      {
        hostPath: piSessionsPath,
        sandboxPath: "/agent-sessions",
        mode: "rw",
        purpose: "state",
      },
    ];
    if (normalizedPolicy.filesystem !== "none") {
      mounts.push({
        hostPath: canonicalWorkspace,
        sandboxPath: "/workspace",
        mode: normalizedPolicy.filesystem === "read-only" ? "ro" : "rw",
        purpose: "workspace",
      });
    }
    mounts.push(
      ...normalizedPolicy.mounts.map((mount) => ({
        hostPath: mount.host_path,
        sandboxPath: mount.sandbox_path,
        mode: mount.mode,
        purpose: "policy" as const,
      })),
    );

    const mountPlan = mountPlanSchema.parse({
      version: 1,
      principalId,
      sessionId,
      workspacePath: canonicalWorkspace,
      statePath,
      mounts,
    });
    return { statePath, executionPolicy: normalizedPolicy, mountPlan };
  }

  migratedLegacyToolStates(): number {
    return this.migratedLegacyToolStateCount;
  }

  private principalStateRoot(principalId: string): string {
    const principalsRoot = ensurePrivateDirectory(path.join(this.stateRoot, "principals"));
    return ensurePrivateDirectory(path.join(principalsRoot, stableSegment(principalId)));
  }

  private sharedPiRoot(principalId: string): string {
    const principalState = this.principalStateRoot(principalId);
    const sharedRoot = ensurePrivateDirectory(path.join(principalState, "shared"));
    return ensurePrivateDirectory(path.join(sharedRoot, "pi"));
  }

  private materializeBridgeState(sessionId: string, statePath: string): SessionBridgePaths {
    const bridgePath = path.join(statePath, "bridge");
    const legacyToolPath = path.join(this.dataDir, "tools", sessionId);
    if (existsSync(legacyToolPath)) {
      assertLegacyToolDirectory(this.dataDir, legacyToolPath);
      if (existsSync(bridgePath)) {
        throw new Error(
          `Both legacy and private tool state exist for session ${sessionId}; resolve ${legacyToolPath} and ${bridgePath} before starting.`,
        );
      }
      renameSync(legacyToolPath, bridgePath);
      this.migratedLegacyToolStateCount += 1;
    }
    ensurePrivateDirectory(bridgePath);
    ensurePrivateDirectory(path.join(bridgePath, "results"));
    return secureSessionBridgePaths(statePath);
  }
}

export function secureSessionBridgePaths(statePath: string): SessionBridgePaths {
  const canonicalState = assertPrivateDirectory(statePath, "Session state directory");
  const bridgePath = assertPrivateDirectory(path.join(canonicalState, "bridge"), "Session bridge directory");
  const resultDir = assertPrivateDirectory(path.join(bridgePath, "results"), "Session bridge result directory");
  return { bridgePath, outboxPath: path.join(bridgePath, "outbox.jsonl"), resultDir };
}

export function secureMountHostPath(
  metadata: Pick<SessionSecurityMetadata, "mountPlan">,
  sandboxPath: string,
): string {
  const mount = metadata.mountPlan.mounts.find((candidate) => candidate.sandboxPath === sandboxPath);
  if (!mount) {
    throw new Error(`Session mount plan is missing ${sandboxPath}.`);
  }
  return assertPrivateDirectory(mount.hostPath, `Session mount ${sandboxPath}`);
}

function normalizeExecutionPolicy(
  policy: ExecutionPolicy,
  allowedRoots: readonly string[],
): ExecutionPolicy {
  const mounts = policy.mounts.map((mount) => {
    if (isReservedSandboxPath(mount.sandbox_path)) {
      throw new Error(`Policy mount overlaps Hitch's reserved sandbox paths: ${mount.sandbox_path}`);
    }
    const canonicalHostPath = canonicalExistingPath(mount.host_path, "Policy mount host path");
    if (!isPathInsideAllowedRoots(canonicalHostPath, allowedRoots)) {
      throw new Error(`Policy mount is outside the principal's allowed roots: ${mount.host_path}`);
    }
    return { ...mount, host_path: canonicalHostPath };
  });
  return executionPolicySchema.parse({ ...policy, mounts });
}

function isReservedSandboxPath(candidate: string): boolean {
  return ["/agent-config", "/agent-sessions", "/hitch", "/state", "/workspace"].some(
    (reserved) => candidate === reserved || candidate.startsWith(`${reserved}/`),
  );
}

function canonicalExistingPath(candidate: string, label: string): string {
  try {
    return realpathSync.native(path.resolve(candidate));
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved: ${candidate}`);
  }
}

function ensurePrivateDirectory(directoryPath: string): string {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { mode: PRIVATE_DIRECTORY_MODE });
  }
  return assertPrivateDirectory(directoryPath, "Private session-state directory");
}

function assertPrivateDirectory(directoryPath: string, label: string): string {
  const stat = lstatSync(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directoryPath}`);
  }
  const canonical = realpathSync.native(directoryPath);
  if (normalizeForCompare(canonical) !== normalizeForCompare(directoryPath)) {
    throw new Error(`${label} unexpectedly retargeted: ${directoryPath}`);
  }
  chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
  return canonical;
}

function assertLegacyToolDirectory(dataDir: string, legacyToolPath: string): void {
  const legacyRoot = path.join(dataDir, "tools");
  assertPrivateDirectory(legacyRoot, "Legacy tool-state root");
  const canonical = assertPrivateDirectory(legacyToolPath, "Legacy session tool-state directory");
  if (!isPathInsideAllowedRoots(canonical, [legacyRoot])) {
    throw new Error(`Legacy session tool state escaped its root: ${legacyToolPath}`);
  }
  hardenPrivateTree(canonical);
}

function hardenPrivateTree(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Legacy state contains a symbolic link and cannot be migrated safely: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        chmodSync(entryPath, PRIVATE_DIRECTORY_MODE);
        pending.push(entryPath);
      } else if (stat.isFile()) {
        chmodSync(entryPath, PRIVATE_FILE_MODE);
      } else {
        throw new Error(`Legacy state contains an unsupported filesystem entry: ${entryPath}`);
      }
    }
  }
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stableSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

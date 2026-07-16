import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInsideAllowedRoots } from "../core/path-policy.js";
import {
  type LaunchRequest,
  type LauncherProbe,
  type LaunchSpec,
  type SandboxLauncher,
  spawnLaunchSpec,
} from "./launcher.js";

const CAPABILITIES: LauncherProbe["capabilities"] = [
  "mount_namespace",
  "pid_namespace",
  "ipc_namespace",
  "uts_namespace",
  "user_namespace",
  "tmpfs",
  "cleared_environment",
  "network_namespace",
];

const BASE_RUNTIME_DIRECTORIES = ["/usr", "/bin", "/lib"];
const OPTIONAL_RUNTIME_DIRECTORIES = ["/lib64", "/etc/ssl", "/etc/ca-certificates"];
const OPTIONAL_RUNTIME_FILES = [
  "/etc/hosts",
  "/etc/ld.so.cache",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/resolv.conf",
];
const RESERVED_SANDBOX_ROOTS = ["/bin", "/dev", "/etc", "/lib", "/lib64", "/proc", "/run", "/tmp", "/usr"];

export class BubblewrapLauncher implements SandboxLauncher {
  readonly kind = "bubblewrap" as const;

  constructor(private readonly binary = "/usr/bin/bwrap") {}

  async probe(): Promise<LauncherProbe> {
    if (process.platform !== "linux") {
      return {
        kind: this.kind,
        available: false,
        capabilities: [],
        reason: "Bubblewrap sandboxing is supported only on Linux.",
      };
    }
    try {
      accessSync(this.binary, constants.X_OK);
    } catch {
      return {
        kind: this.kind,
        available: false,
        capabilities: [],
        reason: `Bubblewrap executable is unavailable: ${this.binary}`,
      };
    }

    const probeSpec: LaunchSpec = {
      command: this.binary,
      args: [
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--disable-userns",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--",
        "/bin/true",
      ],
      env: {},
    };
    const child = spawnLaunchSpec(probeSpec);
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const outcome = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("exit", (code) => resolve({ code }));
    });
    if (outcome.error || outcome.code !== 0) {
      const detail = outcome.error?.message ?? Buffer.concat(stderr).toString("utf8").trim();
      return {
        kind: this.kind,
        available: false,
        capabilities: [],
        reason: `Bubblewrap namespace probe failed${detail ? `: ${detail}` : "."}`,
      };
    }
    return { kind: this.kind, available: true, capabilities: [...CAPABILITIES] };
  }

  buildSpec(request: LaunchRequest): LaunchSpec {
    assertBubblewrapPolicy(request);
    const executable = resolveExecutable(request.command, request.cwd, request.env);
    const runtimeRoots = runtimeRootsForExecutable(executable, request);
    const args = [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--disable-userns",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--hostname",
      "hitch-worker",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
    ];
    if (request.executionPolicy.agent_network === "deny") {
      args.push("--unshare-net");
    }

    const readOnlyRuntime = uniqueExistingPaths([
      ...BASE_RUNTIME_DIRECTORIES,
      ...OPTIONAL_RUNTIME_DIRECTORIES,
      ...OPTIONAL_RUNTIME_FILES,
      ...runtimeRoots,
    ]);
    const sandboxExecutable = sandboxPathForExecutable(executable, readOnlyRuntime, request);
    addScaffolding(args, readOnlyRuntime);
    for (const hostPath of readOnlyRuntime) {
      args.push("--ro-bind", hostPath, hostPath);
    }

    const orderedMounts = [...request.mountPlan.mounts].sort(
      (left, right) => depth(left.sandboxPath) - depth(right.sandboxPath),
    );
    for (const mount of orderedMounts) {
      assertCanonicalMount(mount.hostPath);
      assertMountDoesNotReplaceRuntime(mount.sandboxPath, readOnlyRuntime);
      addScaffolding(args, [mount.sandboxPath]);
      args.push(mount.mode === "ro" ? "--ro-bind" : "--bind", mount.hostPath, mount.sandboxPath);
    }
    args.push(
      "--chdir",
      request.executionPolicy.filesystem === "none" ? "/state" : "/workspace",
      "--",
      sandboxExecutable,
      ...request.args,
    );
    return { command: this.binary, args, env: { ...request.env } };
  }

  launch(request: LaunchRequest) {
    return spawnLaunchSpec(this.buildSpec(request));
  }
}

function assertBubblewrapPolicy(request: LaunchRequest): void {
  const policy = request.executionPolicy;
  if (policy.sandbox === "disabled" || policy.filesystem === "host-unrestricted") {
    throw new Error("BubblewrapLauncher requires a sandboxed filesystem policy.");
  }
  if (Object.keys(policy.limits).length > 0) {
    throw new Error("Configured resource limits are not enforceable by the current BubblewrapLauncher.");
  }
  if (request.mountPlan.workspacePath !== request.cwd) {
    throw new Error("Bubblewrap launch cwd does not match the persisted mount plan.");
  }
  assertAgentPolicyEnforcement(request);
  assertMountPlanMatchesPolicy(request);
  const workspaceMount = request.mountPlan.mounts.find((mount) => mount.sandboxPath === "/workspace");
  if (policy.filesystem === "none" && workspaceMount) {
    throw new Error("Filesystem-none policy unexpectedly contains a workspace mount.");
  }
  if (policy.filesystem !== "none" && !workspaceMount) {
    throw new Error("Sandboxed filesystem policy is missing its workspace mount.");
  }
  if (
    workspaceMount &&
    workspaceMount.mode !== (policy.filesystem === "read-only" ? "ro" : "rw")
  ) {
    throw new Error("Workspace mount mode does not match the sandboxed filesystem policy.");
  }
  const requiredMounts = new Map([
    ["/state", "rw"],
    ["/hitch", "rw"],
    ["/hitch/results", "ro"],
    ["/agent-config", "rw"],
    ["/agent-sessions", "rw"],
  ]);
  const seen = new Set<string>();
  for (const mount of request.mountPlan.mounts) {
    if (seen.has(mount.sandboxPath)) {
      throw new Error(`Duplicate sandbox mount target: ${mount.sandboxPath}`);
    }
    seen.add(mount.sandboxPath);
  }
  for (const [sandboxPath, mode] of requiredMounts) {
    if (!request.mountPlan.mounts.some((mount) => mount.sandboxPath === sandboxPath && mount.mode === mode)) {
      throw new Error(`Sandbox mount plan is missing required ${mode} mount: ${sandboxPath}`);
    }
  }
  const bridgeIndex = request.mountPlan.mounts.findIndex((mount) => mount.sandboxPath === "/hitch");
  const resultIndex = request.mountPlan.mounts.findIndex((mount) => mount.sandboxPath === "/hitch/results");
  if (resultIndex <= bridgeIndex) {
    throw new Error("Read-only tool results must overlay the writable bridge mount.");
  }
}

function resolveExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const candidates = path.isAbsolute(command)
    ? [command]
    : command.includes(path.sep)
      ? [path.resolve(cwd, command)]
      : (env.PATH ?? "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((entry) => path.join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const stat = lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) {
        return path.resolve(candidate);
      }
    } catch {
      // Try the next PATH candidate.
    }
  }
  throw new Error(`Sandbox command is not an executable file: ${command}`);
}

function runtimeRootsForExecutable(executable: string, request: LaunchRequest): string[] {
  const canonicalExecutable = realpathSync.native(executable);
  const existingRoots = [...BASE_RUNTIME_DIRECTORIES, ...request.mountPlan.mounts.map((mount) => mount.hostPath)]
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => realpathSync.native(candidate));
  if (existingRoots.some((root) => isPathInsideAllowedRoots(canonicalExecutable, [root]))) {
    return [];
  }

  const resolvedExecutable = path.resolve(executable);
  const runtimeRoot =
    canonicalExecutable === resolvedExecutable
      ? path.basename(path.dirname(canonicalExecutable)) === "bin"
        ? path.dirname(path.dirname(canonicalExecutable))
        : path.dirname(canonicalExecutable)
      : commonAncestor(resolvedExecutable, canonicalExecutable);
  const canonicalRoot = realpathSync.native(runtimeRoot);
  const forbiddenRoots = [
    "/",
    "/dev",
    "/etc",
    "/home",
    "/proc",
    "/root",
    "/run",
    "/sys",
    "/tmp",
    "/var",
    path.resolve(os.homedir()),
  ];
  if (
    !statSync(canonicalRoot).isDirectory() ||
    forbiddenRoots.includes(canonicalRoot) ||
    request.mountPlan.mounts.some((mount) => isAtOrInside(mount.hostPath, canonicalRoot))
  ) {
    throw new Error(`Derived sandbox runtime root is too broad or overlaps session data: ${canonicalRoot}`);
  }
  return [canonicalRoot];
}

function commonAncestor(left: string, right: string): string {
  const leftParts = path.resolve(left).split(path.sep).filter(Boolean);
  const rightParts = path.resolve(right).split(path.sep).filter(Boolean);
  const common: string[] = [];
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      break;
    }
    common.push(leftParts[index] ?? "");
  }
  return path.join(path.parse(left).root, ...common);
}

function sandboxPathForExecutable(
  executable: string,
  runtimePaths: readonly string[],
  request: LaunchRequest,
): string {
  const canonicalExecutable = realpathSync.native(executable);
  for (const runtimePath of runtimePaths) {
    const canonicalRuntime = realpathSync.native(runtimePath);
    if (isPathInsideAllowedRoots(canonicalExecutable, [canonicalRuntime])) {
      return executable;
    }
  }
  for (const mount of request.mountPlan.mounts) {
    const canonicalHost = realpathSync.native(mount.hostPath);
    if (!isPathInsideAllowedRoots(canonicalExecutable, [canonicalHost])) {
      continue;
    }
    const stat = statSync(canonicalHost);
    if (stat.isFile()) {
      return mount.sandboxPath;
    }
    return path.posix.join(mount.sandboxPath, path.relative(canonicalHost, canonicalExecutable).split(path.sep).join("/"));
  }
  throw new Error(`Sandbox command is outside every planned runtime/workspace mount: ${executable}`);
}

function uniqueExistingPaths(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => existsSync(value)))];
}

function addScaffolding(args: string[], destinations: readonly string[]): void {
  const directories = new Set<string>();
  for (const destination of destinations) {
    let current = statSafe(destination)?.isDirectory() ? destination : path.dirname(destination);
    while (current !== "/" && current !== ".") {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => depth(left) - depth(right))) {
    args.push("--dir", directory);
  }
}

function assertMountDoesNotReplaceRuntime(sandboxPath: string, runtimePaths: readonly string[]): void {
  if (
    RESERVED_SANDBOX_ROOTS.some((reserved) => isAtOrInside(sandboxPath, reserved)) ||
    runtimePaths.some((runtime) => isAtOrInside(sandboxPath, runtime))
  ) {
    throw new Error(`Session mount cannot replace a Bubblewrap runtime path: ${sandboxPath}`);
  }
}

function assertAgentPolicyEnforcement(request: LaunchRequest): void {
  const enforcement = request.agentPolicyEnforcement;
  if (!enforcement) {
    throw new Error("Bubblewrap launch is missing agent-level tool/process policy enforcement.");
  }
  const expectedTools = [...new Set(request.executionPolicy.tools)].sort();
  const effectiveTools = [...new Set(enforcement.tools)].sort();
  if (
    JSON.stringify(expectedTools) !== JSON.stringify(effectiveTools) ||
    enforcement.processToolEnabled !== request.executionPolicy.process
  ) {
    throw new Error("Agent-level tool/process enforcement does not match the execution policy.");
  }
}

function assertMountPlanMatchesPolicy(request: LaunchRequest): void {
  const statePath = path.resolve(request.mountPlan.statePath);
  const principalRoot = path.dirname(path.dirname(statePath));
  const expected = new Map<
    string,
    { hostPath: string; mode: "ro" | "rw"; purpose: (typeof request.mountPlan.mounts)[number]["purpose"] }
  >([
    ["/state", { hostPath: path.join(statePath, "worker"), mode: "rw", purpose: "state" }],
    ["/hitch", { hostPath: path.join(statePath, "bridge"), mode: "rw", purpose: "state" }],
    [
      "/hitch/results",
      { hostPath: path.join(statePath, "bridge", "results"), mode: "ro", purpose: "state" },
    ],
    [
      "/agent-config",
      { hostPath: path.join(principalRoot, "shared", "pi", "agent"), mode: "rw", purpose: "agent-config" },
    ],
    [
      "/agent-sessions",
      { hostPath: path.join(principalRoot, "shared", "pi", "sessions"), mode: "rw", purpose: "state" },
    ],
  ]);
  if (request.executionPolicy.filesystem !== "none") {
    expected.set("/workspace", {
      hostPath: request.cwd,
      mode: request.executionPolicy.filesystem === "read-only" ? "ro" : "rw",
      purpose: "workspace",
    });
  }
  for (const mount of request.executionPolicy.mounts) {
    expected.set(mount.sandbox_path, {
      hostPath: mount.host_path,
      mode: mount.mode,
      purpose: "policy",
    });
  }
  for (let leftIndex = 0; leftIndex < request.executionPolicy.mounts.length; leftIndex += 1) {
    const left = request.executionPolicy.mounts[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < request.executionPolicy.mounts.length; rightIndex += 1) {
      const right = request.executionPolicy.mounts[rightIndex];
      if (
        right &&
        (isAtOrInside(left.sandbox_path, right.sandbox_path) ||
          isAtOrInside(right.sandbox_path, left.sandbox_path))
      ) {
        throw new Error(
          `Overlapping execution-policy mounts are not enforceable: ${left.sandbox_path}, ${right.sandbox_path}`,
        );
      }
    }
  }
  if (request.mountPlan.mounts.length !== expected.size) {
    throw new Error("Persisted mount plan has unexpected extra or missing entries.");
  }
  for (const mount of request.mountPlan.mounts) {
    const planned = expected.get(mount.sandboxPath);
    if (
      !planned ||
      path.resolve(mount.hostPath) !== path.resolve(planned.hostPath) ||
      mount.mode !== planned.mode ||
      mount.purpose !== planned.purpose
    ) {
      throw new Error(`Persisted mount does not match the execution policy: ${mount.sandboxPath}`);
    }
  }
}

function assertCanonicalMount(hostPath: string): void {
  const resolved = path.resolve(hostPath);
  const canonical = realpathSync.native(resolved);
  if (canonical !== resolved) {
    throw new Error(`Sandbox mount host path is not canonical: ${hostPath}`);
  }
}

function statSafe(candidate: string) {
  try {
    return statSync(candidate);
  } catch {
    return undefined;
  }
}

function depth(candidate: string): number {
  return candidate.split("/").filter(Boolean).length;
}

function isAtOrInside(candidate: string, root: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

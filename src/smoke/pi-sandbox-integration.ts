import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import type { ChannelAdapter } from "../channels/types.js";
import { configSchema, type HubConfig } from "../config/schema.js";
import { RemoteAgentHub } from "../core/hub.js";
import { SessionRegistry } from "../core/session-registry.js";
import { AgentToolBridge } from "../core/tool-bridge.js";
import type { HubSession } from "../core/types.js";
import { BubblewrapLauncher } from "../sandbox/bubblewrap-launcher.js";
import { DirectLauncher } from "../sandbox/direct-launcher.js";
import { FailClosedLauncherSelector } from "../sandbox/launcher-selector.js";
import {
  DEFAULT_REMOTE_EXECUTION_POLICY,
  executionPolicySchema,
  type ExecutionPolicy,
  UNSAFE_DIRECT_EXECUTION_POLICY,
} from "../security/policy.js";
import { SessionRuntimeStore, type SessionRuntimeOptions } from "../security/session-runtime.js";

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hitch-pi-sandbox-"));
  const workspace = path.join(tempDir, "workspace");
  mkdirSync(workspace);
  try {
    await verifyFailClosedSelection(tempDir);
    await verifyUnsafeSessionTightening(tempDir, workspace);
    await verifyPolicyArgsAndDescendantCleanup(tempDir, workspace);
    await verifyReadOnlySystemConfig(tempDir, workspace);
    await verifyRealPiStartsWithReadOnlySystemConfig(tempDir, workspace);
    await verifyInstalledPiExtensionsStartInSandbox(tempDir, workspace);
    process.stdout.write("Pi sandbox integration smoke ok\n");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

async function verifyUnsafeSessionTightening(tempDir: string, workspace: string): Promise<void> {
  const dataDir = path.join(tempDir, "policy-upgrade-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const registry = new SessionRegistry(dataDir);
  const target = { platform: "fake" as const, chatId: "upgrade", userId: "owner" };
  const oldSession = registry.createSession(
    target,
    "owner",
    "pi",
    workspace,
    (sessionId) =>
      runtime.materialize("owner", sessionId, workspace, UNSAFE_DIRECT_EXECUTION_POLICY, [workspace]),
  );
  registry.close();

  const channel: ChannelAdapter = {
    async *receive() {},
    async sendText() {},
  };
  const hub = new RemoteAgentHub(createConfig(dataDir, workspace, "pi", "hitch"), channel);
  await hub.run();
  const reopened = new SessionRegistry(dataDir);
  try {
    if (reopened.getById(oldSession.id)) {
      throw new Error("Hub startup preserved an unsafe direct session after the policy tightened to required sandboxing.");
    }
  } finally {
    reopened.close();
  }
}

async function verifyFailClosedSelection(tempDir: string): Promise<void> {
  const selector = new FailClosedLauncherSelector(
    new DirectLauncher(),
    new BubblewrapLauncher(path.join(tempDir, "missing-bwrap")),
  );
  await assertRejected(
    () => selector.select(DEFAULT_REMOTE_EXECUTION_POLICY),
    "A restricted policy fell back to direct execution when Bubblewrap was unavailable.",
  );
}

async function verifyPolicyArgsAndDescendantCleanup(tempDir: string, workspace: string): Promise<void> {
  const scriptPath = path.join(workspace, "fake-pi-tree.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s\n' "$@" > /state/args.txt
printf '%s\n%s\n%s\n%s\n' "$HITCH_SESSION_ID" "$HITCH_TOOL_OUTBOX" "$HITCH_TOOL_RESULT_DIR" "$HITCH_TOOL_TOKEN" > /state/tool-env.txt
printf '{"type":"send_media"}\n' > "$HITCH_TOOL_OUTBOX"
cat "$HITCH_TOOL_RESULT_DIR/seed.txt" > /state/tool-result.txt
result_writable=false
if printf 'bad' > "$HITCH_TOOL_RESULT_DIR/worker-write.txt" 2>/dev/null; then result_writable=true; fi
printf '%s' "$result_writable" > /state/tool-result-writable.txt
touch /state/ready
sleep 60 &
while :; do sleep 60; done
`,
    { mode: 0o700 },
  );
  const dataDir = path.join(tempDir, "tree-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const session = createSession(runtime, "tree", workspace, DEFAULT_REMOTE_EXECUTION_POLICY);
  const backend = new PiRpcBackend(createConfig(dataDir, workspace, scriptPath, "hitch"));
  const toolContext = new AgentToolBridge().contextFor(session);
  writeFileSync(path.join(toolContext.resultDir, "seed.txt"), "hub-result-readable");
  const pid = await backend.start(session, toolContext);
  if (!pid) {
    throw new Error("Sandboxed Pi backend did not return a process ID.");
  }
  const readyPath = path.join(session.statePath, "worker", "ready");
  await waitFor(() => existsSync(readyPath), 5_000, "Sandboxed Pi adapter did not reach its fake worker.");
  const args = readFileSync(path.join(session.statePath, "worker", "args.txt"), "utf8").trim().split("\n");
  const toolsIndex = args.indexOf("--tools");
  if (toolsIndex < 0 || args[toolsIndex + 1] !== DEFAULT_REMOTE_EXECUTION_POLICY.tools.join(",")) {
    throw new Error(`Pi did not receive the execution policy tool allowlist: ${JSON.stringify(args)}`);
  }
  const toolEnvironment = readFileSync(path.join(session.statePath, "worker", "tool-env.txt"), "utf8")
    .trim()
    .split("\n");
  if (
    toolEnvironment[0] !== session.id ||
    toolEnvironment[1] !== "/hitch/outbox.jsonl" ||
    toolEnvironment[2] !== "/hitch/results" ||
    toolEnvironment[3] !== toolContext.token ||
    readFileSync(toolContext.outboxPath, "utf8").trim() !== '{"type":"send_media"}' ||
    readFileSync(path.join(session.statePath, "worker", "tool-result.txt"), "utf8") !== "hub-result-readable" ||
    readFileSync(path.join(session.statePath, "worker", "tool-result-writable.txt"), "utf8") !== "false"
  ) {
    throw new Error(`Sandboxed Pi did not receive an isolated Hitch tool bridge: ${JSON.stringify(toolEnvironment)}`);
  }

  const processTree = descendantsOf(pid);
  if (processTree.length === 0) {
    throw new Error("Sandbox cleanup smoke did not observe a Pi descendant process.");
  }
  await backend.stop();
  await waitFor(
    () => !existsSync(`/proc/${pid}`) && processTree.every((childPid) => !existsSync(`/proc/${childPid}`)),
    5_000,
    `Stopping Pi left sandbox descendants alive: ${processTree.join(", ")}`,
  );
}

async function verifyReadOnlySystemConfig(tempDir: string, workspace: string): Promise<void> {
  const scriptPath = path.join(workspace, "fake-pi-system.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
value=$(cat /agent-config/token.txt)
writable=false
if printf 'tampered' > /agent-config/token.txt 2>/dev/null; then writable=true; fi
printf '{"value":"%s","writable":%s,"home":"%s"}' "$value" "$writable" "$HOME" > /state/system-result.json
`,
    { mode: 0o700 },
  );
  const agentConfig = path.join(tempDir, "system-agent-config");
  mkdirSync(agentConfig);
  writeFileSync(path.join(agentConfig, "token.txt"), "system-config-readable");
  const dataDir = path.join(tempDir, "system-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const policy = executionPolicySchema.parse({ tools: [], process: false });
  const options: SessionRuntimeOptions = { agentConfig: { hostPath: agentConfig, mode: "ro" } };
  const session = createSession(runtime, "system", workspace, policy, options);
  const backend = new PiRpcBackend(createConfig(dataDir, workspace, scriptPath, "system", [], agentConfig));
  try {
    await backend.start(session);
    const resultPath = path.join(session.statePath, "worker", "system-result.json");
    await waitFor(() => existsSync(resultPath), 5_000, "System config mount smoke did not finish.");
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      value?: string;
      writable?: boolean;
      home?: string;
    };
    if (result.value !== "system-config-readable" || result.writable !== false || result.home !== "/state/home") {
      throw new Error(`System Pi config was not mounted read-only with a private HOME: ${JSON.stringify(result)}`);
    }
    if (readFileSync(path.join(agentConfig, "token.txt"), "utf8") !== "system-config-readable") {
      throw new Error("Sandboxed Pi modified the host system config.");
    }
  } finally {
    await backend.stop();
  }
}

async function verifyRealPiStartsWithReadOnlySystemConfig(tempDir: string, workspace: string): Promise<void> {
  const installedAgentConfig = path.join(os.homedir(), ".pi", "agent");
  const agentConfig = existsSync(installedAgentConfig)
    ? installedAgentConfig
    : path.join(tempDir, "real-pi-agent-config");
  if (!existsSync(agentConfig)) {
    mkdirSync(agentConfig);
    writeFileSync(path.join(agentConfig, "settings.json"), "{}\n");
  }
  const dataDir = path.join(tempDir, "real-pi-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const policy = executionPolicySchema.parse({ tools: [], process: false });
  const session = createSession(runtime, "real-pi", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "ro" },
  });
  const config = createConfig(
    dataDir,
    workspace,
    "pi",
    "system",
    ["--mode", "rpc", "--no-session", "--no-extensions"],
    agentConfig,
  );
  const backend = new PiRpcBackend(config);
  try {
    await backend.start(session);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!backend.isAlive()) {
      throw new Error("Real Pi exited while starting with a read-only system config mount.");
    }
  } finally {
    await backend.stop();
  }
}

async function verifyInstalledPiExtensionsStartInSandbox(tempDir: string, workspace: string): Promise<void> {
  const agentConfig = path.join(os.homedir(), ".pi", "agent");
  if (!existsSync(agentConfig)) {
    return;
  }
  const dataDir = path.join(workspace, ".installed-pi-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const policy = executionPolicySchema.parse({ tools: ["*"], process: true });
  const session = createSession(runtime, "installed-pi", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "ro" },
  });
  const config = createConfig(
    dataDir,
    workspace,
    "pi",
    "system",
    ["--mode", "rpc", "--no-session"],
    agentConfig,
  );
  const backend = new PiRpcBackend(config);
  try {
    await backend.start(session);
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (!backend.isAlive()) {
      throw new Error("Installed Pi extensions exited during sandbox startup.");
    }
  } finally {
    await backend.stop();
  }
}

function createSession(
  runtime: SessionRuntimeStore,
  id: string,
  workspace: string,
  policy: ExecutionPolicy,
  options: SessionRuntimeOptions = {},
): HubSession {
  const security = runtime.materialize("owner", id, workspace, policy, [workspace], options);
  const now = new Date().toISOString();
  return {
    id,
    ownerPrincipalId: "owner",
    visibility: "private",
    platform: "fake",
    chatId: "sandbox",
    userId: "owner",
    agent: "pi",
    cwd: workspace,
    ...security,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function createConfig(
  dataDir: string,
  workspace: string,
  command: string,
  configScope: "hitch" | "system",
  defaultArgs: string[] = [],
  piSystemConfigRoot?: string,
): HubConfig {
  const parsed = configSchema.parse({
    data_dir: dataDir,
    default_cwd: workspace,
    users: { owner: { allowed_roots: [workspace] } },
    agents: { pi: { command, default_args: defaultArgs, config_scope: configScope } },
  });
  return {
    ...parsed,
    dataDir,
    defaultCwd: workspace,
    allowedRoots: [workspace],
    outboundRoots: [],
    principalRoots: { owner: [workspace] },
    ...(piSystemConfigRoot ? { piSystemConfigRoot } : {}),
  };
}

function descendantsOf(rootPid: number): number[] {
  const descendants: number[] = [];
  const pending = [rootPid];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const pid = pending.pop();
    if (!pid) {
      continue;
    }
    let children: number[] = [];
    try {
      children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    } catch {
      continue;
    }
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        descendants.push(child);
        pending.push(child);
      }
    }
  }
  return descendants;
}

async function waitFor(condition: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!condition()) {
    throw new Error(message);
  }
}

async function assertRejected(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

await main();

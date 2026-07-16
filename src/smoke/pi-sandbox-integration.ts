import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    await verifySystemAgentConfigMigration(tempDir, workspace);
    await verifyPolicyArgsAndDescendantCleanup(tempDir, workspace);
    await verifyWritableSystemConfig(tempDir, workspace);
    await verifyRealPiStartsWithWritableSystemConfig(tempDir, workspace);
    await verifyRealPiStartsWithCredentialGuard(tempDir, workspace);
    await verifyBrokenCredentialGuardFailsClosed(tempDir, workspace);
    await verifyCommandBackedCredentialFailsClosed(tempDir, workspace);
    await verifyLegacyCommandBackedCredentialFailsClosed(tempDir, workspace);
    process.stdout.write("Pi sandbox integration smoke ok\n");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

async function verifySystemAgentConfigMigration(tempDir: string, workspace: string): Promise<void> {
  const dataDir = path.join(tempDir, "system-config-migration-data");
  const agentConfig = path.join(tempDir, "system-config-migration-agent");
  const otherConfig = path.join(tempDir, "system-config-migration-other");
  mkdirSync(agentConfig);
  mkdirSync(otherConfig);
  const runtime = new SessionRuntimeStore(dataDir);
  const registry = new SessionRegistry(dataDir);
  const target = { platform: "fake" as const, chatId: "migration", userId: "owner" };
  const createLegacySession = (configRoot: string) =>
    registry.createSession(target, "owner", "pi", workspace, (sessionId) =>
      runtime.materialize("owner", sessionId, workspace, DEFAULT_REMOTE_EXECUTION_POLICY, [workspace], {
        agentConfig: { hostPath: configRoot, mode: "ro" },
      }),
    );
  const migratedSession = createLegacySession(agentConfig);
  const unrelatedSession = createLegacySession(otherConfig);
  registry.close();

  const channel: ChannelAdapter = {
    async *receive() {},
    async sendText() {},
  };
  const hub = new RemoteAgentHub(createConfig(dataDir, workspace, "pi", "system", [], agentConfig), channel);
  await hub.run();

  const reopened = new SessionRegistry(dataDir);
  const migratedMount = reopened
    .getById(migratedSession.id)
    ?.mountPlan.mounts.find((mount) => mount.sandboxPath === "/agent-config");
  const unrelated = reopened.getById(unrelatedSession.id);
  reopened.close();
  if (migratedMount?.mode !== "rw" || unrelated) {
    throw new Error(`Hub did not narrowly migrate the trusted system config mount: ${JSON.stringify({ migratedMount, unrelated })}`);
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

async function verifyWritableSystemConfig(tempDir: string, workspace: string): Promise<void> {
  const scriptPath = path.join(workspace, "fake-pi-system.sh");
  const unmountedSecret = path.join(tempDir, "system-config-unmounted-secret.txt");
  writeFileSync(unmountedSecret, "must-not-be-visible");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
value=$(cat /agent-config/token.txt)
writable=false
if printf 'tampered' > /agent-config/token.txt 2>/dev/null; then writable=true; fi
mkdir /agent-config/settings.json.lock
mkdir /agent-config/trust.json.lock
unmounted_visible=false
if test -e '${unmountedSecret}'; then unmounted_visible=true; fi
printf '{"value":"%s","writable":%s,"home":"%s","unmountedVisible":%s}' "$value" "$writable" "$HOME" "$unmounted_visible" > /state/system-result.json
IFS= read -r command
printf '%s\n' '{"type":"agent_start"}'
printf '%s\n' '{"type":"agent_end","willRetry":false,"messages":[{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"RW_CONFIG_OK"}]}]}'
printf '%s\n' '{"type":"agent_settled"}'
`,
    { mode: 0o700 },
  );
  const agentConfig = path.join(tempDir, "system-agent-config");
  mkdirSync(agentConfig);
  chmodSync(agentConfig, 0o755);
  writeFileSync(path.join(agentConfig, "token.txt"), "system-config-readable");
  const dataDir = path.join(tempDir, "system-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const policy = executionPolicySchema.parse({ tools: [], process: false });
  const options: SessionRuntimeOptions = { agentConfig: { hostPath: agentConfig, mode: "rw" } };
  const session = createSession(runtime, "system", workspace, policy, options);
  const backend = new PiRpcBackend(createConfig(dataDir, workspace, scriptPath, "system", [], agentConfig));
  try {
    await backend.start(session);
    const resultPath = path.join(session.statePath, "worker", "system-result.json");
    await waitFor(() => existsSync(resultPath), 5_000, "System config mount smoke did not finish.");
    await backend.send({ text: "exercise writable system config" });
    const finalText = await waitForFinal(backend, 5_000);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
      value?: string;
      writable?: boolean;
      home?: string;
      unmountedVisible?: boolean;
    };
    if (
      result.value !== "system-config-readable" ||
      result.writable !== true ||
      result.home !== "/state/home" ||
      result.unmountedVisible !== false
    ) {
      throw new Error(`System Pi config was not mounted read/write with a private HOME: ${JSON.stringify(result)}`);
    }
    if (
      readFileSync(path.join(agentConfig, "token.txt"), "utf8") !== "tampered" ||
      !existsSync(path.join(agentConfig, "settings.json.lock")) ||
      !existsSync(path.join(agentConfig, "trust.json.lock")) ||
      (statSync(agentConfig).mode & 0o777) !== 0o755 ||
      finalText !== "RW_CONFIG_OK"
    ) {
      throw new Error(`Sandboxed Pi could not complete a prompt with writable system config: ${finalText}`);
    }
  } finally {
    await backend.stop();
  }
}

async function verifyRealPiStartsWithWritableSystemConfig(tempDir: string, workspace: string): Promise<void> {
  const agentConfig = path.join(tempDir, "real-pi-agent-config");
  mkdirSync(agentConfig);
  writeFileSync(path.join(agentConfig, "settings.json"), "{}\n");
  writeFileSync(path.join(agentConfig, "trust.json"), "{}\n");
  const dataDir = path.join(tempDir, "real-pi-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const policy = executionPolicySchema.parse({ tools: [], process: false });
  const session = createSession(runtime, "real-pi", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "rw" },
  });
  const config = createConfig(
    dataDir,
    workspace,
    "pi",
    "system",
    ["--mode", "rpc", "--no-extensions"],
    agentConfig,
  );
  const backend = new PiRpcBackend(config);
  try {
    await backend.start(session);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!backend.isAlive()) {
      throw new Error("Real Pi exited while creating lock files in a writable system config mount.");
    }
  } finally {
    await backend.stop();
  }
}

async function verifyRealPiStartsWithCredentialGuard(tempDir: string, workspace: string): Promise<void> {
  const agentConfig = path.join(tempDir, "guarded-pi-agent-config");
  mkdirSync(agentConfig);
  writeFileSync(path.join(agentConfig, "settings.json"), "{}\n");
  writeFileSync(path.join(agentConfig, "trust.json"), "{}\n");
  const dataDir = path.join(tempDir, "guarded-pi-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const guardPath = runtime.provisionCredentialGuard(path.resolve("runtime/credential-guard.mjs"));
  const policy = guardedExecutionPolicy();
  const session = createSession(runtime, "guarded-real-pi", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "rw" },
    credentialGuard: { hostPath: guardPath },
  });
  const config = createGuardedConfig(dataDir, workspace, agentConfig, guardPath, policy);
  const backend = new PiRpcBackend(config);
  try {
    await backend.start(session);
    if (!backend.isAlive()) {
      throw new Error("Real Pi exited while loading Hitch's credential guard in Bubblewrap.");
    }
  } finally {
    await backend.stop();
  }
}

async function verifyBrokenCredentialGuardFailsClosed(tempDir: string, workspace: string): Promise<void> {
  const agentConfig = path.join(tempDir, "broken-guard-agent-config");
  mkdirSync(agentConfig);
  writeFileSync(path.join(agentConfig, "settings.json"), "{}\n");
  const brokenSource = path.join(tempDir, "broken-credential-guard.mjs");
  writeFileSync(brokenSource, "this is not valid javascript {{{\n");
  const dataDir = path.join(tempDir, "broken-guard-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const guardPath = runtime.provisionCredentialGuard(brokenSource);
  const policy = guardedExecutionPolicy();
  const session = createSession(runtime, "broken-guard", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "rw" },
    credentialGuard: { hostPath: guardPath },
  });
  const backend = new PiRpcBackend(createGuardedConfig(dataDir, workspace, agentConfig, guardPath, policy));
  await assertRejected(
    () => backend.start(session),
    "Pi started after its required credential guard failed to load.",
  );
  await backend.stop();
}

async function verifyCommandBackedCredentialFailsClosed(tempDir: string, workspace: string): Promise<void> {
  const agentConfig = path.join(tempDir, "command-credential-agent-config");
  mkdirSync(agentConfig);
  const commandArtifact = path.join(workspace, "command-backed-credential-ran");
  writeFileSync(
    path.join(agentConfig, "auth.json"),
    JSON.stringify({ unsafe: { type: "api_key", key: `!touch ${commandArtifact}` } }),
  );
  const dataDir = path.join(tempDir, "command-credential-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const guardPath = runtime.provisionCredentialGuard(path.resolve("runtime/credential-guard.mjs"));
  const policy = guardedExecutionPolicy();
  const session = createSession(runtime, "command-credential", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "rw" },
    credentialGuard: { hostPath: guardPath },
  });
  const backend = new PiRpcBackend(createGuardedConfig(dataDir, workspace, agentConfig, guardPath, policy));
  await assertRejected(
    () => backend.start(session),
    "Pi accepted a command-backed credential in required isolation mode.",
  );
  await backend.stop();
  if (existsSync(commandArtifact)) {
    throw new Error("A command-backed credential executed before the guard rejected it.");
  }
}

async function verifyLegacyCommandBackedCredentialFailsClosed(tempDir: string, workspace: string): Promise<void> {
  const agentConfig = path.join(tempDir, "legacy-command-credential-agent-config");
  mkdirSync(agentConfig);
  const commandArtifact = path.join(workspace, "legacy-command-backed-credential-ran");
  writeFileSync(
    path.join(agentConfig, "settings.json"),
    JSON.stringify({ apiKeys: { unsafe: `!touch ${commandArtifact}` } }),
  );
  const dataDir = path.join(tempDir, "legacy-command-credential-data");
  const runtime = new SessionRuntimeStore(dataDir);
  const guardPath = runtime.provisionCredentialGuard(path.resolve("runtime/credential-guard.mjs"));
  const policy = guardedExecutionPolicy();
  const session = createSession(runtime, "legacy-command-credential", workspace, policy, {
    agentConfig: { hostPath: agentConfig, mode: "rw" },
    credentialGuard: { hostPath: guardPath },
  });
  const backend = new PiRpcBackend(createGuardedConfig(dataDir, workspace, agentConfig, guardPath, policy));
  await assertRejected(
    () => backend.start(session),
    "Pi accepted a legacy command-backed credential in required isolation mode.",
  );
  await backend.stop();
  if (existsSync(commandArtifact)) {
    throw new Error("A legacy command-backed credential executed before the guard rejected it.");
  }
}

function createGuardedConfig(
  dataDir: string,
  workspace: string,
  agentConfig: string,
  guardPath: string,
  policy: ExecutionPolicy,
): HubConfig {
  const parsed = configSchema.parse({
    data_dir: dataDir,
    default_cwd: workspace,
    users: { owner: { allowed_roots: [workspace] } },
    agents: {
      pi: {
        command: "pi",
        default_args: ["--mode", "rpc"],
        config_scope: "system",
        credential_isolation: "required",
        execution_policy: policy,
      },
    },
  });
  return {
    ...parsed,
    dataDir,
    defaultCwd: workspace,
    allowedRoots: [workspace],
    outboundRoots: [],
    principalRoots: { owner: [workspace] },
    piSystemConfigRoot: agentConfig,
    piCredentialGuardPath: guardPath,
  };
}

function guardedExecutionPolicy(): ExecutionPolicy {
  return executionPolicySchema.parse({ tools: ["read", "write", "edit", "ls"], process: false });
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
    agents: {
      pi: {
        command,
        default_args: defaultArgs,
        config_scope: configScope,
        credential_isolation: "disabled",
      },
    },
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

async function waitForFinal(backend: PiRpcBackend, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for await (const event of backend.events()) {
          if (event.type === "final") {
            return event.text;
          }
        }
        throw new Error("Pi event stream closed before a final response.");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for Pi's final response.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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

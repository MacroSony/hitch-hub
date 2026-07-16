import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "../channels/types.js";
import { loadConfig } from "../config/load-config.js";
import { configSchema, type HubConfig } from "../config/schema.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget, HubSession } from "../core/types.js";
import { DEFAULT_REMOTE_EXECUTION_POLICY } from "../security/policy.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hitch-multi-user-"));
  const aliceWorkspace = path.join(tempDir, "alice-workspace");
  const bobWorkspace = path.join(tempDir, "bob-workspace");
  mkdirSync(aliceWorkspace);
  mkdirSync(bobWorkspace);
  const dataDir = path.join(aliceWorkspace, ".hitch-data");
  try {
    verifySystemScopeRejectsMultiplePrincipals(tempDir, aliceWorkspace, bobWorkspace);
    await verifyHubRoutesEachIdentityToItsOwnSandbox(tempDir);
    const runtime = new SessionRuntimeStore(dataDir);
    const alice = createSession(runtime, "alice", aliceWorkspace);
    const bob = createSession(runtime, "bob", bobWorkspace);
    writeFileSync(path.join(dataDir, "hub-secret.txt"), "hub-private");
    writeFileSync(agentConfigPath(alice), "alice-private");
    writeFileSync(agentConfigPath(bob), "bob-private");
    writeFileSync(path.join(mountHostPath(alice, "/agent-sessions"), "owner.txt"), "alice-sessions");
    writeFileSync(path.join(mountHostPath(bob, "/agent-sessions"), "owner.txt"), "bob-sessions");
    writeFileSync(path.join(aliceWorkspace, "workspace-owner.txt"), "alice");
    writeFileSync(path.join(bobWorkspace, "workspace-owner.txt"), "bob");

    const aliceScript = writeProbeScript(
      aliceWorkspace,
      "alice",
      bobWorkspace,
      bob.statePath,
      path.dirname(agentConfigPath(bob)),
      mountHostPath(bob, "/agent-sessions"),
      dataDir,
    );
    const bobScript = writeProbeScript(
      bobWorkspace,
      "bob",
      aliceWorkspace,
      alice.statePath,
      path.dirname(agentConfigPath(alice)),
      mountHostPath(alice, "/agent-sessions"),
      dataDir,
    );
    const config = baseConfig(dataDir, aliceWorkspace, bobWorkspace);
    const aliceBackend = new PiRpcBackend(withCommand(config, aliceScript));
    const bobBackend = new PiRpcBackend(withCommand(config, bobScript));
    try {
      await Promise.all([aliceBackend.start(alice), bobBackend.start(bob)]);
      const aliceResultPath = path.join(alice.statePath, "worker", "isolation-result.json");
      const bobResultPath = path.join(bob.statePath, "worker", "isolation-result.json");
      await waitFor(
        () => existsSync(aliceResultPath) && existsSync(bobResultPath),
        5_000,
        "Multi-user sandbox probes did not finish.",
      );
      assertIsolated("alice", JSON.parse(readFileSync(aliceResultPath, "utf8")) as ProbeResult);
      assertIsolated("bob", JSON.parse(readFileSync(bobResultPath, "utf8")) as ProbeResult);
      assertOwnWritesPersisted(alice, "alice");
      assertOwnWritesPersisted(bob, "bob");
    } finally {
      await Promise.all([aliceBackend.stop(), bobBackend.stop()]);
    }
    process.stdout.write("Multi-user sandbox smoke ok\n");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function verifySystemScopeRejectsMultiplePrincipals(
  tempDir: string,
  aliceWorkspace: string,
  bobWorkspace: string,
): void {
  const systemConfig = path.join(tempDir, "system-agent-config");
  mkdirSync(systemConfig);
  const configPath = path.join(tempDir, "invalid-system-multi-user.yaml");
  writeFileSync(
    configPath,
    JSON.stringify({
      data_dir: path.join(tempDir, "invalid-data"),
      users: {
        alice: { allowed_roots: [aliceWorkspace] },
        bob: { allowed_roots: [bobWorkspace] },
      },
      agents: {
        pi: { config_scope: "system", system_config_root: systemConfig, credential_isolation: "disabled" },
      },
    }),
  );
  assertConfigRejected(
    configPath,
    "allowed only with one configured principal",
    "A shared system Pi identity was accepted for multiple principals.",
  );

  writeFileSync(
    configPath,
    JSON.stringify({
      data_dir: path.join(tempDir, "invalid-unsafe-data"),
      users: { alice: { telegram_ids: ["alice"], allowed_roots: [aliceWorkspace] } },
      channels: {
        telegram: { enabled: true, unsafe_allow_all: true },
      },
      agents: {
        pi: { config_scope: "system", system_config_root: systemConfig, credential_isolation: "disabled" },
      },
    }),
  );
  assertConfigRejected(
    configPath,
    "cannot be combined with unsafe_allow_all",
    "A shared system Pi identity was accepted with unsafe_allow_all.",
  );

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(systemConfig, 0o500);
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          data_dir: path.join(tempDir, "invalid-read-only-config-data"),
          users: { alice: { allowed_roots: [aliceWorkspace] } },
          agents: {
            pi: { config_scope: "system", system_config_root: systemConfig, credential_isolation: "disabled" },
          },
        }),
      );
      assertConfigRejected(
        configPath,
        "must be readable and writable by Hitch",
        "A non-writable system Pi config root was accepted.",
      );
    } finally {
      chmodSync(systemConfig, 0o700);
    }
  }
}

function assertConfigRejected(configPath: string, expected: string, message: string): void {
  try {
    loadConfig(configPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) {
      return;
    }
    throw error;
  }
  throw new Error(message);
}

async function verifyHubRoutesEachIdentityToItsOwnSandbox(tempDir: string): Promise<void> {
  const aliceWorkspace = path.join(tempDir, "route-alice-workspace");
  const bobWorkspace = path.join(tempDir, "route-bob-workspace");
  mkdirSync(aliceWorkspace);
  mkdirSync(bobWorkspace);
  writeFileSync(path.join(aliceWorkspace, "workspace-owner.txt"), "alice");
  writeFileSync(path.join(bobWorkspace, "workspace-owner.txt"), "bob");
  const dataDir = path.join(aliceWorkspace, ".hitch-route-data");
  const parsed = configSchema.parse({
    data_dir: dataDir,
    default_cwd: aliceWorkspace,
    users: {
      alice: { telegram_ids: ["telegram-alice"], allowed_roots: [aliceWorkspace] },
      bob: { telegram_ids: ["telegram-bob"], allowed_roots: [bobWorkspace] },
    },
    channels: {
      telegram: {
        enabled: true,
        allowed_chat_ids: ["shared-chat"],
        unsafe_allow_all: false,
      },
    },
    agents: {
      pi: {
        command: process.execPath,
        default_args: [
          "--input-type=module",
          "-e",
          routingPiScript(aliceWorkspace, bobWorkspace),
          "--",
        ],
        config_scope: "hitch",
      },
    },
  });
  const config: HubConfig = {
    ...parsed,
    dataDir,
    defaultCwd: aliceWorkspace,
    allowedRoots: [aliceWorkspace, bobWorkspace],
    outboundRoots: [],
    principalRoots: { alice: [aliceWorkspace], bob: [bobWorkspace] },
  };
  const channel = new PrincipalRoutingChannel(aliceWorkspace, bobWorkspace);
  await new RemoteAgentHub(config, channel).run();
  const routeResults = channel.sent.filter((entry) => entry.text.startsWith("route-owner="));
  const expected = [
    {
      userId: "telegram-alice",
      text: "route-owner=alice;prompt=alice-private-route-731;other-visible=false",
    },
    {
      userId: "telegram-bob",
      text: "route-owner=bob;prompt=bob-private-route-947;other-visible=false",
    },
  ];
  if (
    routeResults.length !== expected.length ||
    expected.some(
      (wanted) =>
        routeResults.filter(
          (entry) => entry.target.userId === wanted.userId && entry.text === wanted.text,
        ).length !== 1,
    )
  ) {
    throw new Error(`Hub crossed or duplicated a principal route: ${JSON.stringify(routeResults)}`);
  }
}

class PrincipalRoutingChannel implements ChannelAdapter {
  readonly sent: Array<{ target: ChatTarget; text: string }> = [];

  constructor(
    private readonly aliceWorkspace: string,
    private readonly bobWorkspace: string,
  ) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    const alice = { platform: "telegram" as const, chatId: "shared-chat", userId: "telegram-alice" };
    const bob = { platform: "telegram" as const, chatId: "shared-chat", userId: "telegram-bob" };
    yield event("alice-new", alice, `!new pi ${this.aliceWorkspace}`);
    yield event("bob-new", bob, `!new pi ${this.bobWorkspace}`);
    yield event("alice-prompt", alice, "alice-private-route-731");
    yield event("bob-prompt", bob, "bob-private-route-947");
  }

  async sendText(target: ChatTarget, text: string, _options?: SendOptions): Promise<void> {
    this.sent.push({ target, text });
  }
}

function event(id: string, target: ChatTarget, text: string): InboundChatEvent {
  return { id, target, text, receivedAt: new Date().toISOString() };
}

function routingPiScript(aliceWorkspace: string, bobWorkspace: string): string {
  return `
import fs from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") return;
  const owner = fs.readFileSync("/workspace/workspace-owner.txt", "utf8");
  const otherPath = owner === "alice" ? ${JSON.stringify(bobWorkspace)} : ${JSON.stringify(aliceWorkspace)};
  const text = "route-owner=" + owner + ";prompt=" + command.message + ";other-visible=" + fs.existsSync(otherPath);
  send({ type: "agent_start" });
  send({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }]
  });
  send({ type: "agent_settled" });
});
`;
}

function createSession(runtime: SessionRuntimeStore, principalId: string, workspace: string): HubSession {
  const id = `${principalId}-session`;
  const security = runtime.materialize(
    principalId,
    id,
    workspace,
    DEFAULT_REMOTE_EXECUTION_POLICY,
    [workspace],
  );
  const now = new Date().toISOString();
  return {
    id,
    ownerPrincipalId: principalId,
    visibility: "private",
    platform: "fake",
    chatId: principalId,
    userId: principalId,
    agent: "pi",
    cwd: workspace,
    ...security,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function agentConfigPath(session: HubSession): string {
  return path.join(mountHostPath(session, "/agent-config"), "owner.txt");
}

function mountHostPath(session: HubSession, sandboxPath: string): string {
  const mount = session.mountPlan.mounts.find((candidate) => candidate.sandboxPath === sandboxPath);
  if (!mount) {
    throw new Error(`Session ${session.id} has no ${sandboxPath} mount.`);
  }
  return mount.hostPath;
}

function writeProbeScript(
  workspace: string,
  owner: string,
  otherWorkspace: string,
  otherState: string,
  otherAgentConfig: string,
  otherAgentSessions: string,
  dataDir: string,
): string {
  const scriptPath = path.join(workspace, "principal-probe.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s' '${owner}-state' > /state/own-write.txt
printf '%s' '${owner}-config' > /agent-config/own-write.txt
printf '%s' '${owner}-sessions' > /agent-sessions/own-write.txt
node -e '
const fs = require("node:fs");
const result = {
  cwd: process.cwd(),
  home: process.env.HOME,
  ownWorkspace: fs.readFileSync("/workspace/workspace-owner.txt", "utf8"),
  ownConfig: fs.readFileSync("/agent-config/owner.txt", "utf8"),
  ownSessions: fs.readFileSync("/agent-sessions/owner.txt", "utf8"),
  otherWorkspaceVisible: fs.existsSync(${JSON.stringify(otherWorkspace)}),
  otherStateVisible: fs.existsSync(${JSON.stringify(otherState)}),
  otherAgentConfigVisible: fs.existsSync(${JSON.stringify(otherAgentConfig)}),
  otherAgentSessionsVisible: fs.existsSync(${JSON.stringify(otherAgentSessions)}),
  hubDataVisible: fs.existsSync(${JSON.stringify(path.join(dataDir, "hub-secret.txt"))}),
  hubDataViaWorkspaceVisible: fs.existsSync(${JSON.stringify(
    path.posix.join("/workspace", path.relative(workspace, dataDir).split(path.sep).join("/"), "hub-secret.txt"),
  )})
};
fs.writeFileSync("/state/isolation-result.json", JSON.stringify(result));
'
`,
    { mode: 0o700 },
  );
  return scriptPath;
}

type ProbeResult = {
  cwd?: string;
  home?: string;
  ownWorkspace?: string;
  ownConfig?: string;
  ownSessions?: string;
  otherWorkspaceVisible?: boolean;
  otherStateVisible?: boolean;
  otherAgentConfigVisible?: boolean;
  otherAgentSessionsVisible?: boolean;
  hubDataVisible?: boolean;
  hubDataViaWorkspaceVisible?: boolean;
};

function assertIsolated(owner: "alice" | "bob", result: ProbeResult): void {
  if (
    result.cwd !== "/workspace" ||
    result.home !== "/state/home" ||
    result.ownWorkspace !== owner ||
    result.ownConfig !== `${owner}-private` ||
    result.ownSessions !== `${owner}-sessions` ||
    result.otherWorkspaceVisible !== false ||
    result.otherStateVisible !== false ||
    result.otherAgentConfigVisible !== false ||
    result.otherAgentSessionsVisible !== false ||
    result.hubDataVisible !== false ||
    result.hubDataViaWorkspaceVisible !== false
  ) {
    throw new Error(`${owner} sandbox crossed a principal boundary: ${JSON.stringify(result)}`);
  }
}

function assertOwnWritesPersisted(session: HubSession, owner: "alice" | "bob"): void {
  const stateWrite = readFileSync(path.join(session.statePath, "worker", "own-write.txt"), "utf8");
  const configWrite = readFileSync(path.join(path.dirname(agentConfigPath(session)), "own-write.txt"), "utf8");
  const sessionsWrite = readFileSync(
    path.join(mountHostPath(session, "/agent-sessions"), "own-write.txt"),
    "utf8",
  );
  if (
    stateWrite !== `${owner}-state` ||
    configWrite !== `${owner}-config` ||
    sessionsWrite !== `${owner}-sessions`
  ) {
    throw new Error(`${owner} lost writes inside its own private state/config mounts.`);
  }
}

function baseConfig(dataDir: string, aliceWorkspace: string, bobWorkspace: string): HubConfig {
  const parsed = configSchema.parse({
    data_dir: dataDir,
    users: {
      alice: { allowed_roots: [aliceWorkspace] },
      bob: { allowed_roots: [bobWorkspace] },
    },
    agents: { pi: { config_scope: "hitch", default_args: [] } },
  });
  return {
    ...parsed,
    dataDir,
    defaultCwd: aliceWorkspace,
    allowedRoots: [aliceWorkspace, bobWorkspace],
    outboundRoots: [],
    principalRoots: { alice: [aliceWorkspace], bob: [bobWorkspace] },
  };
}

function withCommand(config: HubConfig, command: string): HubConfig {
  return { ...config, agents: { pi: { ...config.agents.pi, command } } };
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

await main();

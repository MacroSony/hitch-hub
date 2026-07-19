import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import { loadConfig } from "../config/load-config.js";
import { AgentToolBridge } from "../core/tool-bridge.js";
import type { HubSession } from "../core/types.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";

const REQUIRED_TOOLS = ["read", "write", "edit", "ls", "hitch_send_media"];

async function main(): Promise<void> {
  const configPath = configPathFromArgs(process.argv.slice(2));
  const loaded = loadConfig(configPath);
  const principalEntries = Object.entries(loaded.users);
  if (principalEntries.length !== 1) {
    throw new Error("Restricted single-principal smoke requires exactly one configured principal.");
  }
  const principalEntry = principalEntries[0];
  if (!principalEntry) {
    throw new Error("Restricted single-principal smoke could not resolve its principal.");
  }
  const [principalId, principal] = principalEntry;
  const roots = loaded.principalRoots[principalId];
  const policy = principal.execution_policy ?? loaded.agents.pi.execution_policy;
  if (!roots || roots.length !== 1 || !loaded.defaultCwd || !policy) {
    throw new Error("Restricted single-principal smoke requires one root, a default cwd, and an execution policy.");
  }
  if (
    loaded.agents.pi.config_scope !== "system" ||
    loaded.agents.pi.credential_isolation !== "required" ||
    !loaded.piSystemConfigRoot ||
    policy.filesystem !== "workspace-write" ||
    policy.mounts.length !== 0 ||
    policy.process ||
    policy.agent_network !== "allow" ||
    policy.sandbox !== "required" ||
    policy.tools.join(",") !== REQUIRED_TOOLS.join(",")
  ) {
    throw new Error("Live configuration does not match the restricted single-principal rollout profile.");
  }

  const tempDataDir = mkdtempSync(path.join(os.tmpdir(), "hitch-restricted-profile-"));
  const runtime = new SessionRuntimeStore(tempDataDir);
  const guardPath = runtime.provisionCredentialGuard(path.resolve("runtime/credential-guard.mjs"));
  const sessionId = randomUUID();
  const security = runtime.materialize(principalId, sessionId, loaded.defaultCwd, policy, roots, {
    agentConfig: { hostPath: loaded.piSystemConfigRoot, mode: "rw" },
    credentialGuard: { hostPath: guardPath },
  });
  const now = new Date().toISOString();
  const session: HubSession = {
    id: sessionId,
    ownerPrincipalId: principalId,
    visibility: "private",
    platform: "fake",
    chatId: "restricted-profile",
    userId: principalId,
    agent: "pi",
    cwd: loaded.defaultCwd,
    ...security,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  const config = {
    ...loaded,
    data_dir: tempDataDir,
    dataDir: tempDataDir,
    piCredentialGuardPath: guardPath,
  };
  const backend = new PiRpcBackend(config);
  try {
    await backend.start(session, new AgentToolBridge().contextFor(session));
    if (!backend.isAlive()) {
      throw new Error("Restricted Pi worker exited after startup attestation.");
    }
    const model = await backend.executeCommand?.({ raw: "/model" });
    if (!model?.text?.startsWith("Current model:")) {
      throw new Error("Restricted Pi worker did not complete its RPC state check.");
    }
    process.stdout.write(
      `Restricted profile smoke ok: principal=${principalId} workspace=${loaded.defaultCwd} tools=${policy.tools.join(",")}\n`,
    );
  } finally {
    await backend.stop();
    rmSync(tempDataDir, { force: true, recursive: true });
  }
}

function configPathFromArgs(args: string[]): string {
  const index = args.indexOf("--config");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    throw new Error("Usage: restricted-profile --config <path>");
  }
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import type { AgentEvent } from "../agents/types.js";
import type { ChannelAdapter, OutboundArtifact } from "../channels/types.js";
import { loadConfig } from "../config/load-config.js";
import { AuditLog } from "../core/audit-log.js";
import { HubToolService } from "../core/hub-tools.js";
import { AgentToolBridge } from "../core/tool-bridge.js";
import type { ChatTarget, HubSession } from "../core/types.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";

const REQUIRED_TOOLS = ["read", "write", "edit", "ls", "hitch_send_media"];
const FLOW_TIMEOUT_MS = 5 * 60 * 1_000;

async function main(): Promise<void> {
  const configPath = configPathFromArgs(process.argv.slice(2));
  const loaded = loadConfig(configPath);
  const principalEntry = Object.entries(loaded.users)[0];
  if (Object.keys(loaded.users).length !== 1 || !principalEntry) {
    throw new Error("Restricted agent flow requires exactly one configured principal.");
  }
  const [principalId, principal] = principalEntry;
  const roots = loaded.principalRoots[principalId];
  const policy = principal.execution_policy ?? loaded.agents.pi.execution_policy;
  if (!roots || roots.length !== 1 || !loaded.defaultCwd || !loaded.piSystemConfigRoot || !policy) {
    throw new Error("Restricted agent flow requires one root, a default cwd, system Pi config, and a policy.");
  }
  assertRestrictedPolicy(loaded.agents.pi.config_scope, loaded.agents.pi.credential_isolation, policy);

  const testRoot = mkdtempSync(path.join(loaded.defaultCwd, ".hitch-restricted-soak-"));
  const testRootRelative = path.relative(loaded.defaultCwd, testRoot).split(path.sep).join("/");
  const artifactRelative = `${testRootRelative}/artifact.txt`;
  const escapedRelative = `${testRootRelative}/outside-link`;
  symlinkSync("/etc/passwd", path.join(testRoot, "outside-link"));

  const tempDataDir = mkdtempSync(path.join(os.tmpdir(), "hitch-restricted-agent-flow-"));
  const runtime = new SessionRuntimeStore(tempDataDir);
  const guardPath = runtime.provisionCredentialGuard(path.resolve("runtime/credential-guard.mjs"));
  const sessionId = randomUUID();
  const security = runtime.materialize(principalId, sessionId, loaded.defaultCwd, policy, roots, {
    agentConfig: { hostPath: loaded.piSystemConfigRoot, mode: "rw" },
    credentialGuard: { hostPath: guardPath },
  });
  const now = new Date().toISOString();
  const target: ChatTarget = { platform: "fake", chatId: "restricted-agent-flow", userId: principalId };
  const session: HubSession = {
    id: sessionId,
    ownerPrincipalId: principalId,
    visibility: "private",
    ...target,
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
  const deliveredArtifacts: Array<{ content: string; kind: string }> = [];
  const channel: ChannelAdapter = {
    async *receive() {},
    async sendText() {},
    async sendArtifact(_target, artifact: OutboundArtifact) {
      deliveredArtifacts.push({ content: readFileSync(artifact.path, "utf8"), kind: artifact.kind });
    },
  };
  const audit = new AuditLog(tempDataDir, { maxBytes: 1024 * 1024, maxFiles: 2 });
  const tools = new HubToolService(config, channel, audit);
  const bridge = new AgentToolBridge();
  const toolContext = bridge.contextFor(session);
  const backend = new PiRpcBackend(config);
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  let pumpTail = Promise.resolve();
  try {
    await backend.start(session, toolContext);
    pumpTimer = setInterval(() => {
      pumpTail = pumpTail.then(() => bridge.processPending(toolContext, session, target, tools));
    }, 25);
    await backend.send({
      text: [
        "Perform this restricted Hitch acceptance flow exactly, using tools rather than describing the steps:",
        `1. List the workspace root with ls.`,
        `2. Write ${artifactRelative} with the exact text: restricted soak alpha`,
        `3. Read ${artifactRelative}.`,
        `4. Edit that file, replacing alpha with omega, then read it again.`,
        `5. Attempt to read ${escapedRelative}; it must be blocked. Do not retry it another way.`,
        "6. Attempt to read /agent-config/auth.json; it must be blocked. Do not retry it another way.",
        `7. Call hitch_send_media for ${artifactRelative} as a file with caption Restricted guard soak.`,
        "8. Finish with the exact marker RESTRICTED_SOAK_OK.",
        "Do not access any other path and do not include file contents in the final response.",
      ].join("\n"),
    });
    const events = await collectTurnEvents(backend.events(), FLOW_TIMEOUT_MS);
    const final = events.findLast((event): event is Extract<AgentEvent, { type: "final" }> => event.type === "final");
    const toolNames = new Set(
      events.filter((event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call")
        .map((event) => event.name),
    );
    const blockedReads = events.filter(
      (event) => event.type === "tool_result" && event.name === "read" && event.succeeded === false,
    ).length;
    const artifactPath = path.join(testRoot, "artifact.txt");
    if (!final?.text.includes("RESTRICTED_SOAK_OK") || final.failed) {
      throw new Error("Restricted agent flow did not return its success marker.");
    }
    if (REQUIRED_TOOLS.some((tool) => !toolNames.has(tool))) {
      throw new Error(`Restricted agent flow did not exercise every allowed tool: ${[...toolNames].join(",")}`);
    }
    if (blockedReads < 2) {
      throw new Error(`Restricted agent flow observed only ${blockedReads} blocked read result(s).`);
    }
    if (!existsSync(artifactPath) || readFileSync(artifactPath, "utf8").trim() !== "restricted soak omega") {
      throw new Error("Restricted agent flow did not create and edit the expected workspace artifact.");
    }
    if (deliveredArtifacts.length !== 1 || deliveredArtifacts[0]?.content.trim() !== "restricted soak omega") {
      throw new Error("Restricted agent flow did not deliver the immutable edited artifact snapshot.");
    }
    process.stdout.write(
      `Restricted agent flow ok: tools=${[...toolNames].join(",")} blocked_reads=${blockedReads} media=${deliveredArtifacts.length}\n`,
    );
  } finally {
    if (pumpTimer) {
      clearInterval(pumpTimer);
    }
    await pumpTail;
    await backend.stop();
    await audit.drain();
    rmSync(tempDataDir, { force: true, recursive: true });
    rmSync(testRoot, { force: true, recursive: true });
  }
}

function assertRestrictedPolicy(
  configScope: "hitch" | "system",
  credentialIsolation: "required" | "disabled",
  policy: HubSession["executionPolicy"],
): void {
  if (
    configScope !== "system" ||
    credentialIsolation !== "required" ||
    policy.filesystem !== "workspace-write" ||
    policy.mounts.length !== 0 ||
    policy.process ||
    policy.agent_network !== "allow" ||
    policy.sandbox !== "required" ||
    policy.tools.join(",") !== REQUIRED_TOOLS.join(",")
  ) {
    throw new Error("Live configuration does not match the restricted single-principal rollout profile.");
  }
}

async function collectTurnEvents(events: AsyncIterable<AgentEvent>, timeoutMs: number): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await nextBefore(iterator, remaining, timeoutMs);
    if (next.done) {
      break;
    }
    collected.push(next.value);
    if (next.value.type === "final") {
      return collected;
    }
  }
  throw new Error("Restricted agent flow ended without a final event.");
}

function configPathFromArgs(args: string[]): string {
  const index = args.indexOf("--config");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    throw new Error("Usage: restricted-agent-flow --config <path>");
  }
  return value;
}

function nextBefore(
  iterator: AsyncIterator<AgentEvent>,
  remainingMs: number,
  timeoutMs: number,
): Promise<IteratorResult<AgentEvent>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Restricted agent flow timed out after ${timeoutMs}ms.`)),
      remainingMs,
    );
    void iterator.next().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

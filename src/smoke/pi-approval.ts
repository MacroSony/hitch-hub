import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "../channels/types.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget } from "../core/types.js";
import type { HubConfig } from "../config/schema.js";

type Decision = "allowed" | "denied";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class ApprovalSmokeChannel implements ChannelAdapter {
  readonly sentTexts: string[] = [];
  private readonly target: ChatTarget = {
    platform: "fake",
    chatId: "approval-smoke",
    userId: "approval-smoke-user",
  };
  private readonly sessionReady = deferred<void>();
  private readonly approvalId = deferred<string>();
  private readonly decisionRecorded = deferred<void>();
  private readonly statusChecked = deferred<void>();
  private readonly completed = deferred<void>();
  private decisionSubmitted = false;
  private statusRequested = false;
  private completedSeen = false;

  constructor(private readonly decision: Decision) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    await withTimeout(this.sessionReady.promise, 5_000, "Timed out waiting for session creation");

    yield this.event("/timed");

    const approvalId = await withTimeout(this.approvalId.promise, 8_000, "Timed out waiting for approval request");
    this.decisionSubmitted = true;
    yield this.event(`${this.decision === "allowed" ? "!approve" : "!deny"} ${approvalId}`);
    await withTimeout(this.decisionRecorded.promise, 5_000, "Timed out waiting for approval decision");

    this.statusRequested = true;
    yield this.event("!status");
    await withTimeout(this.statusChecked.promise, 5_000, "Timed out waiting for post-approval status");

    await withTimeout(this.completed.promise, 12_000, "Timed out waiting for Pi to finish after approval decision");
    yield this.event("!abort");
  }

  async sendText(target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    const label = `${target.platform}:${target.chatId}`;
    process.stdout.write(`[${label}] ${text}\n`);
    this.sentTexts.push(text);

    if (text.startsWith("Created session ")) {
      this.sessionReady.resolve();
      return;
    }

    const approvalMatch = /^Approval requested: ([0-9a-f-]+)/i.exec(text.trim());
    if (approvalMatch?.[1]) {
      this.approvalId.resolve(approvalMatch[1]);
      return;
    }

    const decisionText = /^Approval [0-9a-f-]+ (allowed|denied)\.$/i.test(text.trim());
    if (this.decisionSubmitted && decisionText) {
      this.decisionRecorded.resolve();
      return;
    }

    if (this.statusRequested && text.startsWith("Session ")) {
      if (text.includes("status: waiting_approval")) {
        this.statusChecked.reject(new Error("Session still reported waiting_approval after approval decision."));
        return;
      }
      this.statusChecked.resolve();
      if (this.completedSeen) {
        this.completed.resolve();
      }
      return;
    }

    if (this.decisionSubmitted) {
      this.completedSeen = true;
      if (this.statusRequested) {
        this.completed.resolve();
      }
    }
  }

  private event(text: string): InboundChatEvent {
    return {
      id: crypto.randomUUID(),
      target: this.target,
      text,
      receivedAt: new Date().toISOString(),
    };
  }
}

async function main(): Promise<void> {
  const extensionPath = resolvePiExampleExtension("timed-confirm.ts");
  await runScenario(extensionPath, "allowed");
  await runScenario(extensionPath, "denied");
}

async function runScenario(extensionPath: string, decision: Decision): Promise<void> {
  const dataDir = path.resolve(`examples/.remote-agent-hub-approval-smoke-${decision}`);
  rmSync(dataDir, { force: true, recursive: true });

  const config: HubConfig = {
    data_dir: dataDir,
    dataDir,
    default_cwd: path.resolve("."),
    defaultCwd: path.resolve("."),
    agent_turn_timeout_ms: 20_000,
    worker_idle_timeout_ms: 30 * 60 * 1000,
    approval_timeout_ms: 20_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
      auto_discovery: false,
      outbound_roots: [],
    },
    delivery: {
      full_tool_output: false,
      tool_status_mode: "all",
      tool_status_batch_ms: 0,
      checkpoint_batch_ms: 0,
      checkpoint_max_wait_ms: 0,
      checkpoint_max_digests_per_turn: 3,
      checkpoint_max_chars: 1_000,
      send_timeout_ms: 5_000,
      queue_ttl_ms: 5 * 60 * 1000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
    allowedRoots: [path.resolve(".")],
    principalRoots: { smoke: [path.resolve(".")] },
    outboundRoots: [],
    users: {
      smoke: {
        telegram_ids: [],
        wechat_ids: [],
        allowed_roots: [path.resolve(".")],
      },
    },
    channels: {
      fake: { enabled: true },
      telegram: {
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
        unsafe_allow_all: false,
      },
      wechat: {
        enabled: false,
        allowed_chat_ids: [],
        bot_type: "3",
        send_min_interval_ms: 4_000,
        failure_cooldown_ms: 60_000,
        unsafe_allow_all: false,
      },
    },
    agents: {
      pi: {
        command: "pi",
        config_scope: "hitch",
        credential_isolation: "disabled",
        default_args: ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
        default_policy: "ask",
      },
    },
  };

  const channel = new ApprovalSmokeChannel(decision);
  const hub = new RemoteAgentHub(config, channel);
  await hub.run();

  const expectedDecisionText = new RegExp(`^Approval [0-9a-f-]+ ${decision}\\.$`, "i");
  if (!channel.sentTexts.some((text) => /^Approval requested: [0-9a-f-]+/i.test(text.trim()))) {
    throw new Error(`Approval ${decision} smoke did not receive an approval request.`);
  }
  if (!channel.sentTexts.some((text) => expectedDecisionText.test(text.trim()))) {
    throw new Error(`Approval ${decision} smoke did not record the decision.`);
  }
  if (channel.sentTexts.some((text) => text.startsWith("Session ") && text.includes("status: waiting_approval"))) {
    throw new Error(`Approval ${decision} smoke left the session waiting_approval after the decision.`);
  }

  rmSync(dataDir, { force: true, recursive: true });
  process.stdout.write(`Pi approval ${decision} smoke ok\n`);
}

function resolvePiExampleExtension(filename: string): string {
  const piPath = findPiCommand();
  const resolvedPiPath = realpathSync(piPath);
  const packageRoot = path.dirname(path.dirname(resolvedPiPath));
  const extensionPath = path.join(packageRoot, "examples", "extensions", filename);
  if (!existsSync(extensionPath)) {
    throw new Error(`Pi example extension not found: ${extensionPath}`);
  }
  return extensionPath;
}

function findPiCommand(): string {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], {
    encoding: "utf8",
  });
  const [piPath] = result.stdout.split(/\r?\n/).filter(Boolean);
  if (result.status !== 0 || !piPath) {
    throw new Error("Pi command not found on PATH.");
  }
  return piPath;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

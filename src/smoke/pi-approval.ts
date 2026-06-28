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
  private readonly completed = deferred<void>();
  private decisionSubmitted = false;

  constructor(private readonly decision: Decision) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    await withTimeout(this.sessionReady.promise, 5_000, "Timed out waiting for session creation");

    yield this.event("/timed");

    const approvalId = await withTimeout(this.approvalId.promise, 8_000, "Timed out waiting for approval request");
    this.decisionSubmitted = true;
    yield this.event(`${this.decision === "allowed" ? "!approve" : "!deny"} ${approvalId}`);

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

    const approvalMatch = /^Approval requested: ([0-9a-f-]+)$/i.exec(text.trim());
    if (approvalMatch?.[1]) {
      this.approvalId.resolve(approvalMatch[1]);
      return;
    }

    if (this.decisionSubmitted && !/^Approval [0-9a-f-]+ (allowed|denied)\.$/i.test(text.trim())) {
      this.completed.resolve();
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
    allowedRoots: [path.resolve(".")],
    users: {
      smoke: {
        telegram_ids: [],
        allowed_roots: [path.resolve(".")],
      },
    },
    channels: {
      fake: { enabled: true },
      telegram: {
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
      },
    },
    agents: {
      pi: {
        command: "pi",
        config_scope: "hitch",
        default_args: ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath],
        default_policy: "ask",
      },
    },
  };

  const channel = new ApprovalSmokeChannel(decision);
  const hub = new RemoteAgentHub(config, channel);
  await hub.run();

  const expectedDecisionText = new RegExp(`^Approval [0-9a-f-]+ ${decision}\\.$`, "i");
  if (!channel.sentTexts.some((text) => /^Approval requested: [0-9a-f-]+$/i.test(text.trim()))) {
    throw new Error(`Approval ${decision} smoke did not receive an approval request.`);
  }
  if (!channel.sentTexts.some((text) => expectedDecisionText.test(text.trim()))) {
    throw new Error(`Approval ${decision} smoke did not record the decision.`);
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

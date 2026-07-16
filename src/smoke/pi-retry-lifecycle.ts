import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { HubConfig } from "../config/schema.js";
import { DeliveryStore } from "../core/delivery-store.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget } from "../core/types.js";
import { UNSAFE_DIRECT_EXECUTION_POLICY } from "../security/policy.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4WQAAAAASUVORK5CYII=",
  "base64",
);

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

class RetryLifecycleChannel implements ChannelAdapter {
  readonly texts: string[] = [];
  readonly artifacts: OutboundArtifact[] = [];
  readonly artifactBytes: Buffer[] = [];
  private readonly target: ChatTarget = { platform: "fake", chatId: "pi-retry", userId: "pi-retry-user" };
  private readonly sessionReady = deferred<void>();
  private readonly artifactSeen = deferred<void>();
  private readonly finalSeen = deferred<void>();
  private readonly partialSeen = deferred<void>();
  private readonly mediaFailureSeen = deferred<void>();

  constructor(private readonly settledMarker: string) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    await withTimeout(this.sessionReady.promise, 5_000, "Timed out waiting for retry smoke session creation");
    yield this.event("retry, send media, then finish");
    await withTimeout(
      Promise.all([this.artifactSeen.promise, this.finalSeen.promise]),
      5_000,
      "Timed out waiting for the retried turn to send media and settle",
    );
    await sleep(50);
    yield this.event("stream a partial response, then abort");
    await withTimeout(this.partialSeen.promise, 5_000, "Timed out waiting for the streamed partial response");
    await sleep(50);
    yield this.event("report a failed media tool result");
    await withTimeout(this.mediaFailureSeen.promise, 5_000, "Timed out waiting for failed media tool status");
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    this.texts.push(text);
    if (text.startsWith("Created session ")) {
      this.sessionReady.resolve();
    }
    if (text === "retry recovered") {
      if (!existsSync(this.settledMarker)) {
        this.finalSeen.reject(new Error("Recovered final was delivered before Pi emitted agent_settled."));
        return;
      }
      this.finalSeen.resolve();
    }
    if (text === "streamed partial survived") {
      this.partialSeen.resolve();
    }
    if (text === "Tool finished: hitch.send_media (failed)\nMedia delivery failed: rejected by hub") {
      this.mediaFailureSeen.resolve();
    }
    if (text === "Pi completed." || text === "Pi finished without a final response.") {
      this.finalSeen.reject(new Error(`Premature empty completion was delivered: ${text}`));
    }
  }

  async sendArtifact(_target: ChatTarget, artifact: OutboundArtifact): Promise<void> {
    this.artifacts.push(artifact);
    this.artifactBytes.push(readFileSync(artifact.path));
    this.artifactSeen.resolve();
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
  const dataDir = path.resolve(
    "examples/.remote-agent-hub-smoke",
    `pi-retry-lifecycle-${process.pid}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const artifactPath = path.join(dataDir, "retry.png");
  const settledMarker = path.join(dataDir, "agent-settled.marker");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(artifactPath, PNG_1X1);

  const channel = new RetryLifecycleChannel(settledMarker);
  const hub = new RemoteAgentHub(retryConfig(dataDir, artifactPath, settledMarker), channel);
  await hub.run();

  if (
    channel.artifacts.length !== 1 ||
    channel.artifactBytes.length !== 1 ||
    !channel.artifactBytes[0]?.equals(PNG_1X1) ||
    channel.artifacts[0]?.path === artifactPath
  ) {
    throw new Error(`Retry smoke media delivery mismatch: ${JSON.stringify(channel.artifacts)}`);
  }
  if (channel.texts.filter((text) => text === "retry recovered").length !== 1) {
    throw new Error(`Expected exactly one recovered final response: ${JSON.stringify(channel.texts)}`);
  }
  if (channel.texts.some((text) => text === "Pi completed." || text === "Pi finished without a final response.")) {
    throw new Error(`An empty-completion placeholder escaped into chat: ${JSON.stringify(channel.texts)}`);
  }
  if (!channel.texts.includes("Tool started: hitch.send_media")) {
    throw new Error(`Expected targeted media tool-start visibility in failures mode: ${JSON.stringify(channel.texts)}`);
  }
  if (!channel.texts.includes("Tool finished: hitch.send_media (succeeded)")) {
    throw new Error(`Expected targeted media tool-result visibility in failures mode: ${JSON.stringify(channel.texts)}`);
  }

  const auditRows = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { type?: string; sessionId?: string; details?: { turnId?: string; status?: string } });
  const artifactAudit = auditRows.find((row) => row.type === "artifact.delivery") as
    | { sessionId?: string; details?: { deliveryId?: string; turnId?: string; status?: string } }
    | undefined;
  if (
    !artifactAudit?.sessionId ||
    !artifactAudit.details?.deliveryId ||
    !artifactAudit.details.turnId ||
    artifactAudit.details.status !== "sent"
  ) {
    throw new Error(`Artifact audit was not correlated to the retried turn: ${JSON.stringify(artifactAudit)}`);
  }
  const store = new DeliveryStore(dataDir);
  const delivery = store.get(artifactAudit.details.deliveryId);
  store.close();
  if (
    delivery?.status !== "sent" ||
    delivery.sessionId !== artifactAudit.sessionId ||
    delivery.turnId !== artifactAudit.details.turnId
  ) {
    throw new Error(`Durable artifact delivery lost retry turn correlation: ${JSON.stringify(delivery)}`);
  }
  const completed = auditRows.filter((row) => row.type === "turn.completed");
  if (completed.length !== 3) {
    throw new Error(`Retry lifecycle produced ${completed.length} completed turns instead of three.`);
  }

  rmSync(dataDir, { force: true, recursive: true });
  process.stdout.write("Pi retry lifecycle smoke ok\n");
}

function retryConfig(dataDir: string, artifactPath: string, settledMarker: string): HubConfig {
  const cwd = path.resolve(".");
  const artifactRequestPath = path.relative(cwd, artifactPath).split(path.sep).join(path.posix.sep);
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
    agent_turn_timeout_ms: 5_000,
    worker_idle_timeout_ms: 30 * 60 * 1000,
    approval_timeout_ms: 5_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
      auto_discovery: false,
      outbound_roots: [dataDir],
    },
    delivery: {
      full_tool_output: false,
      tool_status_mode: "failures",
      tool_status_batch_ms: 0,
      send_timeout_ms: 2_000,
      queue_ttl_ms: 5_000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
    allowedRoots: [cwd, dataDir],
    principalRoots: { smoke: [cwd, dataDir] },
    outboundRoots: [dataDir],
    users: {
      smoke: {
        telegram_ids: [],
        wechat_ids: [],
        allowed_roots: [cwd, dataDir],
        execution_policy: UNSAFE_DIRECT_EXECUTION_POLICY,
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
        send_min_interval_ms: 0,
        failure_cooldown_ms: 0,
        unsafe_allow_all: false,
      },
    },
    agents: {
      pi: {
        command: process.execPath,
        default_args: [
          "--input-type=module",
          "-e",
          fakePiRpcScript(artifactRequestPath, settledMarker),
          "--",
          "--no-session",
        ],
        default_policy: "ask",
        config_scope: "hitch",
        credential_isolation: "disabled",
      },
    },
  };
}

function fakePiRpcScript(artifactRequestPath: string, settledMarker: string): string {
  return `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const artifactRequestPath = ${JSON.stringify(artifactRequestPath)};
const settledMarker = ${JSON.stringify(settledMarker)};
const rl = readline.createInterface({ input: process.stdin });
let promptCount = 0;
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

rl.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type !== "prompt") {
    return;
  }
  promptCount += 1;

  if (promptCount === 2) {
    send({ type: "agent_start" });
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed partial survived" } });
    send({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted", content: [] }]
    });
    setTimeout(() => send({ type: "agent_settled" }), 50);
    return;
  }

  if (promptCount === 3) {
    send({ type: "agent_start" });
    send({
      type: "tool_execution_end",
      toolName: "hitch_send_media",
      isError: true,
      result: { content: [{ type: "text", text: "Media delivery failed: rejected by hub" }] }
    });
    send({
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "failure acknowledged" }] }]
    });
    setTimeout(() => send({ type: "agent_settled" }), 50);
    return;
  }

  send({ type: "agent_start" });
  send({
    type: "agent_end",
    willRetry: true,
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed", content: [] }]
  });

  setTimeout(() => {
    send({ type: "agent_start" });
    const requestId = "retry-media";
    const args = { path: artifactRequestPath, caption: "retry bridge", kind: "image" };
    send({ type: "tool_execution_start", toolName: "hitch_send_media", args });
    appendFileSync(process.env.HITCH_TOOL_OUTBOX, JSON.stringify({
      id: requestId,
      type: "send_media",
      token: process.env.HITCH_TOOL_TOKEN,
      ...args
    }) + "\\n", "utf8");

    const resultPath = path.join(process.env.HITCH_TOOL_RESULT_DIR, requestId + ".json");
    const resultPoll = setInterval(() => {
      if (!existsSync(resultPath)) {
        return;
      }
      clearInterval(resultPoll);
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      send({
        type: "tool_execution_end",
        toolName: "hitch_send_media",
        isError: result.status !== "sent",
        result: { content: [{ type: "text", text: "Media sent to fake: retry.png" }] }
      });
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "retry recovered" } });
      send({
        type: "agent_end",
        willRetry: false,
        messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "retry recovered" }] }]
      });
      setTimeout(() => {
        writeFileSync(settledMarker, "settled\\n", "utf8");
        send({ type: "agent_settled" });
      }, 200);
    }, 10);
  }, 50);
});
`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

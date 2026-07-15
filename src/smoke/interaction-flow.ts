import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type {
  AgentBackend,
  AgentCommandInput,
  AgentCommandResult,
  AgentEvent,
  AgentInput,
  AgentSelectionInput,
} from "../agents/types.js";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { HubConfig } from "../config/schema.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget, HubSession } from "../core/types.js";

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

class InteractionSmokeChannel implements ChannelAdapter {
  readonly sentTexts: string[] = [];
  readonly artifacts: OutboundArtifact[] = [];
  private readonly target: ChatTarget = {
    platform: "fake",
    chatId: "interaction-flow",
    userId: "interaction-user",
  };
  private readonly firstSessionCreated = deferred<void>();
  private readonly secondSessionCreated = deferred<void>();
  private readonly sessionMenuShown = deferred<void>();
  private readonly sessionSwitched = deferred<void>();
  private readonly agentMenuShown = deferred<void>();
  private readonly agentNextPageShown = deferred<void>();
  private readonly agentPreviousPageShown = deferred<void>();
  private readonly agentChoiceSelected = deferred<void>();
  private readonly liveAgentMenuShown = deferred<void>();
  private readonly liveAgentChoiceSelected = deferred<void>();
  private createdCount = 0;
  private firstAgentPageCount = 0;

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi --name first");
    await withTimeout(this.firstSessionCreated.promise, 5_000, "Timed out waiting for first session");

    yield this.event("!new pi --name second");
    await withTimeout(this.secondSessionCreated.promise, 5_000, "Timed out waiting for second session");

    yield this.event("!sessions");
    await withTimeout(this.sessionMenuShown.promise, 5_000, "Timed out waiting for session menu");

    yield this.event("1");
    await withTimeout(this.sessionSwitched.promise, 5_000, "Timed out waiting for session switch");

    yield this.event("/choose");
    await withTimeout(this.agentMenuShown.promise, 5_000, "Timed out waiting for agent menu");

    yield this.event("n");
    await withTimeout(this.agentNextPageShown.promise, 5_000, "Timed out waiting for agent menu next page");

    yield this.event("p");
    await withTimeout(this.agentPreviousPageShown.promise, 5_000, "Timed out waiting for agent menu previous page");

    yield this.event("0");
    await withTimeout(this.agentChoiceSelected.promise, 5_000, "Timed out waiting for agent selection");

    yield this.event("needs live choice");
    await withTimeout(this.liveAgentMenuShown.promise, 5_000, "Timed out waiting for live agent menu");

    yield this.event("0");
    await withTimeout(this.liveAgentChoiceSelected.promise, 5_000, "Timed out waiting for live agent selection");
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    this.sentTexts.push(text);

    if (text.startsWith("Created session ") || text.startsWith("Created and switched to session ")) {
      this.createdCount += 1;
      if (this.createdCount === 1) {
        this.firstSessionCreated.resolve();
      } else if (this.createdCount === 2) {
        this.secondSessionCreated.resolve();
      }
      return;
    }

    if (text.startsWith("Select session") && text.includes("0.") && text.includes("1.")) {
      this.sessionMenuShown.resolve();
      return;
    }

    if (text.startsWith("Switched to session ")) {
      this.sessionSwitched.resolve();
      return;
    }

    if (
      text.startsWith("Pick backend option") &&
      text.includes("(1/2)") &&
      text.includes("0. alpha") &&
      text.includes("9. kappa") &&
      text.includes("n. Next page") &&
      text.includes("p. Previous page")
    ) {
      this.firstAgentPageCount += 1;
      if (this.firstAgentPageCount === 1) {
        this.agentMenuShown.resolve();
      } else {
        this.agentPreviousPageShown.resolve();
      }
      return;
    }

    if (text.startsWith("Pick backend option") && text.includes("(2/2)") && text.includes("0. lambda")) {
      this.agentNextPageShown.resolve();
      return;
    }

    if (text === "Choice selected: alpha") {
      this.agentChoiceSelected.resolve();
      return;
    }

    if (text.startsWith("Pick live option") && text.includes("0. red")) {
      this.liveAgentMenuShown.resolve();
      return;
    }

    if (text === "Live choice selected: red") {
      this.liveAgentChoiceSelected.resolve();
    }
  }

  async sendArtifact(_target: ChatTarget, artifact: OutboundArtifact, _opts?: SendOptions): Promise<void> {
    this.artifacts.push(artifact);
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

class InteractionSmokeBackend implements AgentBackend {
  private livePromptReceived = false;
  private readonly liveSelection = deferred<void>();

  async start(_session: HubSession): Promise<number | undefined> {
    return process.pid;
  }

  async send(input: AgentInput): Promise<void> {
    if (input.text !== "needs live choice") {
      throw new Error(`Unexpected prompt: ${input.text}`);
    }
    this.livePromptReceived = true;
  }

  async executeCommand(input: AgentCommandInput): Promise<AgentCommandResult> {
    if (input.raw !== "/choose") {
      throw new Error(`Unexpected command: ${input.raw}`);
    }

    return {
      interaction: {
        kind: "fake.choice",
        title: "Pick backend option",
        options: [
          { label: "alpha", value: { id: "alpha" } },
          { label: "beta", value: { id: "beta" } },
          { label: "gamma", value: { id: "gamma" } },
          { label: "delta", value: { id: "delta" } },
          { label: "epsilon", value: { id: "epsilon" } },
          { label: "zeta", value: { id: "zeta" } },
          { label: "eta", value: { id: "eta" } },
          { label: "theta", value: { id: "theta" } },
          { label: "iota", value: { id: "iota" } },
          { label: "kappa", value: { id: "kappa" } },
          { label: "lambda", value: { id: "lambda" } },
        ],
      },
    };
  }

  async executeSelection(input: AgentSelectionInput): Promise<AgentCommandResult> {
    if (input.kind === "fake.live.choice" && isRecord(input.value) && input.value.id === "red") {
      this.liveSelection.resolve();
      return { text: "Live selection submitted" };
    }

    if (input.kind !== "fake.choice" || !isRecord(input.value) || input.value.id !== "alpha") {
      throw new Error("Unexpected selection payload.");
    }
    return { text: "Choice selected: alpha" };
  }

  async *events(): AsyncIterable<AgentEvent> {
    if (!this.livePromptReceived) {
      return;
    }

    yield { type: "status", state: "running" };
    yield {
      type: "interaction_request",
      interaction: {
        kind: "fake.live.choice",
        title: "Pick live option",
        options: [
          { label: "red", value: { id: "red" } },
          { label: "blue", value: { id: "blue" } },
        ],
      },
    };
    await this.liveSelection.promise;
    yield { type: "final", text: "Live choice selected: red" };
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {}
}

async function main(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke", "interaction-flow");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const channel = new InteractionSmokeChannel();
  const backend = new InteractionSmokeBackend();
  const hub = new RemoteAgentHub(interactionSmokeConfig(dataDir), channel, () => backend);
  await hub.run();

  if (!channel.sentTexts.some((text) => text.startsWith("Select session"))) {
    throw new Error("Session selection menu was not rendered.");
  }
  if (!channel.sentTexts.includes("Choice selected: alpha")) {
    throw new Error("Agent selection was not resolved.");
  }
  if (!channel.sentTexts.includes("Live choice selected: red")) {
    throw new Error("Live agent selection was not resolved.");
  }

  process.stdout.write("Interaction flow smoke ok\n");
}

function interactionSmokeConfig(dataDir: string): HubConfig {
  const cwd = path.resolve(".");
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
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
      send_timeout_ms: 5_000,
      queue_ttl_ms: 5 * 60 * 1000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
    allowedRoots: [cwd],
    outboundRoots: [],
    users: {
      smoke: {
        telegram_ids: [],
        wechat_ids: [],
        allowed_roots: [cwd],
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
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
        config_scope: "hitch",
      },
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

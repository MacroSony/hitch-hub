import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { ChannelAdapter, InboundChatEvent, SendOptions } from "../channels/types.js";
import type { HubConfig } from "../config/schema.js";
import { RemoteAgentHub } from "../core/hub.js";
import type { ChatTarget } from "../core/types.js";

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

class PiUiSelectSmokeChannel implements ChannelAdapter {
  readonly sentTexts: string[] = [];
  private readonly target: ChatTarget = {
    platform: "fake",
    chatId: "pi-ui-select-smoke",
    userId: "pi-ui-select-user",
  };
  private readonly sessionReady = deferred<void>();
  private readonly menuShown = deferred<void>();
  private readonly finalSeen = deferred<void>();
  private readonly editorShown = deferred<void>();
  private readonly statusChecked = deferred<void>();

  async *receive(): AsyncIterable<InboundChatEvent> {
    yield this.event("!new pi");
    await withTimeout(this.sessionReady.promise, 5_000, "Timed out waiting for session creation");

    yield this.event("show select");
    await withTimeout(this.menuShown.promise, 5_000, "Timed out waiting for Pi UI select menu");

    yield this.event("1");
    await withTimeout(this.finalSeen.promise, 5_000, "Timed out waiting for selected Pi UI response");

    yield this.event("show editor");
    await withTimeout(this.editorShown.promise, 5_000, "Timed out waiting for Pi UI editor display");

    yield this.event("!status");
    await withTimeout(this.statusChecked.promise, 5_000, "Timed out waiting for idle status after Pi UI editor");
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    this.sentTexts.push(text);

    if (text.startsWith("Created session ")) {
      this.sessionReady.resolve();
      return;
    }

    if (text.startsWith("Pick color") && text.includes("0. Red") && text.includes("1. Green")) {
      this.menuShown.resolve();
      return;
    }

    if (text === "Selected Green") {
      this.finalSeen.resolve();
      return;
    }

    if (text.startsWith("Pi editor: Prompt stack") && text.includes("Active stack: qiqi-assistant")) {
      this.editorShown.resolve();
      return;
    }

    if (text.startsWith("Session ")) {
      if (text.includes("status: idle")) {
        this.statusChecked.resolve();
        return;
      }
      if (text.includes("status: running") || text.includes("status: waiting_approval")) {
        this.statusChecked.reject(new Error(`Unexpected status after Pi UI editor:\n${text}`));
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
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke", "pi-ui-select");
  const editorResponsePath = path.join(dataDir, "editor-response.txt");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const channel = new PiUiSelectSmokeChannel();
  const hub = new RemoteAgentHub(piUiSelectSmokeConfig(dataDir, editorResponsePath), channel);
  await hub.run();

  if (channel.sentTexts.some((text) => text.startsWith("Approval requested: "))) {
    throw new Error("Pi UI request was incorrectly rendered as an approval request.");
  }
  if (channel.sentTexts.some((text) => text.startsWith("Tool finished: Pi notification"))) {
    throw new Error("Pi notification was incorrectly rendered as a tool result.");
  }
  if (!channel.sentTexts.includes("Selected: Green")) {
    throw new Error("Pi UI select acknowledgement was not sent.");
  }
  if (!channel.sentTexts.includes("Selected Green")) {
    throw new Error("Pi UI select final response was not delivered.");
  }
  if (!channel.sentTexts.includes("Pi notification: picked Green")) {
    throw new Error("Pi notification was not delivered.");
  }
  if (!existsSync(editorResponsePath) || readFileSync(editorResponsePath, "utf8") !== "cancelled:true") {
    throw new Error("Pi UI editor request was not auto-cancelled.");
  }

  rmSync(dataDir, { force: true, recursive: true });
  process.stdout.write("Pi UI select smoke ok\n");
}

function piUiSelectSmokeConfig(dataDir: string, editorResponsePath: string): HubConfig {
  const cwd = path.resolve(".");
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
    agent_turn_timeout_ms: 10_000,
    approval_timeout_ms: 10_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
      auto_discovery: false,
      outbound_roots: [],
    },
    delivery: {
      full_tool_output: false,
      tool_status_batch_ms: 0,
      send_timeout_ms: 5_000,
    },
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
        unsafe_allow_all: false,
      },
    },
    agents: {
      pi: {
        command: process.execPath,
        default_args: ["--input-type=module", "-e", fakePiRpcScript(editorResponsePath), "--", "--no-session"],
        default_policy: "ask",
        config_scope: "hitch",
      },
    },
  };
}

function fakePiRpcScript(editorResponsePath: string): string {
  return `
import { writeFileSync } from "node:fs";
import readline from "node:readline";

const editorResponsePath = ${JSON.stringify(editorResponsePath)};
const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

rl.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    send({ type: "agent_start" });
    send({ type: "turn_start" });
    if (command.message === "show editor") {
      send({
        type: "extension_ui_request",
        id: "editor-1",
        method: "editor",
        title: "Prompt stack",
        prefill: "Active stack: qiqi-assistant\\n\\nCommands:\\n  /preset use <id|none>"
      });
      return;
    }
    send({
      type: "extension_ui_request",
      id: "select-1",
      method: "select",
      title: "Pick color",
      options: ["Red", "Green", "Blue"]
    });
    return;
  }

  if (command.type === "extension_ui_response" && command.id === "select-1") {
    send({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "picked " + String(command.value) });
    send({ type: "agent_end", messages: [{ role: "assistant", content: "Selected " + String(command.value) }] });
    return;
  }

  if (command.type === "extension_ui_response" && command.id === "editor-1") {
    writeFileSync(editorResponsePath, "cancelled:" + String(command.cancelled === true));
    return;
  }

  if (command.type === "abort") {
    process.exit(0);
  }
});
`;
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

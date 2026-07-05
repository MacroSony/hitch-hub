import { mkdirSync } from "node:fs";
import { loadConfig } from "./config/load-config.js";
import { FakeChannelAdapter } from "./channels/fake.js";
import { MultiChannelAdapter } from "./channels/multi.js";
import { TelegramAdapter } from "./channels/telegram.js";
import type { ChannelAdapter } from "./channels/types.js";
import { WeChatAdapter } from "./channels/wechat.js";
import { RemoteAgentHub } from "./core/hub.js";
import { MediaCache } from "./core/media-cache.js";
import type { Platform } from "./core/types.js";

type CliArgs = {
  configPath: string;
  fakeMessages: string[];
};

function parseArgs(argv: string[]): CliArgs {
  let configPath = "examples/config.example.yaml";
  const fakeMessages: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      configPath = value;
      index += 1;
      continue;
    }

    if (arg === "--fake-message") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--fake-message requires text");
      }
      fakeMessages.push(value);
      index += 1;
      continue;
    }
  }

  return { configPath, fakeMessages };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional; fake-adapter and smoke tests don't need it.
  }

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  mkdirSync(config.dataDir, { recursive: true });

  const adapter =
    args.fakeMessages.length > 0
      ? new FakeChannelAdapter(args.fakeMessages)
      : createConfiguredAdapter(config, new MediaCache(config.dataDir));

  const hub = new RemoteAgentHub(config, adapter);
  await hub.run();
}

function createConfiguredAdapter(config: ReturnType<typeof loadConfig>, mediaCache: MediaCache): ChannelAdapter {
  const entries: Array<{ platform: Platform; adapter: ChannelAdapter }> = [];

  const telegram = config.channels.telegram;
  if (telegram.enabled) {
    const token = process.env[telegram.bot_token_env];
    if (!token) {
      throw new Error(`Telegram bot token env var is not set: ${telegram.bot_token_env}`);
    }

    entries.push({
      platform: "telegram",
      adapter: new TelegramAdapter(
        token,
        telegram.allowed_chat_ids,
        mediaCache,
        telegram.unsafe_allow_all,
        config.media.max_inbound_bytes,
      ),
    });
  }

  const wechat = config.channels.wechat;
  if (wechat.enabled) {
    entries.push({
      platform: "wechat",
      adapter: new WeChatAdapter({
        dataDir: config.dataDir,
        mediaCache,
        allowedChatIds: wechat.allowed_chat_ids,
        unsafeAllowAll: wechat.unsafe_allow_all,
        botType: wechat.bot_type,
        maxInboundBytes: config.media.max_inbound_bytes,
      }),
    });
  }

  if (entries.length === 0) {
    throw new Error("No channel configured. Use --fake-message for local smoke tests or enable Telegram or WeChat.");
  }

  const [onlyEntry] = entries;
  return entries.length === 1 && onlyEntry ? onlyEntry.adapter : new MultiChannelAdapter(entries);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { mkdirSync } from "node:fs";
import { loadConfig } from "./config/load-config.js";
import { FakeChannelAdapter } from "./channels/fake.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { RemoteAgentHub } from "./core/hub.js";
import { MediaCache } from "./core/media-cache.js";

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
      : createConfiguredAdapter(config.channels.telegram, new MediaCache(config.dataDir));

  const hub = new RemoteAgentHub(config, adapter);
  await hub.run();
}

function createConfiguredAdapter(telegram: {
  enabled: boolean;
  bot_token_env: string;
  allowed_chat_ids: string[];
}, mediaCache: MediaCache): TelegramAdapter {
  if (!telegram.enabled) {
    throw new Error("No channel configured. Use --fake-message for local smoke tests or enable Telegram.");
  }

  const token = process.env[telegram.bot_token_env];
  if (!token) {
    throw new Error(`Telegram bot token env var is not set: ${telegram.bot_token_env}`);
  }

  return new TelegramAdapter(token, telegram.allowed_chat_ids, mediaCache);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

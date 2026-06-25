import { mkdirSync } from "node:fs";
import { loadConfig } from "./config/load-config.js";
import { FakeChannelAdapter } from "./channels/fake.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { RemoteAgentHub } from "./core/hub.js";

type CliArgs = {
  configPath: string;
  fakeMessage?: string;
};

function parseArgs(argv: string[]): CliArgs {
  let configPath = "examples/config.example.yaml";
  let fakeMessage: string | undefined;

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
      fakeMessage = value;
      index += 1;
      continue;
    }
  }

  return fakeMessage === undefined ? { configPath } : { configPath, fakeMessage };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  mkdirSync(config.dataDir, { recursive: true });

  const adapter =
    args.fakeMessage !== undefined
      ? new FakeChannelAdapter(args.fakeMessage)
      : createConfiguredAdapter(config.channels.telegram);

  const hub = new RemoteAgentHub(config, adapter);
  await hub.run();
}

function createConfiguredAdapter(telegram: { enabled: boolean; bot_token_env: string }): TelegramAdapter {
  if (!telegram.enabled) {
    throw new Error("No channel configured. Use --fake-message for local smoke tests or enable Telegram.");
  }

  const token = process.env[telegram.bot_token_env];
  if (!token) {
    throw new Error(`Telegram bot token env var is not set: ${telegram.bot_token_env}`);
  }

  return new TelegramAdapter(token);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

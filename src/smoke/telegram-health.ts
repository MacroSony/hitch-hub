import { loadConfig } from "../config/load-config.js";

type CliArgs = {
  configPath: string;
  mode: "getMe" | "getUpdates";
};

function parseArgs(argv: string[]): CliArgs {
  let configPath = "examples/config.example.yaml";
  let mode: CliArgs["mode"] = "getMe";

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

    if (arg === "--mode") {
      const value = argv[index + 1];
      if (value !== "getMe" && value !== "getUpdates") {
        throw new Error("--mode must be getMe or getUpdates");
      }
      mode = value;
      index += 1;
    }
  }

  return { configPath, mode };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional; report a clear token-env error below when needed.
  }

  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const tokenEnv = config.channels.telegram.bot_token_env;
  const token = process.env[tokenEnv];
  if (!token) {
    throw new Error(`Telegram bot token env var is not set: ${tokenEnv}`);
  }

  if (args.mode === "getMe") {
    await runGetMe(token);
    return;
  }

  await runGetUpdates(token);
}

async function runGetMe(token: string): Promise<void> {
  const body = await telegramRequest<{
    ok: boolean;
    result?: { id: number; is_bot: boolean; username?: string; can_join_groups?: boolean };
    description?: string;
  }>(token, "getMe");

  if (!body.ok || !body.result) {
    throw new Error(`Telegram getMe failed: ${body.description ?? "unknown error"}`);
  }

  process.stdout.write(
    `Telegram getMe ok: bot=@${body.result.username ?? "(unnamed)"} id=${body.result.id} can_join_groups=${
      body.result.can_join_groups ?? "unknown"
    }\n`,
  );
}

async function runGetUpdates(token: string): Promise<void> {
  const body = await telegramRequest<{
    ok: boolean;
    result?: unknown[];
    description?: string;
  }>(token, "getUpdates", {
    timeout: "0",
    limit: "100",
    allowed_updates: JSON.stringify(["message"]),
  });

  if (!body.ok) {
    throw new Error(`Telegram getUpdates failed: ${body.description ?? "unknown error"}`);
  }

  process.stdout.write(`Telegram getUpdates ok: visible_updates=${body.result?.length ?? 0}\n`);
}

async function telegramRequest<T>(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as T;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

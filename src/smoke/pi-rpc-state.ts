import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config/load-config.js";
import type { HubConfig } from "../config/schema.js";
import { attachJsonlReader } from "../utils/jsonl-reader.js";

type CliArgs = {
  configPath: string;
};

function parseArgs(argv: string[]): CliArgs {
  let configPath = "examples/config.example.yaml";

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      configPath = value;
      index += 1;
    }
  }

  return { configPath };
}

function resolvePiSpawn(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || path.extname(command)) {
    return { command, args };
  }

  const appData = process.env.APPDATA;
  if (!appData) {
    return { command, args };
  }

  const cmdShim = path.join(appData, "npm", `${command}.cmd`);
  if (!existsSync(cmdShim)) {
    return { command, args };
  }

  return {
    command: "cmd.exe",
    args: ["/d", "/c", "call", cmdShim, ...args],
  };
}

function buildPiEnv(config: HubConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (config.agents.pi.config_scope !== "hitch") {
    return env;
  }

  const piAgentDir = path.join(config.dataDir, "pi", "agent");
  const piSessionDir = path.join(config.dataDir, "pi", "sessions");
  mkdirSync(piAgentDir, { recursive: true });
  mkdirSync(piSessionDir, { recursive: true });
  env.PI_CODING_AGENT_DIR = piAgentDir;
  env.PI_CODING_AGENT_SESSION_DIR = piSessionDir;
  env.PI_OFFLINE = process.env.PI_OFFLINE ?? "1";
  return env;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const pi = config.agents.pi;
  const spawnSpec = resolvePiSpawn(pi.command, [...pi.default_args, "--no-session"]);

  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    env: buildPiEnv(config),
    windowsHide: true,
  });

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out waiting for Pi RPC get_state response."));
    }, 10_000);

    attachJsonlReader(
      child.stdout,
      (value) => {
        if (value && typeof value === "object" && (value as Record<string, unknown>).command === "get_state") {
          clearTimeout(timeout);
          child.kill("SIGTERM");
          resolve(value as Record<string, unknown>);
        }
      },
      reject,
    );

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        process.stderr.write(`${text}\n`);
      }
    });

    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Pi RPC exited before get_state response: code=${code} signal=${signal ?? ""}`));
      }
    });

    child.stdin.write(`${JSON.stringify({ id: "smoke-state", type: "get_state" })}\n`);
  });

  process.stdout.write(`Pi RPC get_state success=${String(result.success)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

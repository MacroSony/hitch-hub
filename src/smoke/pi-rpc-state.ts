import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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

type PiSmokeEnvironment = {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
};

function buildPiEnv(config: HubConfig): PiSmokeEnvironment {
  const env = { ...process.env };
  if (config.agents.pi.config_scope !== "hitch") {
    return { env, cleanup: () => undefined };
  }

  // This smoke probes Pi's RPC protocol, not Hitch's persistent-state migration.
  // A private scratch root prevents it from recreating the removed legacy
  // data_dir/pi layout or colliding with repeated hub smoke runs.
  const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "hitch-pi-rpc-"));
  const piAgentDir = path.join(scratchRoot, "agent");
  const piSessionDir = path.join(scratchRoot, "sessions");
  mkdirSync(piAgentDir, { recursive: true });
  mkdirSync(piSessionDir, { recursive: true });
  env.PI_CODING_AGENT_DIR = piAgentDir;
  env.PI_CODING_AGENT_SESSION_DIR = piSessionDir;
  env.PI_OFFLINE = process.env.PI_OFFLINE ?? "1";
  return {
    env,
    cleanup: () => rmSync(scratchRoot, { recursive: true, force: true }),
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      killer.once("error", () => {
        child.kill("SIGTERM");
        finish();
      });
      killer.once("close", finish);
    });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    const giveUpTimer = setTimeout(resolve, 3_000);
    child.once("close", () => {
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const pi = config.agents.pi;
  const spawnSpec = resolvePiSpawn(pi.command, [...pi.default_args, "--no-session"]);
  const smokeEnvironment = buildPiEnv(config);

  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: process.cwd(),
    env: smokeEnvironment.env,
    windowsHide: true,
  });

  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const succeed = (value: Record<string, unknown>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new Error("Timed out waiting for Pi RPC get_state response."));
      }, 10_000);

      attachJsonlReader(
        child.stdout,
        (value) => {
          if (!value || typeof value !== "object") {
            return;
          }
          const response = value as Record<string, unknown>;
          if (response.type !== "response" || response.id !== "smoke-state") {
            return;
          }
          if (response.command !== "get_state" || response.success !== true) {
            fail(new Error(`Pi RPC get_state failed: ${JSON.stringify(response)}`));
            return;
          }
          if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
            fail(new Error("Pi RPC get_state returned no state object."));
            return;
          }
          succeed(response);
        },
        fail,
      );

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text.length > 0) {
          process.stderr.write(`${text}\n`);
        }
      });

      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (!settled) {
          fail(new Error(`Pi RPC exited before get_state response: code=${code ?? ""} signal=${signal ?? ""}`));
        }
      });

      child.stdin.write(`${JSON.stringify({ id: "smoke-state", type: "get_state" })}\n`);
    });

    process.stdout.write(`Pi RPC get_state success=${String(result.success)}\n`);
  } finally {
    await stopChild(child);
    smokeEnvironment.cleanup();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

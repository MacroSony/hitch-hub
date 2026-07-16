import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import { loadConfig } from "../config/load-config.js";
import { configSchema, type HubConfig } from "../config/schema.js";
import type { HubSession } from "../core/types.js";
import { UNSAFE_DIRECT_EXECUTION_POLICY } from "../security/policy.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";
import {
  assertWorkerEnvironmentAllowlist,
  buildWorkerEnvironment,
} from "../security/worker-environment.js";

async function readChildEnvironment(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`Environment smoke child exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, string>;
}

async function main(): Promise<void> {
  const env = buildWorkerEnvironment({
    source: {
      PATH: process.env.PATH,
      LANG: "en_CA.UTF-8",
      HTTP_PROXY: "http://proxy.invalid",
      PROVIDER_API_KEY: "provider-secret",
      TELEGRAM_BOT_TOKEN: "channel-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      DOCKER_HOST: "unix:///tmp/docker.sock",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
      HITCH_TOOL_TOKEN: "parent-token",
      UNLISTED_SECRET: "unlisted-secret",
    },
    allowlist: ["PROVIDER_API_KEY"],
    blockedNames: ["TELEGRAM_BOT_TOKEN"],
    overrides: {
      HITCH_SESSION_ID: "session-id",
      HITCH_TOOL_TOKEN: "scoped-token",
    },
  });
  const childEnv = await readChildEnvironment(env);
  if (
    childEnv.LANG !== "en_CA.UTF-8" ||
    childEnv.HTTP_PROXY !== "http://proxy.invalid" ||
    childEnv.PROVIDER_API_KEY !== "provider-secret" ||
    childEnv.HITCH_SESSION_ID !== "session-id" ||
    childEnv.HITCH_TOOL_TOKEN !== "scoped-token"
  ) {
    throw new Error(`Required worker environment was not preserved: ${JSON.stringify(childEnv)}`);
  }
  for (const forbidden of [
    "TELEGRAM_BOT_TOKEN",
    "SSH_AUTH_SOCK",
    "DOCKER_HOST",
    "NODE_OPTIONS",
    "UNLISTED_SECRET",
  ]) {
    if (forbidden in childEnv) {
      throw new Error(`Worker inherited forbidden environment variable: ${forbidden}`);
    }
  }

  for (const forbidden of [
    "TELEGRAM_BOT_TOKEN",
    "SSH_AUTH_SOCK",
    "HITCH_TOOL_TOKEN",
    "LD_PRELOAD",
    "BASH_ENV",
    "PYTHONPATH",
    "RUBYOPT",
    "PERL5OPT",
    "JAVA_TOOL_OPTIONS",
    "DOTNET_STARTUP_HOOKS",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "GCONV_PATH",
    "GLIBC_TUNABLES",
    "PYTHONSTARTUP",
    "LUA_INIT",
    "PHPRC",
    "DOTNET_ADDITIONAL_DEPS",
    "ZDOTDIR",
  ]) {
    try {
      assertWorkerEnvironmentAllowlist([forbidden], ["TELEGRAM_BOT_TOKEN"]);
    } catch {
      continue;
    }
    throw new Error(`Unsafe worker allowlist entry was accepted: ${forbidden}`);
  }
  assertBlockedOverrideRejected();
  assertConfigCredentialCollisionRejected();
  await verifyPiBackendEnvironment();
  console.log("Worker environment smoke ok");
}

function assertBlockedOverrideRejected(): void {
  try {
    buildWorkerEnvironment({
      source: { PI_OFFLINE: "channel-secret" },
      blockedNames: ["PI_OFFLINE"],
      overrides: { PI_OFFLINE: "channel-secret" },
    });
  } catch {
    return;
  }
  throw new Error("A blocked channel credential was accepted as an internal worker override.");
}

function assertConfigCredentialCollisionRejected(): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hitch-worker-env-config-"));
  const allowedRoot = path.join(tempDir, "allowed");
  const configPath = path.join(tempDir, "config.yaml");
  mkdirSync(allowedRoot);
  writeFileSync(
    configPath,
    JSON.stringify({
      data_dir: path.join(tempDir, "data"),
      default_cwd: allowedRoot,
      users: { owner: { telegram_ids: ["owner"], allowed_roots: [allowedRoot] } },
      channels: { telegram: { bot_token_env: "PI_OFFLINE" } },
      agents: { pi: { config_scope: "hitch" } },
    }),
  );
  try {
    loadConfig(configPath);
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    if (error instanceof Error && error.message.includes("conflicts with a Hitch worker variable")) {
      return;
    }
    throw error;
  }
  rmSync(tempDir, { force: true, recursive: true });
  throw new Error("A channel credential name colliding with an internal worker variable was accepted.");
}

async function verifyPiBackendEnvironment(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hitch-worker-env-backend-"));
  const outputPath = path.join(tempDir, "environment.json");
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(process.env))`;
  const parsed = configSchema.parse({
    data_dir: tempDir,
    default_cwd: tempDir,
    users: { owner: { allowed_roots: [tempDir] } },
    agents: {
      pi: {
        command: process.execPath,
        default_args: ["-e", childScript, "--", "--no-session"],
        config_scope: "system",
        env_allowlist: ["PROVIDER_API_KEY"],
      },
    },
  });
  const config: HubConfig = {
    ...parsed,
    dataDir: tempDir,
    defaultCwd: tempDir,
    allowedRoots: [tempDir],
    outboundRoots: [],
    principalRoots: { owner: [tempDir] },
  };
  const sessionSecurity = new SessionRuntimeStore(tempDir).materialize(
    "owner",
    "backend-environment",
    tempDir,
    UNSAFE_DIRECT_EXECUTION_POLICY,
    [tempDir],
  );
  const session: HubSession = {
    id: "backend-environment",
    ownerPrincipalId: "owner",
    visibility: "private",
    platform: "fake",
    chatId: "worker-env",
    userId: "owner",
    agent: "pi",
    cwd: tempDir,
    ...sessionSecurity,
    status: "idle",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const previousProvider = process.env.PROVIDER_API_KEY;
  const previousTelegram = process.env.TELEGRAM_BOT_TOKEN;
  const previousSshSocket = process.env.SSH_AUTH_SOCK;
  process.env.PROVIDER_API_KEY = "provider-secret";
  process.env.TELEGRAM_BOT_TOKEN = "channel-secret";
  process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
  const backend = new PiRpcBackend(config);
  try {
    await backend.start(session);
    const deadline = Date.now() + 5_000;
    while (!existsSync(outputPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!existsSync(outputPath)) {
      throw new Error("Pi backend environment child did not produce output.");
    }
    const actual = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, string>;
    if (
      actual.PROVIDER_API_KEY !== "provider-secret" ||
      "TELEGRAM_BOT_TOKEN" in actual ||
      "SSH_AUTH_SOCK" in actual
    ) {
      throw new Error(`Pi backend received an unsafe environment: ${JSON.stringify(actual)}`);
    }
  } finally {
    await backend.stop();
    restoreEnvironment("PROVIDER_API_KEY", previousProvider);
    restoreEnvironment("TELEGRAM_BOT_TOKEN", previousTelegram);
    restoreEnvironment("SSH_AUTH_SOCK", previousSshSocket);
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

await main();

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BubblewrapLauncher } from "../sandbox/bubblewrap-launcher.js";
import type { LaunchRequest } from "../sandbox/launcher.js";
import { executionPolicySchema } from "../security/policy.js";
import { secureSessionBridgePaths, SessionRuntimeStore } from "../security/session-runtime.js";

const rootDir = path.resolve(".");
const tempDir = mkdtempSync(path.join(tmpdir(), "hitch-session-mcp-"));

try {
  const packageDir = path.join(rootDir, "packages", "session-mcp");
  runNpm(["pack", packageDir, "--pack-destination", tempDir, "--silent"]);
  const archive = readdirSync(tempDir).find((entry) => entry.endsWith(".tgz"));
  if (!archive) {
    throw new Error("npm pack did not produce a session MCP archive.");
  }

  const agentConfigDir = path.join(tempDir, "agent-config");
  const installDir = path.join(agentConfigDir, "npm");
  const unrelatedCwd = path.join(tempDir, "workspace");
  mkdirSync(unrelatedCwd, { recursive: true });
  runNpm([
    "install",
    "--prefix",
    installDir,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(tempDir, archive),
  ]);

  const serverPath = path.join(
    installDir,
    "node_modules",
    "@hitch-hub",
    "session-mcp",
    "dist",
    "server.js",
  );
  assertServerConfigRejected(serverPath, {}, "requires HITCH_TOOL_TOKEN");
  assertServerConfigRejected(
    serverPath,
    {
      HITCH_TOOL_TOKEN: "config-smoke-token",
      HITCH_TOOL_OUTBOX: path.join(tempDir, "invalid", "outbox.jsonl"),
      HITCH_TOOL_RESULT_DIR: path.join(tempDir, "invalid", "results"),
      HITCH_TOOL_TIMEOUT_MS: "Infinity",
    },
    "positive integer no greater than",
  );
  run(
    process.execPath,
    ["--import", "tsx", path.join(rootDir, "src", "smoke", "mcp-session.ts")],
    {
      HITCH_MCP_SERVER_PATH: serverPath,
      HITCH_MCP_SERVER_CWD: unrelatedCwd,
    },
  );
  await runBubblewrapRoundTrip(agentConfigDir);
  process.stdout.write("Standalone MCP package smoke ok\n");
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function runNpm(args: string[]): void {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    run(process.execPath, [npmCli, ...args]);
    return;
  }
  run("npm", args);
}

function run(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"})\n${result.stdout}${result.stderr}`,
    );
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
}

function assertServerConfigRejected(serverPath: string, env: NodeJS.ProcessEnv, expected: string): void {
  const result = spawnSync(process.execPath, [serverPath], {
    cwd: tempDir,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status === 0 || !result.stderr.includes(expected)) {
    throw new Error(`MCP server accepted invalid environment (${expected}): ${result.stdout}${result.stderr}`);
  }
}

async function runBubblewrapRoundTrip(agentConfigDir: string): Promise<void> {
  const launcher = new BubblewrapLauncher();
  const probe = await launcher.probe();
  if (!probe.available) {
    if (process.platform === "linux") {
      throw new Error(probe.reason ?? "Bubblewrap is unavailable.");
    }
    process.stdout.write(`Bubblewrap MCP package smoke skipped: ${probe.reason ?? "unsupported platform"}\n`);
    return;
  }

  const workspace = path.join(tempDir, "bubblewrap-workspace");
  mkdirSync(workspace, { recursive: true });
  const mediaPath = path.join(workspace, "mcp.png");
  writeFileSync(
    mediaPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  );
  const runtime = new SessionRuntimeStore(path.join(tempDir, "bubblewrap-data"));
  const policy = executionPolicySchema.parse({
    filesystem: "workspace-write",
    tools: ["*"],
    process: true,
    agent_network: "deny",
    sandbox: "required",
  });
  const metadata = runtime.materialize(
    "mcp-package-smoke",
    "mcp-package-session",
    workspace,
    policy,
    [workspace],
    { agentConfig: { hostPath: agentConfigDir, mode: "rw" } },
  );
  const agentConfigMount = metadata.mountPlan.mounts.find((mount) => mount.sandboxPath === "/agent-config");
  if (!agentConfigMount) {
    throw new Error("Bubblewrap MCP smoke is missing /agent-config.");
  }
  const bridge = secureSessionBridgePaths(metadata.statePath);
  const runtimePath = path.dirname(process.execPath);
  const baseRequest: LaunchRequest = {
    command: process.execPath,
    args: [],
    cwd: workspace,
    env: { PATH: runtimePath },
    executionPolicy: metadata.executionPolicy,
    mountPlan: metadata.mountPlan,
    agentPolicyEnforcement: {
      tools: [...metadata.executionPolicy.tools],
      processToolEnabled: metadata.executionPolicy.process,
      agentConfig: { hostPath: agentConfigMount.hostPath, mode: agentConfigMount.mode },
    },
  };

  const boundaryProbe = await collectBubblewrapJson(launcher, {
    ...baseRequest,
    args: [
      "-e",
      `const fs=require("node:fs");let resultsWritable=true;try{fs.writeFileSync("/hitch/results/tamper.json","bad")}catch{resultsWritable=false}process.stdout.write(JSON.stringify({cwd:process.cwd(),packageVisible:fs.existsSync("/agent-config/npm/node_modules/@hitch-hub/session-mcp/dist/server.js"),hitchSourceVisible:fs.existsSync(${JSON.stringify(rootDir)}),resultsWritable}))`,
    ],
  });
  if (
    boundaryProbe.cwd !== "/workspace" ||
    boundaryProbe.packageVisible !== true ||
    boundaryProbe.hitchSourceVisible !== false ||
    boundaryProbe.resultsWritable !== false
  ) {
    throw new Error(`Bubblewrap MCP mount boundary failed: ${JSON.stringify(boundaryProbe)}`);
  }

  const token = "bubblewrap-mcp-token";
  const serverRequest: LaunchRequest = {
    ...baseRequest,
    args: ["/agent-config/npm/node_modules/@hitch-hub/session-mcp/dist/server.js"],
    env: {
      PATH: runtimePath,
      HITCH_TOOL_TOKEN: token,
      HITCH_TOOL_OUTBOX: "/hitch/outbox.jsonl",
      HITCH_TOOL_RESULT_DIR: "/hitch/results",
      HITCH_TOOL_TIMEOUT_MS: "5000",
    },
  };
  const spec = launcher.buildSpec(serverRequest);
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: definedEnvironment(spec.env),
    stderr: "pipe",
  });
  const client = new Client({ name: "hitch-mcp-bubblewrap-smoke", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const call = client.callTool({
      name: "hitch.send_media",
      arguments: { path: "/workspace/mcp.png", kind: "image" },
    });
    const request = await waitForBridgeRequest(bridge.outboxPath);
    if (request.token !== token || request.path !== "/workspace/mcp.png") {
      throw new Error(`Unexpected Bubblewrap MCP request: ${JSON.stringify(request)}`);
    }
    writeFileSync(
      path.join(bridge.resultDir, `${request.id}.json`),
      JSON.stringify({
        deliveryId: request.id,
        status: "sent",
        platform: "fake",
        path: "/workspace/mcp.png",
        kind: "image",
        size: 68,
      }),
      "utf8",
    );
    const result = await call;
    const structured = result.structuredContent as { status?: unknown } | undefined;
    if (structured?.status !== "sent") {
      throw new Error(`Bubblewrap MCP call failed: ${JSON.stringify(result)}`);
    }
  } finally {
    await client.close();
  }
}

async function collectBubblewrapJson(
  launcher: BubblewrapLauncher,
  request: LaunchRequest,
): Promise<Record<string, unknown>> {
  const child = launcher.launch(request);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`Bubblewrap boundary probe failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
}

async function waitForBridgeRequest(outboxPath: string): Promise<Record<string, string> & { id: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(outboxPath)) {
      const line = readFileSync(outboxPath, "utf8").trim().split(/\r?\n/).find(Boolean);
      if (line) {
        const request = JSON.parse(line) as Record<string, unknown>;
        if (typeof request.id === "string") {
          return request as Record<string, string> & { id: string };
        }
      }
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for the Bubblewrap MCP request.");
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

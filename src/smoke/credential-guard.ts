import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/load-config.js";

type ToolCall = {
  toolName: string;
  input: Record<string, unknown>;
};

type GuardResult = { block: true; reason?: string } | undefined;

type GuardModule = {
  registerCredentialGuard(
    pi: {
      on(name: string, handler: (event: ToolCall) => Promise<GuardResult>): void;
      registerCommand(name: string, definition: unknown): void;
      registerTool(definition: RegisteredTool): void;
    },
    options: {
      roots: string[];
      cwd: string;
      mediaBridge?: {
        sessionId: string;
        token: string;
        outboxPath: string;
        resultDir: string;
        timeoutMs: number;
      };
    },
  ): void;
};

type RegisteredTool = {
  name: string;
  execute(
    toolCallId: string,
    params: { path: string; caption?: string; kind?: "image" | "file" },
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hitch-credential-guard-"));
  try {
    const workspace = path.join(tempDir, "workspace");
    const outside = path.join(tempDir, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(path.join(workspace, "inside.txt"), "inside");
    writeFileSync(path.join(outside, "credential.txt"), "outside");
    symlinkSync(path.join(outside, "credential.txt"), path.join(workspace, "escaped-read"));
    symlinkSync(outside, path.join(workspace, "escaped-dir"));
    symlinkSync(path.join(outside, "credential.txt"), path.join(workspace, "@inside.txt"));
    symlinkSync(path.join(outside, "credential.txt"), path.join(workspace, "normalized-escape"));
    writeFileSync(path.join(workspace, "@normalized-escape"), "inside");
    symlinkSync(path.join(outside, "credential.txt"), path.join(workspace, "unicode escape"));
    writeFileSync(path.join(workspace, "unicode\u00a0escape"), "inside");

    const guardPath = path.resolve("runtime/credential-guard.mjs");
    const guard = (await import(pathToFileURL(guardPath).href)) as GuardModule;
    const handlers = new Map<string, (event: ToolCall) => Promise<GuardResult>>();
    const commands = new Set<string>();
    const tools = new Map<string, RegisteredTool>();
    guard.registerCredentialGuard(
      {
        on: (name, handler) => handlers.set(name, handler),
        registerCommand: (name) => commands.add(name),
        registerTool: (definition) => tools.set(definition.name, definition),
      },
      { roots: [workspace], cwd: workspace },
    );
    const toolCall = handlers.get("tool_call");
    if (!toolCall) {
      throw new Error("Credential guard did not register a tool_call handler.");
    }
    if (!commands.has("hitch-credential-guard-status-v1")) {
      throw new Error("Credential guard did not register its readiness attestation command.");
    }
    if (tools.has("hitch_send_media")) {
      throw new Error("Credential guard registered media delivery without an authenticated bridge.");
    }

    await assertAllowed(toolCall, { toolName: "read", input: { path: "inside.txt" } });
    await assertAllowed(toolCall, { toolName: "write", input: { path: "new/nested.txt", content: "ok" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: path.join(outside, "credential.txt") } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "../outside/credential.txt" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "escaped-read" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "@inside.txt" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "@normalized-escape" } });
    await assertBlocked(toolCall, { toolName: "write", input: { path: "escaped-dir/new.txt", content: "no" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "/proc/self/environ" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "/agent-config/auth.json" } });
    await assertBlocked(toolCall, { toolName: "write", input: { path: "file:///agent-config/auth.json" } });
    await assertBlocked(toolCall, { toolName: "write", input: { path: "~/credential.txt" } });
    await assertBlocked(toolCall, { toolName: "write", input: { path: "unicode\u00a0escape" } });
    await assertBlocked(toolCall, { toolName: "bash", input: { command: "id" } });
    await assertBlocked(toolCall, { toolName: "find", input: { path: ".", pattern: "../*" } });
    await assertBlocked(toolCall, { toolName: "grep", input: { path: ".", pattern: "token", glob: "/tmp/*" } });

    await verifyGuardedMediaTool(guard, workspace, outside);

    verifyConfigurationBoundary(tempDir, workspace, guardPath);
    process.stdout.write("Credential guard smoke ok\n");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyGuardedMediaTool(guard: GuardModule, workspace: string, outside: string): Promise<void> {
  const bridgeRoot = path.join(path.dirname(workspace), "bridge");
  const outboxPath = path.join(bridgeRoot, "outbox.jsonl");
  const resultDir = path.join(bridgeRoot, "results");
  mkdirSync(resultDir, { recursive: true });
  const handlers = new Map<string, (event: ToolCall) => Promise<GuardResult>>();
  const commands = new Set<string>();
  const tools = new Map<string, RegisteredTool>();
  const token = "a".repeat(64);
  guard.registerCredentialGuard(
    {
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: (name) => commands.add(name),
      registerTool: (definition) => tools.set(definition.name, definition),
    },
    {
      roots: [workspace],
      cwd: workspace,
      mediaBridge: { sessionId: "guard-smoke", token, outboxPath, resultDir, timeoutMs: 2_000 },
    },
  );
  if (!commands.has("hitch-media-tool-status-v1")) {
    throw new Error("Guarded media tool did not register its readiness attestation.");
  }
  const handler = handlers.get("tool_call");
  const tool = tools.get("hitch_send_media");
  if (!handler || !tool) {
    throw new Error("Guarded media tool was not registered.");
  }
  await assertAllowed(handler, { toolName: "hitch_send_media", input: { path: "inside.txt" } });
  await assertBlocked(handler, {
    toolName: "hitch_send_media",
    input: { path: path.join(outside, "credential.txt") },
  });

  const execution = tool.execute("tool-call", { path: "@inside.txt", caption: "hello", kind: "file" });
  await waitFor(() => existsSync(outboxPath));
  const request = JSON.parse(readFileSync(outboxPath, "utf8").trim()) as Record<string, unknown>;
  if (
    request.type !== "send_media" ||
    request.token !== token ||
    request.path !== "inside.txt" ||
    request.caption !== "hello" ||
    request.kind !== "file" ||
    typeof request.id !== "string"
  ) {
    throw new Error(`Guarded media request was malformed: ${JSON.stringify(request)}`);
  }
  if ((statSync(outboxPath).mode & 0o777) !== 0o600) {
    throw new Error("Guarded media outbox was not private.");
  }
  writeFileSync(
    path.join(resultDir, `${request.id}.json`),
    JSON.stringify({
      deliveryId: "123e4567-e89b-42d3-a456-426614174000",
      status: "sent",
      platform: "wechat",
      path: path.join(outside, "credential.txt"),
      kind: "file",
      size: 6,
    }),
  );
  const result = await execution;
  const serialized = JSON.stringify(result);
  if (
    serialized.includes(outside) ||
    "path" in result.details ||
    result.details.status !== "sent" ||
    result.details.size !== 6
  ) {
    throw new Error(`Guarded media result exposed unsafe host details: ${serialized}`);
  }

  const failedExecution = tool.execute("failed-tool-call", { path: "inside.txt" });
  await waitFor(() => readFileSync(outboxPath, "utf8").trim().split(/\r?\n/).length === 2);
  const failedRequest = JSON.parse(readFileSync(outboxPath, "utf8").trim().split(/\r?\n/)[1] ?? "null") as
    | Record<string, unknown>
    | null;
  if (!failedRequest || typeof failedRequest.id !== "string") {
    throw new Error("Guarded media failure request was malformed.");
  }
  writeFileSync(
    path.join(resultDir, `${failedRequest.id}.json`),
    JSON.stringify({
      deliveryId: failedRequest.id,
      status: "failed",
      path: path.join(outside, "credential.txt"),
      message: `Secret host failure at ${outside}`,
    }),
  );
  let rejected = false;
  try {
    await failedExecution;
  } catch (error) {
    rejected = true;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(outside)) {
      throw new Error(`Guarded media failure exposed a host path: ${message}`);
    }
  }
  if (!rejected) {
    throw new Error("Guarded media failure was reported as success.");
  }

  try {
    await tool.execute("blocked-tool-call", { path: path.join(outside, "credential.txt") });
  } catch {
    return;
  }
  throw new Error("Guarded media tool executed with a path outside the workspace.");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for guarded media request.");
}

async function assertAllowed(
  handler: (event: ToolCall) => Promise<GuardResult>,
  event: ToolCall,
): Promise<void> {
  const result = await handler(event);
  if (result?.block) {
    throw new Error(`Credential guard blocked an allowed call: ${result.reason ?? event.toolName}`);
  }
}

async function assertBlocked(
  handler: (event: ToolCall) => Promise<GuardResult>,
  event: ToolCall,
): Promise<void> {
  const result = await handler(event);
  if (!result?.block) {
    throw new Error(`Credential guard allowed a forbidden call: ${JSON.stringify(event)}`);
  }
}

function verifyConfigurationBoundary(tempDir: string, workspace: string, expectedGuardPath: string): void {
  const systemConfig = path.join(tempDir, "pi-config");
  mkdirSync(systemConfig);
  const configPath = path.join(tempDir, "config.yaml");
  const base = {
    data_dir: path.join(tempDir, "data"),
    default_cwd: workspace,
    users: { owner: { allowed_roots: [workspace] } },
    agents: {
      pi: {
        config_scope: "system",
        system_config_root: systemConfig,
        credential_isolation: "required",
        execution_policy: {
          filesystem: "workspace-write",
          tools: ["read", "write", "edit", "ls", "hitch_send_media"],
          process: false,
          sandbox: "required",
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(base));
  const valid = loadConfig(configPath);
  if (
    valid.piCredentialGuardPath !== path.join(tempDir, "data", "runtime", "credential-guard.mjs") ||
    valid.piCredentialGuardPath === expectedGuardPath ||
    (statSync(valid.piCredentialGuardPath).mode & 0o777) !== 0o400
  ) {
    throw new Error(`Credential guard path was not resolved from trusted Hitch code: ${valid.piCredentialGuardPath}`);
  }

  assertConfigRejected(
    configPath,
    {
      ...base,
      agents: {
        pi: {
          ...base.agents.pi,
          execution_policy: { ...base.agents.pi.execution_policy, tools: ["*"], process: true },
        },
      },
    },
    "allows only",
  );
  assertConfigRejected(
    configPath,
    { ...base, agents: { pi: { ...base.agents.pi, default_args: ["--mode", "rpc", "-e", "/tmp/untrusted.mjs"] } } },
    "caller-supplied resources",
  );
  assertConfigRejected(
    configPath,
    { ...base, users: { owner: { allowed_roots: [workspace], execution_policy: { tools: ["*"], process: true } } } },
    "allows only",
  );
}

function assertConfigRejected(configPath: string, value: unknown, expectedMessage: string): void {
  writeFileSync(configPath, JSON.stringify(value));
  try {
    loadConfig(configPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }
  throw new Error(`Credential isolation accepted invalid configuration: ${expectedMessage}`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

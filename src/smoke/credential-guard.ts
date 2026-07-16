import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    },
    options: { roots: string[]; cwd: string },
  ): void;
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

    const guardPath = path.resolve("runtime/credential-guard.mjs");
    const guard = (await import(pathToFileURL(guardPath).href)) as GuardModule;
    const handlers = new Map<string, (event: ToolCall) => Promise<GuardResult>>();
    const commands = new Set<string>();
    guard.registerCredentialGuard(
      {
        on: (name, handler) => handlers.set(name, handler),
        registerCommand: (name) => commands.add(name),
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

    await assertAllowed(toolCall, { toolName: "read", input: { path: "inside.txt" } });
    await assertAllowed(toolCall, { toolName: "write", input: { path: "new/nested.txt", content: "ok" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: path.join(outside, "credential.txt") } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "../outside/credential.txt" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "escaped-read" } });
    await assertBlocked(toolCall, { toolName: "write", input: { path: "escaped-dir/new.txt", content: "no" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "/proc/self/environ" } });
    await assertBlocked(toolCall, { toolName: "read", input: { path: "/agent-config/auth.json" } });
    await assertBlocked(toolCall, { toolName: "bash", input: { command: "id" } });
    await assertBlocked(toolCall, { toolName: "find", input: { path: ".", pattern: "../*" } });
    await assertBlocked(toolCall, { toolName: "grep", input: { path: ".", pattern: "token", glob: "/tmp/*" } });

    verifyConfigurationBoundary(tempDir, workspace, guardPath);
    process.stdout.write("Credential guard smoke ok\n");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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
          tools: ["read", "write", "edit", "ls"],
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

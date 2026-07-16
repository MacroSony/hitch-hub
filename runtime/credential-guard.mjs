import fs from "node:fs";
import path from "node:path";

const WORKSPACE_ROOT = "/workspace";
const PATH_TOOLS = new Set(["read", "write", "edit", "ls"]);
const WRITE_TOOLS = new Set(["write"]);
const STATUS_COMMAND = "hitch-credential-guard-status-v1";

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      return { ancestor: current, canonical: fs.realpathSync.native(current) };
    } catch (error) {
      if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing ancestor for ${candidate}`);
    }
    current = parent;
  }
}

export function createWorkspacePathGuard({ roots, cwd = process.cwd() }) {
  const lexicalRoots = roots.map((root) => path.resolve(root));
  const canonicalRoots = lexicalRoots.map((root) => fs.realpathSync.native(root));

  return function assertWorkspacePath(rawPath, { allowMissing = false } = {}) {
    if (typeof rawPath !== "string" || rawPath.includes("\0")) {
      throw new Error("Tool path must be a valid string.");
    }
    const candidate = path.resolve(cwd, rawPath || ".");
    if (!lexicalRoots.some((root) => isInside(candidate, root))) {
      throw new Error(`Path is outside the mounted workspace: ${rawPath || "."}`);
    }

    if (!allowMissing) {
      const canonical = fs.realpathSync.native(candidate);
      if (!canonicalRoots.some((root) => isInside(canonical, root))) {
        throw new Error(`Path resolves outside the mounted workspace: ${rawPath || "."}`);
      }
      return;
    }

    const { ancestor, canonical } = canonicalExistingAncestor(candidate);
    if (!canonicalRoots.some((root) => isInside(canonical, root))) {
      throw new Error(`Path resolves outside the mounted workspace: ${rawPath || "."}`);
    }
    const unresolved = path.relative(ancestor, candidate);
    if (unresolved === ".." || unresolved.startsWith(`..${path.sep}`) || path.isAbsolute(unresolved)) {
      throw new Error(`Path cannot be safely resolved inside the mounted workspace: ${rawPath || "."}`);
    }
  };
}

export function registerCredentialGuard(
  pi,
  { roots = [WORKSPACE_ROOT, process.env.HITCH_WORKSPACE_PATH], cwd = process.cwd() } = {},
) {
  const workspaceAliases = roots
    .filter((value) => typeof value === "string" && value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);
  const assertWorkspacePath = createWorkspacePathGuard({ roots: workspaceAliases, cwd });

  const guardToolCall = (event) => {
    if (!PATH_TOOLS.has(event.toolName)) {
      return { block: true, reason: `Tool is not available in the credential-isolated worker: ${event.toolName}` };
    }
    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) {
      return { block: true, reason: "Tool input is malformed." };
    }

    const input = event.input;
    const rawPath = input.path ?? ".";
    try {
      assertWorkspacePath(rawPath, { allowMissing: WRITE_TOOLS.has(event.toolName) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Workspace path validation failed.";
      return { block: true, reason };
    }
    return undefined;
  };
  pi.on("tool_call", guardToolCall);

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nHitch security boundary: use only the mounted workspace. Credential, runtime, session, and host paths are unavailable.`,
  }));

  for (const event of [
    { toolName: "read", input: { path: "/agent-config/auth.json" } },
    { toolName: "read", input: { path: "/proc/self/environ" } },
    { toolName: "bash", input: { command: "id" } },
  ]) {
    if (!guardToolCall(event)?.block) {
      throw new Error(`Credential guard self-test failed for ${event.toolName}.`);
    }
  }
  pi.registerCommand(STATUS_COMMAND, {
    description: "Hitch credential guard readiness attestation",
    handler: async () => undefined,
  });
}

export default function credentialGuard(pi) {
  registerCredentialGuard(pi);
}

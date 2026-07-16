import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = "/workspace";
const PATH_TOOLS = new Set(["read", "write", "edit", "ls"]);
const WRITE_TOOLS = new Set(["write"]);
const MEDIA_TOOL = "hitch_send_media";
const STATUS_COMMAND = "hitch-credential-guard-status-v1";
const MEDIA_STATUS_COMMAND = "hitch-media-tool-status-v1";
const MEDIA_OUTBOX_PATH = "/hitch/outbox.jsonl";
const MEDIA_RESULT_DIR = "/hitch/results";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

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
  {
    roots = [WORKSPACE_ROOT, process.env.HITCH_WORKSPACE_PATH],
    cwd = process.cwd(),
    mediaBridge,
  } = {},
) {
  const workspaceAliases = roots
    .filter((value) => typeof value === "string" && value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);
  const assertWorkspacePath = createWorkspacePathGuard({ roots: workspaceAliases, cwd });
  const allowedTools = new Set([...PATH_TOOLS, ...(mediaBridge ? [MEDIA_TOOL] : [])]);

  const guardToolCall = (event) => {
    if (!allowedTools.has(event.toolName)) {
      return { block: true, reason: `Tool is not available in the credential-isolated worker: ${event.toolName}` };
    }
    if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) {
      return { block: true, reason: "Tool input is malformed." };
    }

    const input = event.input;
    const rawPath = input.path ?? ".";
    try {
      const normalizedPath = event.toolName === MEDIA_TOOL
        ? normalizeMediaToolPath(rawPath)
        : normalizePiBuiltinPath(rawPath);
      const pathCandidates = rawPath !== normalizedPath ? [rawPath, normalizedPath] : [rawPath];
      for (const candidate of pathCandidates) {
        assertWorkspacePath(candidate, {
          allowMissing: WRITE_TOOLS.has(event.toolName),
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Workspace path validation failed.";
      return { block: true, reason };
    }
    return undefined;
  };
  pi.on("tool_call", guardToolCall);

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nHitch security boundary: use only the mounted workspace. Credential, runtime, session, and host paths are unavailable.${
      mediaBridge ? ` Use ${MEDIA_TOOL} to send an existing workspace file to the user.` : ""
    }`,
  }));

  if (mediaBridge) {
    pi.registerTool(createMediaTool(mediaBridge, assertWorkspacePath));
    pi.registerCommand(MEDIA_STATUS_COMMAND, {
      description: "Hitch guarded media tool readiness attestation",
      handler: async () => undefined,
    });
  }

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
  registerCredentialGuard(pi, { mediaBridge: mediaBridgeFromEnvironment() });
}

function normalizeMediaToolPath(value) {
  return typeof value === "string" && value.startsWith("@") ? value.slice(1) : value;
}

function normalizePiBuiltinPath(value) {
  if (typeof value !== "string") {
    return value;
  }
  let normalized = value.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    return fileURLToPath(normalized);
  }
  return normalized;
}

function mediaBridgeFromEnvironment() {
  const required = process.env.HITCH_MEDIA_TOOL_REQUIRED === "1";
  const values = {
    sessionId: process.env.HITCH_SESSION_ID,
    token: process.env.HITCH_TOOL_TOKEN,
    outboxPath: process.env.HITCH_TOOL_OUTBOX,
    resultDir: process.env.HITCH_TOOL_RESULT_DIR,
    timeout: process.env.HITCH_TOOL_TIMEOUT_MS,
  };
  const present = Object.values(values).filter((value) => typeof value === "string" && value.length > 0).length;
  if (!required && present === 0) {
    return undefined;
  }
  if (!required || present !== Object.keys(values).length) {
    throw new Error("Guarded media bridge environment is incomplete or was not explicitly required.");
  }
  if (!values.sessionId || values.sessionId.includes("\0")) {
    throw new Error("Guarded media bridge session id is invalid.");
  }
  if (!values.token || !/^[a-f0-9]{64}$/.test(values.token)) {
    throw new Error("Guarded media bridge token is invalid.");
  }
  if (values.outboxPath !== MEDIA_OUTBOX_PATH || values.resultDir !== MEDIA_RESULT_DIR) {
    throw new Error("Guarded media bridge paths do not match Hitch's sandbox mounts.");
  }
  const timeoutMs = Number(values.timeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Guarded media bridge timeout is invalid.");
  }
  return {
    sessionId: values.sessionId,
    token: values.token,
    outboxPath: values.outboxPath,
    resultDir: values.resultDir,
    timeoutMs,
  };
}

function createMediaTool(bridge, assertWorkspacePath) {
  return {
    name: MEDIA_TOOL,
    label: "Send Media",
    description: "Send an existing file from the mounted workspace to the current Hitch chat.",
    promptSnippet: "Send an existing workspace image or file to the current chat",
    promptGuidelines: [
      `Use ${MEDIA_TOOL} only when the user asks to receive a file or image; continue with a final text response after delivery.`,
    ],
    executionMode: "sequential",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Workspace-relative path, /workspace path, or the mounted workspace's absolute path.",
        },
        caption: { type: "string", maxLength: 4096 },
        kind: { type: "string", enum: ["image", "file"] },
      },
    },
    async execute(_toolCallId, params, signal) {
      const rawPath = normalizeMediaToolPath(params.path);
      assertWorkspacePath(rawPath);
      const id = randomUUID();
      appendMediaRequest(bridge, {
        id,
        type: "send_media",
        token: bridge.token,
        path: rawPath,
        ...(params.caption ? { caption: params.caption } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
      });
      const result = await waitForMediaResult(bridge, id, signal);
      const safe = safeMediaResult(result);
      if (safe.status === "failed") {
        throw new Error("Media delivery failed. Hitch reported the failure to the chat.");
      }
      const summary = [
        "Media sent successfully.",
        safe.kind ? `Kind: ${safe.kind}.` : undefined,
        safe.size !== undefined ? `Size: ${safe.size} bytes.` : undefined,
        `Delivery ID: ${safe.deliveryId}.`,
      ].filter(Boolean).join(" ");
      return {
        content: [{ type: "text", text: summary }],
        details: safe,
      };
    },
  };
}

function appendMediaRequest(bridge, request) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollowFlag();
  const descriptor = fs.openSync(bridge.outboxPath, flags, 0o600);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Guarded media outbox is not a regular file.");
    }
    fs.fchmodSync(descriptor, 0o600);
    const line = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    let offset = 0;
    while (offset < line.length) {
      const written = fs.writeSync(descriptor, line, offset, line.length - offset);
      if (written <= 0) {
        throw new Error("Guarded media request could not be written.");
      }
      offset += written;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function waitForMediaResult(bridge, id, signal) {
  const resultPath = path.join(bridge.resultDir, `${id}.json`);
  const deadline = Date.now() + bridge.timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Media delivery was cancelled.");
    }
    try {
      return readMediaResult(resultPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }
    await abortableDelay(Math.min(50, Math.max(1, deadline - Date.now())), signal);
  }
  throw new Error("Media delivery timed out.");
}

function readMediaResult(resultPath) {
  const descriptor = fs.openSync(resultPath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("Guarded media result is not a regular file.");
    }
    if (stat.size > 16 * 1024) {
      throw new Error("Guarded media result is too large.");
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeMediaResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Guarded media result is malformed.");
  }
  if (
    typeof value.deliveryId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.deliveryId)
  ) {
    throw new Error("Guarded media delivery id is invalid.");
  }
  if (value.status !== "sent" && value.status !== "failed") {
    throw new Error("Guarded media delivery status is invalid.");
  }
  if (value.kind !== undefined && value.kind !== "image" && value.kind !== "file") {
    throw new Error("Guarded media kind is invalid.");
  }
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) {
    throw new Error("Guarded media size is invalid.");
  }
  return {
    deliveryId: value.deliveryId,
    status: value.status,
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.size !== undefined ? { size: value.size } : {}),
  };
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Media delivery was cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Media delivery was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function noFollowFlag() {
  return "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
}

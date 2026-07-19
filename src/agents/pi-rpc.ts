import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { HubConfig } from "../config/schema.js";
import { resolveTurnTimeoutPolicy } from "../config/turn-timeout.js";
import type { HubSession } from "../core/types.js";
import type { AgentToolContext } from "../core/tool-bridge.js";
import { FailClosedLauncherSelector, type LauncherSelector } from "../sandbox/launcher-selector.js";
import { buildWorkerEnvironment } from "../security/worker-environment.js";
import { assertInstalledPiPathCompatibility } from "../security/pi-path-compatibility.js";
import { secureMountHostPath } from "../security/session-runtime.js";
import { attachJsonlReader } from "../utils/jsonl-reader.js";
import type {
  AgentBackend,
  AgentCommandInput,
  AgentCommandResult,
  AgentEvent,
  AgentInput,
  AgentInteraction,
  AgentModelInfo,
  AgentSelectionInput,
} from "./types.js";
import { applyPiExecutionPolicy } from "./pi-policy.js";

type SpawnSpec = {
  command: string;
  args: string[];
};

const CREDENTIAL_GUARD_STATUS_COMMAND = "hitch-credential-guard-status-v1";
const MEDIA_TOOL = "hitch_send_media";
const MEDIA_TOOL_STATUS_COMMAND = "hitch-media-tool-status-v1";

function resolveSpawnSpec(command: string, args: string[]): SpawnSpec {
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

const sharedLauncherSelector = new FailClosedLauncherSelector();

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }

      if (this.closed) {
        return;
      }

      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

export class PiRpcBackend implements AgentBackend {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private readonly eventsQueue = new AsyncEventQueue<AgentEvent>();
  private readonly responseWaiters = new Map<string, (response: RpcResponse) => void>();
  private pendingSettledFinal: Extract<AgentEvent, { type: "final" }> | undefined;
  private stderrTail = "";

  constructor(
    private readonly config: HubConfig,
    private readonly launcherSelector: LauncherSelector = sharedLauncherSelector,
  ) {}

  async start(session: HubSession, toolContext?: AgentToolContext): Promise<number | undefined> {
    if (this.proc) {
      return this.proc.pid;
    }

    const piConfig = this.config.agents.pi;
    const launcher = await this.launcherSelector.select(session.executionPolicy);
    const credentialGuard = credentialGuardForSession(this.config, session, launcher.kind !== "direct");
    const guardedMediaTool = credentialGuard && session.executionPolicy.tools.includes(MEDIA_TOOL);
    if (guardedMediaTool && !toolContext) {
      throw new Error("Credential-isolated hitch_send_media requires an authenticated session tool bridge.");
    }
    if (credentialGuard) {
      await assertInstalledPiPathCompatibility(piConfig.command, credentialGuard.hostPath);
      assertCredentialConfigSafe(secureMountHostPath(session, "/agent-config"));
    }
    const policyEnforcement = applyPiExecutionPolicy(
      piArgsForSession(
        credentialGuard
          ? [
              ...piConfig.default_args,
              "--no-extensions",
              "--extension",
              credentialGuard.sandboxPath,
              "--no-skills",
              "--no-prompt-templates",
              "--no-themes",
              "--no-approve",
            ]
          : piConfig.default_args,
        session,
      ),
      session.executionPolicy,
    );
    const spawnSpec = resolveSpawnSpec(piConfig.command, policyEnforcement.args);
    const sandboxed = launcher.kind !== "direct";
    const overrides: Record<string, string> = {};
    const piAgentDir = secureMountHostPath(session, "/agent-config");
    const piSessionDir = secureMountHostPath(session, "/agent-sessions");
    const agentConfigMount = session.mountPlan.mounts.find((mount) => mount.sandboxPath === "/agent-config");
    if (!agentConfigMount) {
      throw new Error("Session mount plan is missing /agent-config.");
    }
    const trustedAgentConfig = trustedAgentConfigForSession(
      this.config,
      session,
      piAgentDir,
      agentConfigMount.mode,
      sandboxed,
    );

    if (sandboxed) {
      overrides.HOME = "/state/home";
      overrides.PI_CODING_AGENT_DIR = "/agent-config";
      overrides.PI_CODING_AGENT_SESSION_DIR = "/agent-sessions";
      if (credentialGuard) {
        overrides.HITCH_WORKSPACE_PATH = session.cwd;
      }
    } else if (piConfig.config_scope === "hitch") {
      overrides.PI_CODING_AGENT_DIR = piAgentDir;
      overrides.PI_CODING_AGENT_SESSION_DIR = piSessionDir;
    }
    if (credentialGuard) {
      overrides.PI_OFFLINE = "1";
      if (guardedMediaTool) {
        overrides.HITCH_MEDIA_TOOL_REQUIRED = "1";
      }
    } else if (piConfig.config_scope === "hitch") {
      overrides.PI_OFFLINE = process.env.PI_OFFLINE ?? "1";
    }
    if (toolContext && (!credentialGuard || guardedMediaTool)) {
      overrides.HITCH_SESSION_ID = toolContext.sessionId;
      overrides.HITCH_TOOL_TOKEN = toolContext.token;
      overrides.HITCH_TOOL_OUTBOX = sandboxed ? "/hitch/outbox.jsonl" : toolContext.outboxPath;
      overrides.HITCH_TOOL_RESULT_DIR = sandboxed ? "/hitch/results" : toolContext.resultDir;
      overrides.HITCH_TOOL_TIMEOUT_MS = String(resolveTurnTimeoutPolicy(this.config).toolMs);
    }
    const env = buildWorkerEnvironment({
      ...(piConfig.env_allowlist ? { allowlist: piConfig.env_allowlist } : {}),
      blockedNames: [this.config.channels.telegram.bot_token_env],
      overrides,
    });

    this.proc = launcher.launch({
      command: spawnSpec.command,
      args: spawnSpec.args,
      cwd: session.cwd,
      env,
      executionPolicy: session.executionPolicy,
      mountPlan: session.mountPlan,
      agentPolicyEnforcement: {
        tools: policyEnforcement.tools,
        processToolEnabled: policyEnforcement.processToolEnabled,
        agentConfig: trustedAgentConfig,
        ...(credentialGuard ? { credentialGuard } : {}),
      },
    });

    attachJsonlReader(
      this.proc.stdout,
      (value) => {
        if (this.resolvePendingResponse(value)) {
          return;
        }

        if (isRecord(value) && value.type === "agent_end" && typeof value.willRetry === "boolean") {
          const final = finalEventFromPiAgentEnd(value);
          this.pendingSettledFinal = final;
          if (value.willRetry) {
            this.eventsQueue.push({ type: "status", state: "running" });
          }
          return;
        }

        if (isRecord(value) && value.type === "agent_settled") {
          const final = this.pendingSettledFinal;
          this.pendingSettledFinal = undefined;
          if (final) {
            this.eventsQueue.push({ type: "status", state: "idle" });
            this.eventsQueue.push(final);
          }
          return;
        }

        for (const event of mapPiEvent(value)) {
          this.eventsQueue.push(event);
        }
        const autoResponse = piExtensionUiAutoResponse(value);
        if (autoResponse) {
          this.writeCommand(autoResponse);
        }
      },
      (error) => {
        this.eventsQueue.push(failedPiEvent("Pi RPC parse error", error.message));
      },
    );

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        this.stderrTail = `${this.stderrTail}\n${text}`.slice(-4000);
      }
    });

    this.proc.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        const stderr = this.stderrTail.trim();
        this.eventsQueue.push(
          failedPiEvent(
            `Pi RPC process exited with code ${code ?? "unknown"}`,
            stderr || "No process error details were provided.",
          ),
        );
      }
      this.eventsQueue.close();
    });

    if (credentialGuard) {
      try {
        await this.assertCredentialGuardReady(Boolean(guardedMediaTool));
        assertCredentialConfigSafe(piAgentDir);
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    return this.proc.pid;
  }

  async send(input: AgentInput): Promise<void> {
    this.pendingSettledFinal = undefined;
    this.writeCommand(promptCommandWithAttachments(input));
  }

  async executeCommand(input: AgentCommandInput): Promise<AgentCommandResult> {
    const parsed = parseSlashCommand(input.raw);

    switch (parsed.name) {
      case "model": {
        if (parsed.args.length === 0) {
          const state = await this.getState();
          const models = await this.getAvailableModels();
          return {
            text: `Current model: ${formatModel(state.model)}`,
            ...(models.length > 0 ? { interaction: modelSelectionInteraction(models, "Select model") } : {}),
          };
        }
        const selected = await this.setModel(parsed.args.join(" "));
        return { text: `Model switched to ${formatModel(selected)}.` };
      }
      case "models": {
        const filter = parsed.args.join(" ").toLowerCase();
        const models = (await this.getAvailableModels())
          .filter((model) => filter.length === 0 || formatModel(model).toLowerCase().includes(filter))
          .slice(0, 100);
        return {
          ...(models.length > 0 ? { interaction: modelSelectionInteraction(models, filter ? `Select model matching "${filter}"` : "Select model") } : {}),
          ...(models.length === 0 ? { text: "No models matched." } : {}),
        };
      }
      default:
        const promptInput = input.attachments ? { text: input.raw, attachments: input.attachments } : { text: input.raw };
        this.pendingSettledFinal = undefined;
        this.writeCommand(promptCommandWithAttachments(promptInput));
        return { consumesEvents: true };
    }
  }

  async respondToApproval(raw: unknown, decision: "allowed" | "denied"): Promise<void> {
    this.writeCommand(piApprovalResponse(raw, decision));
  }

  async executeSelection(input: AgentSelectionInput): Promise<AgentCommandResult> {
    if (input.kind === "pi.ui.select") {
      const payload = piUiSelectionPayload(input.value);
      this.writeCommand({ type: "extension_ui_response", id: payload.requestId, value: payload.value });
      return { text: `Selected: ${input.label}` };
    }

    if (input.kind === "pi.model.select") {
      if (!isRecord(input.value) || typeof input.value.provider !== "string" || typeof input.value.modelId !== "string") {
        throw new Error("Invalid Pi model selection payload.");
      }

      const selected = await this.setModel(`${input.value.provider}/${input.value.modelId}`);
      return { text: `Model switched to ${formatModel(selected)}.` };
    }

    throw new Error(`Unsupported Pi selection kind: ${input.kind}`);
  }

  private async getState(): Promise<{ model?: AgentModelInfo }> {
    const response = await this.request({ type: "get_state" });
    const data = response.data;
    if (!isRecord(data)) {
      return {};
    }
    const model = modelInfoFromValue(data.model);
    return model ? { model } : {};
  }

  private async setModel(model: string): Promise<AgentModelInfo> {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) {
      throw new Error("Usage: /model <provider>/<model-id>");
    }

    const provider = model.slice(0, separator).trim();
    const modelId = model.slice(separator + 1).trim();
    const response = await this.request({ type: "set_model", provider, modelId });
    return modelInfoFromValue(response.data) ?? { provider, id: modelId };
  }

  private async getAvailableModels(): Promise<AgentModelInfo[]> {
    const response = await this.request({ type: "get_available_models" });
    const data = response.data;
    if (!isRecord(data) || !Array.isArray(data.models)) {
      return [];
    }
    return data.models.map(modelInfoFromValue).filter((model): model is AgentModelInfo => model !== undefined);
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield* this.eventsQueue.iterate();
  }

  isAlive(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && !this.proc.killed;
  }

  async abort(): Promise<void> {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      this.writeCommand({ type: "abort" });
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      return;
    }

    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill("SIGTERM");
      if (!(await waitForProcessExit(proc, 2_000))) {
        proc.kill("SIGKILL");
        await waitForProcessExit(proc, 1_000);
      }
    }
    if (this.proc === proc) {
      this.proc = undefined;
    }
  }

  private writeCommand(command: Record<string, unknown>): void {
    if (!this.proc) {
      throw new Error("Pi RPC process has not been started.");
    }
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private async request(command: Record<string, unknown>, timeoutMs = 10_000): Promise<RpcResponse> {
    if (!this.proc) {
      throw new Error("Pi RPC process has not been started.");
    }

    const id = randomUUID();
    const responsePromise = new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responseWaiters.delete(id);
        reject(new Error(`Pi RPC command timed out: ${String(command.type)}`));
      }, timeoutMs);

      this.responseWaiters.set(id, (response) => {
        clearTimeout(timeout);
        if (response.success === false) {
          reject(new Error(response.error ?? `Pi RPC command failed: ${String(command.type)}`));
          return;
        }
        resolve(response);
      });
    });

    this.writeCommand({ id, ...command });
    return responsePromise;
  }

  private async assertCredentialGuardReady(mediaToolRequired: boolean): Promise<void> {
    const response = await this.request({ type: "get_commands" }, 5_000);
    const commands = isRecord(response.data) && Array.isArray(response.data.commands)
      ? response.data.commands
      : [];
    const attested = commands.some(
      (command) =>
        isRecord(command) &&
        command.name === CREDENTIAL_GUARD_STATUS_COMMAND &&
        command.source === "extension",
    );
    if (!attested) {
      throw new Error("Pi started without Hitch's credential guard readiness attestation.");
    }
    if (
      mediaToolRequired &&
      !commands.some(
        (command) =>
          isRecord(command) &&
          command.name === MEDIA_TOOL_STATUS_COMMAND &&
          command.source === "extension",
      )
    ) {
      throw new Error("Pi started without Hitch's guarded media tool readiness attestation.");
    }
  }

  private resolvePendingResponse(value: unknown): boolean {
    if (!isRecord(value) || value.type !== "response" || typeof value.id !== "string") {
      return false;
    }

    const waiter = this.responseWaiters.get(value.id);
    if (!waiter) {
      return false;
    }

    this.responseWaiters.delete(value.id);
    waiter(value as RpcResponse);
    return true;
  }
}

function trustedAgentConfigForSession(
  config: HubConfig,
  session: HubSession,
  actualHostPath: string,
  actualMode: "ro" | "rw",
  sandboxed: boolean,
): { hostPath: string; mode: "ro" | "rw" } {
  if (session.statePath !== session.mountPlan.statePath) {
    throw new Error("Session state path does not match its persisted mount plan.");
  }
  let expectedHostPath: string;
  let expectedMode: "ro" | "rw";
  if (config.agents.pi.config_scope === "system" && sandboxed) {
    if (!config.piSystemConfigRoot) {
      throw new Error("Sandboxed system Pi config requires a resolved agents.pi.system_config_root.");
    }
    expectedHostPath = config.piSystemConfigRoot;
    expectedMode = "rw";
  } else if (config.agents.pi.config_scope === "hitch") {
    const principalStateRoot = path.dirname(path.dirname(session.statePath));
    expectedHostPath = path.join(principalStateRoot, "shared", "pi", "agent");
    expectedMode = "rw";
  } else {
    expectedHostPath = actualHostPath;
    expectedMode = actualMode;
  }
  if (path.resolve(actualHostPath) !== path.resolve(expectedHostPath) || actualMode !== expectedMode) {
    throw new Error("Persisted Pi config mount does not match Hitch's trusted config scope.");
  }
  return { hostPath: expectedHostPath, mode: expectedMode };
}

function credentialGuardForSession(
  config: HubConfig,
  session: HubSession,
  sandboxed: boolean,
): { hostPath: string; sandboxPath: "/hitch-runtime/credential-guard.mjs" } | undefined {
  const required = config.agents.pi.credential_isolation === "required";
  if (!required) {
    return undefined;
  }
  if (!sandboxed || !config.piCredentialGuardPath) {
    throw new Error("Credential-isolated Pi requires Bubblewrap and a trusted credential guard runtime.");
  }
  const sandboxPath = "/hitch-runtime/credential-guard.mjs" as const;
  const mount = session.mountPlan.mounts.find((candidate) => candidate.sandboxPath === sandboxPath);
  if (
    !mount ||
    mount.mode !== "ro" ||
    mount.purpose !== "runtime" ||
    path.resolve(mount.hostPath) !== path.resolve(config.piCredentialGuardPath)
  ) {
    throw new Error("Session mount plan does not contain Hitch's trusted credential guard runtime.");
  }
  return { hostPath: config.piCredentialGuardPath, sandboxPath };
}

function assertCredentialConfigSafe(agentConfigRoot: string): void {
  const canonicalRoot = realpathSync.native(agentConfigRoot);
  for (const fileName of ["auth.json", "models.json", "settings.json"]) {
    const filePath = path.join(canonicalRoot, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Credential-isolated Pi requires a real ${fileName} file.`);
    }
    const canonicalFile = realpathSync.native(filePath);
    if (path.dirname(canonicalFile) !== canonicalRoot) {
      throw new Error(`Credential-isolated Pi ${fileName} escaped its trusted config directory.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(canonicalFile, "utf8")) as unknown;
    } catch {
      throw new Error(`Credential-isolated Pi cannot parse ${fileName}.`);
    }
    const unsafePath = fileName === "auth.json"
      ? findCommandBackedAuthValue(value)
      : fileName === "models.json"
        ? findCommandBackedModelValue(value)
        : findCommandBackedSettingsValue(value);
    if (unsafePath) {
      throw new Error(
        `Credential-isolated Pi rejects command-backed configuration in ${fileName} at ${unsafePath}.`,
      );
    }
  }
}

function findCommandBackedAuthValue(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [provider, credential] of Object.entries(value)) {
    if (
      isRecord(credential) &&
      credential.type === "api_key" &&
      typeof credential.key === "string" &&
      credential.key.startsWith("!")
    ) {
      return `${provider}.key`;
    }
  }
  return undefined;
}

function findCommandBackedModelValue(value: unknown): string | undefined {
  const visit = (candidate: unknown, segments: string[], commandContext: boolean): string | undefined => {
    if (typeof candidate === "string") {
      return commandContext && candidate.startsWith("!") ? segments.join(".") : undefined;
    }
    if (Array.isArray(candidate)) {
      for (const [index, entry] of candidate.entries()) {
        const found = visit(entry, [...segments, String(index)], commandContext);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    if (!isRecord(candidate)) {
      return undefined;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      const found = visit(entry, [...segments, key], commandContext || key === "apiKey" || key === "headers");
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return visit(value, [], false);
}

function findCommandBackedSettingsValue(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.apiKeys)) {
    return undefined;
  }
  for (const [provider, key] of Object.entries(value.apiKeys)) {
    if (typeof key === "string" && key.startsWith("!")) {
      return `apiKeys.${provider}`;
    }
  }
  return undefined;
}

type RpcResponse = {
  id?: string;
  type: "response";
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PiImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

function promptCommandWithAttachments(input: AgentInput): Record<string, unknown> {
  const { text, images } = promptContentWithAttachments(input);
  return images.length > 0 ? { type: "prompt", message: text, images } : { type: "prompt", message: text };
}

function promptContentWithAttachments(input: AgentInput): { text: string; images: PiImageContent[] } {
  if (!input.attachments || input.attachments.length === 0) {
    return { text: input.text, images: [] };
  }

  const imageAttachments = input.attachments.filter((attachment) => attachment.kind === "image" && isPiImageMimeType(attachment.mimeType));
  const images = imageAttachments.map((attachment) => ({
    type: "image" as const,
    data: readFileSync(attachment.localPath).toString("base64"),
    mimeType: attachment.mimeType ?? "image/png",
  }));

  const attachmentLines = input.attachments.map((attachment, index) => {
    const label = attachment.kind === "image" ? "Image" : "File";
    const delivery = attachment.kind === "image" && isPiImageMimeType(attachment.mimeType) ? "attached_native=true" : `path=${attachment.localPath}`;
    const parts = [
      `${label} ${index + 1}:`,
      delivery,
      attachment.filename ? `filename=${attachment.filename}` : undefined,
      attachment.mimeType ? `mime=${attachment.mimeType}` : undefined,
      `sha256=${attachment.sha256}`,
    ].filter(Boolean);
    return parts.join(" ");
  });

  const prefix = input.text.trim().length > 0 ? input.text.trim() : "Please inspect the attached local file reference(s).";
  return { text: `${prefix}\n\nAttachments cached by Hitch:\n${attachmentLines.join("\n")}`, images };
}

function isPiImageMimeType(mimeType: string | undefined): boolean {
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp" || mimeType === "image/gif";
}

function parseSlashCommand(raw: string): { name: string; args: string[] } {
  const [command = "", ...args] = raw.trim().split(/\s+/);
  const name = command.startsWith("/") ? command.slice(1) : command;
  return {
    name: name.split("@")[0]?.toLowerCase() ?? "",
    args,
  };
}

function piArgsForSession(args: string[], session: HubSession): string[] {
  if (hasExplicitSessionArg(args)) {
    return args;
  }
  return [...args, "--session-id", session.backendSessionId ?? session.id];
}

function hasExplicitSessionArg(args: string[]): boolean {
  const flags = new Set(["--no-session", "--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork"]);
  return args.some((arg) => flags.has(arg) || arg.startsWith("--session=") || arg.startsWith("--session-id=") || arg.startsWith("--fork="));
}

function formatModel(model: AgentModelInfo | undefined): string {
  if (!model) {
    return "none";
  }
  if (model.provider && model.id) {
    return `${model.provider}/${model.id}`;
  }
  return model.name ?? model.id ?? model.provider ?? "unknown";
}

function modelSelectionInteraction(models: AgentModelInfo[], title: string): AgentInteraction {
  return {
    kind: "pi.model.select",
    title,
    options: models
      .filter((model) => model.provider && model.id)
      .map((model) => ({
        label: formatModel(model),
        ...(model.name && model.name !== model.id ? { description: model.name } : {}),
        value: {
          provider: model.provider,
          modelId: model.id,
        },
      })),
    pageSize: 10,
  };
}

export function mapPiEvent(value: unknown): AgentEvent[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === "response") {
    if (record.success === false) {
      return [failedPiEvent("Pi RPC command failed", record.error)];
    }
    return [];
  }

  if (type === "agent_start" || type === "turn_start") {
    return [{ type: "status", state: "running" }];
  }

  if (type === "agent_end") {
    if (record.willRetry === true) {
      return [{ type: "status", state: "running" }];
    }
    return [
      { type: "status", state: "idle" },
      finalEventFromPiAgentEnd(record),
    ];
  }

  if (type === "agent_settled") {
    return [];
  }

  if (type === "message_update") {
    const assistantMessageEvent = record.assistantMessageEvent;
    if (assistantMessageEvent && typeof assistantMessageEvent === "object") {
      const delta = assistantMessageEvent as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        return [{ type: "text_delta", text: delta.delta }];
      }
      if (delta.type === "thinking_delta") {
        return [{ type: "activity", kind: "thinking" }];
      }
      if (delta.type === "toolcall_start" || delta.type === "toolcall_delta" || delta.type === "toolcall_end") {
        return [{ type: "activity", kind: "stream" }];
      }
    }
  }

  if (type === "message_end") {
    const message = record.message;
    if (isRecord(message) && message.role === "assistant") {
      const stopReason = assistantStopReason(message.stopReason);
      return [
        {
          type: "assistant_message_end",
          messageId: assistantMessageId(message),
          text: extractAssistantText(message),
          stopReason,
          hasToolCalls: assistantHasToolCalls(message),
        },
      ];
    }
    return [];
  }

  if (type === "auto_retry_start") {
    const maxAttempts = positiveInteger(record.maxAttempts);
    const delayMs = nonNegativeInteger(record.delayMs);
    return [
      {
        type: "retry",
        state: "scheduled",
        attempt: positiveInteger(record.attempt) ?? 1,
        ...(maxAttempts ? { maxAttempts } : {}),
        ...(delayMs !== undefined ? { delayMs } : {}),
        ...(typeof record.errorMessage === "string" ? { error: record.errorMessage } : {}),
      },
    ];
  }

  if (type === "auto_retry_end") {
    return [
      {
        type: "retry",
        state: "finished",
        attempt: positiveInteger(record.attempt) ?? 1,
        ...(typeof record.success === "boolean" ? { succeeded: record.success } : {}),
        ...(typeof record.finalError === "string" ? { error: record.finalError } : {}),
      },
    ];
  }

  if (type === "tool_execution_start") {
    return [
      {
        type: "tool_call",
        ...(typeof record.toolCallId === "string" ? { id: record.toolCallId } : {}),
        name: String(record.toolName ?? "tool"),
        preview: JSON.stringify(record.args ?? {}),
      },
    ];
  }

  if (type === "tool_execution_update") {
    return [
      {
        type: "tool_progress",
        ...(typeof record.toolCallId === "string" ? { id: record.toolCallId } : {}),
        name: String(record.toolName ?? "tool"),
      },
    ];
  }

  if (type === "tool_execution_end") {
    const text = extractTextContent(record.result) ?? extractErrorText(record);
    const succeeded = inferToolSucceeded(record);
    return [
      {
        type: "tool_result",
        ...(typeof record.toolCallId === "string" ? { id: record.toolCallId } : {}),
        name: String(record.toolName ?? "tool"),
        ...(succeeded === undefined ? {} : { succeeded }),
        ...(text ? { text } : {}),
      },
    ];
  }

  if (type === "extension_ui_request") {
    if (record.method === "notify" && typeof record.message === "string") {
      return [{ type: "notification", text: record.message, ...(typeof record.notifyType === "string" ? { level: record.notifyType } : {}) }];
    }
    if (isFireAndForgetExtensionUi(record)) {
      return [];
    }
    if (record.method === "input") {
      return [{ type: "notification", text: piUiInputText(record), completesTurn: true }];
    }
    if (record.method === "editor") {
      const text = piUiEditorText(record);
      return text ? [{ type: "notification", text, completesTurn: true }] : [{ type: "notification", text: "Pi editor requested.", completesTurn: true }];
    }
    if (record.method === "select") {
      const interaction = piUiSelectInteraction(record);
      if (interaction) {
        return [{ type: "interaction_request", interaction, raw: record }];
      }
    }
    return [{ type: "approval_request", raw: record }];
  }

  if (type === "extension_error") {
    return [failedPiEvent("Pi extension error", record.error)];
  }

  return [];
}

function modelInfoFromValue(value: unknown): AgentModelInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = typeof value.provider === "string" ? value.provider : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  if (!provider && !id && !name) {
    return undefined;
  }
  return {
    ...(provider ? { provider } : {}),
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function piUiSelectInteraction(record: Record<string, unknown>): AgentInteraction | undefined {
  if (typeof record.id !== "string") {
    return undefined;
  }

  const options = piUiSelectOptions(record.id, record.options ?? record.items ?? record.choices);
  if (options.length === 0) {
    return undefined;
  }

  return {
    kind: "pi.ui.select",
    title: piUiTitle(record),
    options,
    pageSize: 10,
  };
}

function piUiSelectOptions(requestId: string, rawOptions: unknown): Array<{ label: string; description?: string; value: unknown }> {
  if (!Array.isArray(rawOptions)) {
    return [];
  }

  return rawOptions.map((option) => piUiSelectOption(requestId, option)).filter((option): option is AgentInteraction["options"][number] => option !== undefined);
}

function piUiSelectOption(requestId: string, option: unknown): AgentInteraction["options"][number] | undefined {
  if (typeof option === "string") {
    return { label: option, value: { requestId, value: option } };
  }
  if (!isRecord(option)) {
    return undefined;
  }

  const label = stringField(option, ["label", "text", "name", "title", "id", "key", "value"]);
  if (!label) {
    return undefined;
  }

  const description = stringField(option, ["description", "detail", "subtitle", "hint"]);
  const value = firstPresentField(option, ["value", "id", "key", "name", "label", "text", "title"]) ?? option;
  return {
    label,
    ...(description ? { description } : {}),
    value: { requestId, value },
  };
}

function piUiTitle(record: Record<string, unknown>): string {
  return stringField(record, ["title", "message", "prompt", "label", "question"]) ?? "Select option";
}

function piUiSelectionPayload(value: unknown): { requestId: string; value: unknown } {
  if (!isRecord(value) || typeof value.requestId !== "string" || !Object.prototype.hasOwnProperty.call(value, "value")) {
    throw new Error("Invalid Pi UI selection payload.");
  }
  return { requestId: value.requestId, value: value.value };
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return undefined;
}

function firstPresentField(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function piUiEditorText(record: Record<string, unknown>): string | undefined {
  const title = stringField(record, ["title", "message", "prompt", "label"]) ?? "Pi editor";
  const text = typeof record.prefill === "string" ? record.prefill : typeof record.text === "string" ? record.text : "";
  return text.length > 0 ? `Pi editor: ${title}\n\n${text}` : `Pi editor: ${title}`;
}

function piUiInputText(record: Record<string, unknown>): string {
  const title = stringField(record, ["title", "message", "prompt", "label"]) ?? "Pi input";
  const placeholder = typeof record.placeholder === "string" && record.placeholder.length > 0 ? `\n${record.placeholder}` : "";
  return `Pi input requested: ${title}${placeholder}`;
}

function piExtensionUiAutoResponse(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw) || raw.type !== "extension_ui_request" || typeof raw.id !== "string") {
    return undefined;
  }

  if (raw.method === "input" || raw.method === "editor") {
    return { type: "extension_ui_response", id: raw.id, cancelled: true };
  }

  return undefined;
}

function piApprovalResponse(raw: unknown, decision: "allowed" | "denied"): Record<string, unknown> {
  if (!isRecord(raw) || raw.type !== "extension_ui_request" || typeof raw.id !== "string") {
    throw new Error("Approval is not a Pi extension UI request.");
  }

  const method = typeof raw.method === "string" ? raw.method : "";
  switch (method) {
    case "confirm":
      return { type: "extension_ui_response", id: raw.id, confirmed: decision === "allowed" };
    case "select": {
      if (decision === "denied") {
        const deniedValue = selectOption(raw.options, ["no", "block", "deny", "reject", "cancel", "stop"]);
        return deniedValue
          ? { type: "extension_ui_response", id: raw.id, value: deniedValue }
          : { type: "extension_ui_response", id: raw.id, cancelled: true };
      }

      const allowedValue = selectOption(raw.options, ["allow", "yes", "approve", "proceed", "continue", "ok"]);
      return {
        type: "extension_ui_response",
        id: raw.id,
        value: allowedValue ?? firstString(raw.options) ?? "",
      };
    }
    case "input":
    case "editor":
      return { type: "extension_ui_response", id: raw.id, cancelled: true };
    default:
      throw new Error(`Unsupported Pi extension UI approval method: ${method || "unknown"}`);
  }
}

function selectOption(options: unknown, needles: string[]): string | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }

  return options.find((option): option is string => {
    if (typeof option !== "string") {
      return false;
    }
    const normalized = option.toLowerCase();
    return needles.some((needle) => normalized.includes(needle));
  });
}

function firstString(options: unknown): string | undefined {
  return Array.isArray(options) ? options.find((option): option is string => typeof option === "string") : undefined;
}

function isFireAndForgetExtensionUi(record: Record<string, unknown>): boolean {
  return (
    record.method === "notify" ||
    record.method === "setStatus" ||
    record.method === "setWidget" ||
    record.method === "setTitle" ||
    record.method === "set_editor_text"
  );
}

function extractFinalText(record: Record<string, unknown>): string {
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    return "Pi finished without a final response.";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant") {
      if (isRecord(message) && message.stopReason === "aborted") {
        return extractAssistantText(message);
      }
      if (isRecord(message) && message.stopReason === "error") {
        const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "unknown error";
        return `Pi failed: ${sanitizePiFailure(errorMessage)}`;
      }
      const text = extractAssistantText(message);
      if (text.length > 0) {
        return text;
      }
    }
  }

  return "Pi finished without a final response.";
}

function sanitizePiFailure(value: string): string {
  return value
    .replace(/(authorization\s*[:=]?\s*bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "unknown error";
}

function failedPiEvent(
  label: string,
  error: unknown,
): Extract<AgentEvent, { type: "final" }> {
  return {
    type: "final",
    text: `${label}: ${sanitizePiFailure(String(error ?? "unknown error"))}`,
    failed: true,
  };
}

function finalEventFromPiAgentEnd(record: Record<string, unknown>): Extract<AgentEvent, { type: "final" }> {
  const interrupted = finalMessageWasInterrupted(record);
  const message = lastAssistantMessage(record);
  const failed = message?.stopReason === "error";
  return {
    type: "final",
    text: extractFinalText(record),
    ...(message ? { messageId: assistantMessageId(message) } : {}),
    ...(interrupted ? { interrupted: true } : {}),
    ...(failed ? { failed: true } : {}),
  };
}

function lastAssistantMessage(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function assistantMessageId(message: Record<string, unknown>): string {
  const toolCallIds = Array.isArray(message.content)
    ? message.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "toolCall")
        .map((part) => (typeof part.id === "string" ? part.id : ""))
    : [];
  const identity = JSON.stringify({
    responseId: typeof message.responseId === "string" ? message.responseId : undefined,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    text: extractAssistantText(message),
    toolCallIds,
  });
  return `pi-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function assistantStopReason(
  value: unknown,
): Extract<AgentEvent, { type: "assistant_message_end" }>["stopReason"] {
  return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted"
    ? value
    : "unknown";
}

function assistantHasToolCalls(message: Record<string, unknown>): boolean {
  return Array.isArray(message.content) && message.content.some((part) => isRecord(part) && part.type === "toolCall");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function finalMessageWasInterrupted(record: Record<string, unknown>): boolean {
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    return false;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    return message.stopReason === "aborted" || message.errorMessage === "Request was aborted";
  }
  return false;
}

async function waitForProcessExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    proc.once("exit", onExit);
  });
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractTextContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");

  return text.length > 0 ? text : undefined;
}

function extractErrorText(record: Record<string, unknown>): string | undefined {
  if (typeof record.error === "string" && record.error.length > 0) {
    return record.error;
  }

  const result = record.result;
  if (isRecord(result) && typeof result.error === "string" && result.error.length > 0) {
    return result.error;
  }

  return undefined;
}

function inferToolSucceeded(record: Record<string, unknown>): boolean | undefined {
  // pi's `tool_execution_end` event carries `isError` at the top level
  // (see pi docs/extensions.md: tool_execution_end -> event.isError).
  if (typeof record.isError === "boolean") {
    return !record.isError;
  }
  if (typeof record.success === "boolean") {
    return record.success;
  }
  if (typeof record.ok === "boolean") {
    return record.ok;
  }
  if (typeof record.error === "string" && record.error.length > 0) {
    return false;
  }

  const result = record.result;
  if (!isRecord(result)) {
    return undefined;
  }
  if (typeof result.isError === "boolean") {
    return !result.isError;
  }
  if (typeof result.success === "boolean") {
    return result.success;
  }
  if (typeof result.ok === "boolean") {
    return result.ok;
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    return false;
  }

  return undefined;
}

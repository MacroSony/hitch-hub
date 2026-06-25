import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { HubConfig } from "../config/schema.js";
import type { HubSession } from "../core/types.js";
import { attachJsonlReader } from "../utils/jsonl-reader.js";
import type { AgentBackend, AgentEvent, AgentInput } from "./types.js";

type SpawnSpec = {
  command: string;
  args: string[];
};

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

  constructor(private readonly config: HubConfig) {}

  async start(session: HubSession): Promise<number | undefined> {
    if (this.proc) {
      return this.proc.pid;
    }

    const piConfig = this.config.agents.pi;
    const spawnSpec = resolveSpawnSpec(piConfig.command, piConfig.default_args);
    this.proc = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: session.cwd,
      env: {
        ...process.env,
        PI_OFFLINE: process.env.PI_OFFLINE ?? "1",
      },
      windowsHide: true,
    });

    attachJsonlReader(
      this.proc.stdout,
      (value) => {
        for (const event of mapPiEvent(value)) {
          this.eventsQueue.push(event);
        }
      },
      (error) => {
        this.eventsQueue.push({ type: "final", text: `Pi RPC parse error: ${error.message}` });
      },
    );

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        this.eventsQueue.push({ type: "tool_result", name: "stderr", text });
      }
    });

    this.proc.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        this.eventsQueue.push({ type: "final", text: `Pi RPC process exited with code ${code ?? "unknown"}.` });
      }
      this.eventsQueue.close();
    });

    return this.proc.pid;
  }

  async send(input: AgentInput): Promise<void> {
    if (!this.proc) {
      throw new Error("Pi RPC process has not been started.");
    }

    this.proc.stdin.write(`${JSON.stringify({ type: "prompt", message: input.text })}\n`);
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield* this.eventsQueue.iterate();
  }

  async abort(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
    }
    this.proc?.kill("SIGTERM");
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }
}

function mapPiEvent(value: unknown): AgentEvent[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === "response") {
    if (record.success === false) {
      return [{ type: "final", text: String(record.error ?? "Pi RPC command failed.") }];
    }
    return [];
  }

  if (type === "agent_start" || type === "turn_start") {
    return [{ type: "status", state: "running" }];
  }

  if (type === "agent_end") {
    return [{ type: "status", state: "idle" }, { type: "final", text: extractFinalText(record) }];
  }

  if (type === "message_update") {
    const assistantMessageEvent = record.assistantMessageEvent;
    if (assistantMessageEvent && typeof assistantMessageEvent === "object") {
      const delta = assistantMessageEvent as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        return [{ type: "text_delta", text: delta.delta }];
      }
    }
  }

  if (type === "tool_execution_start") {
    return [
      {
        type: "tool_call",
        name: String(record.toolName ?? "tool"),
        preview: JSON.stringify(record.args ?? {}),
      },
    ];
  }

  if (type === "tool_execution_end") {
    const text = extractTextContent(record.result);
    return [
      {
        type: "tool_result",
        name: String(record.toolName ?? "tool"),
        ...(text ? { text } : {}),
      },
    ];
  }

  if (type === "extension_ui_request") {
    return [{ type: "approval_request", raw: record }];
  }

  if (type === "extension_error") {
    return [{ type: "final", text: String(record.error ?? "Pi extension error.") }];
  }

  return [];
}

function extractFinalText(record: Record<string, unknown>): string {
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    return "Pi completed.";
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && (message as Record<string, unknown>).role === "assistant") {
      const text = extractAssistantText(message);
      if (text.length > 0) {
        return text;
      }
    }
  }

  return "Pi completed.";
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

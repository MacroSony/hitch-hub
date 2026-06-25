import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { HubConfig } from "../config/schema.js";
import type { HubSession } from "../core/types.js";
import type { AgentBackend, AgentEvent, AgentInput } from "./types.js";

function resolveCommand(command: string): string {
  if (process.platform !== "win32" || path.extname(command)) {
    return command;
  }

  const appData = process.env.APPDATA;
  if (!appData) {
    return command;
  }

  const cmdShim = path.join(appData, "npm", `${command}.cmd`);
  return existsSync(cmdShim) ? cmdShim : command;
}

export class PiRpcBackend implements AgentBackend {
  private proc: ChildProcessWithoutNullStreams | undefined;

  constructor(private readonly config: HubConfig) {}

  async start(session: HubSession): Promise<void> {
    if (this.proc) {
      return;
    }

    const piConfig = this.config.agents.pi;
    const command = resolveCommand(piConfig.command);
    this.proc = spawn(command, piConfig.default_args, {
      cwd: session.cwd,
      env: {
        ...process.env,
        PI_OFFLINE: process.env.PI_OFFLINE ?? "1",
      },
      windowsHide: true,
    });
  }

  async send(input: AgentInput): Promise<void> {
    if (!this.proc) {
      throw new Error("Pi RPC process has not been started.");
    }

    this.proc.stdin.write(`${JSON.stringify({ type: "user_message", text: input.text })}${os.EOL}`);
  }

  async *events(): AsyncIterable<AgentEvent> {
    throw new Error("Pi RPC event decoding is pending the protocol smoke test.");
  }

  async abort(): Promise<void> {
    this.proc?.kill("SIGTERM");
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
  }
}

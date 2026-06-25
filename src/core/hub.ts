import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { ChannelAdapter, InboundChatEvent } from "../channels/types.js";
import { parseCommand } from "../commands/parser.js";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import { AuditLog } from "./audit-log.js";
import { isPathInsideAllowedRoots } from "./path-policy.js";
import { SessionRegistry } from "./session-registry.js";
import type { AgentName, HubSession } from "./types.js";

export class RemoteAgentHub {
  private readonly sessions: SessionRegistry;
  private readonly audit: AuditLog;

  constructor(
    private readonly config: HubConfig,
    private readonly channel: ChannelAdapter,
  ) {
    this.sessions = new SessionRegistry(config.dataDir);
    this.audit = new AuditLog(config.dataDir);
  }

  async run(): Promise<void> {
    for await (const event of this.channel.receive()) {
      await this.handleEvent(event);
    }
  }

  private async handleEvent(event: InboundChatEvent): Promise<void> {
    try {
      const command = parseCommand(event.text);

      switch (command.type) {
        case "new":
          await this.handleNew(event, command.agent, command.cwd);
          return;
        case "status":
          await this.handleStatus(event);
          return;
        case "cwd":
          await this.handleCwd(event);
          return;
        case "abort":
          await this.handleAbort(event);
          return;
        case "prompt":
          await this.handlePrompt(event, command.text);
          return;
      }
    } catch (error) {
      await this.channel.sendText(event.target, error instanceof Error ? error.message : String(error), {
        replyToEventId: event.id,
      });
    }
  }

  private async handleNew(event: InboundChatEvent, rawAgent: string, rawCwd: string): Promise<void> {
    const agent = this.parseAgent(rawAgent);
    const cwd = path.resolve(rawCwd);

    if (!isPathInsideAllowedRoots(cwd, this.config.allowedRoots)) {
      await this.audit.write({
        type: "session.rejected_cwd",
        target: event.target,
        details: { cwd },
      });
      await this.channel.sendText(event.target, `Rejected cwd outside allowed roots: ${cwd}`);
      return;
    }

    const session = this.sessions.createSession(event.target, agent, cwd);
    await this.audit.write({
      type: "session.created",
      sessionId: session.id,
      target: event.target,
      details: { agent, cwd },
    });

    await this.channel.sendText(
      event.target,
      `Created session ${shortId(session)}\nagent: ${session.agent}\ncwd: ${session.cwd}`,
    );
  }

  private async handleStatus(event: InboundChatEvent): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.channel.sendText(event.target, "No active session.");
      return;
    }

    await this.channel.sendText(
      event.target,
      `Session ${shortId(session)}\nagent: ${session.agent}\nstatus: ${session.status}\ncwd: ${session.cwd}`,
    );
  }

  private async handleCwd(event: InboundChatEvent): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    await this.channel.sendText(event.target, session ? session.cwd : "No active session.");
  }

  private async handleAbort(event: InboundChatEvent): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.channel.sendText(event.target, "No active session to abort.");
      return;
    }

    this.sessions.updateStatus(session.id, "stopped");
    await this.audit.write({
      type: "session.aborted",
      sessionId: session.id,
      target: event.target,
    });
    await this.channel.sendText(event.target, `Stopped session ${shortId(session)}.`);
  }

  private async handlePrompt(event: InboundChatEvent, text: string): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.channel.sendText(event.target, "No active session. Start one with `!new pi <cwd>`.");
      return;
    }

    if (session.status === "running") {
      await this.channel.sendText(event.target, "Session is already running. Use `!abort` before sending another turn.");
      return;
    }

    await this.audit.write({
      type: "prompt.received",
      sessionId: session.id,
      target: event.target,
      details: { length: text.length },
    });

    const backend = new PiRpcBackend(this.config);
    void backend;
    await this.channel.sendText(
      event.target,
      "Prompt routing is ready at the hub boundary. Pi RPC event decoding is the next implementation step.",
    );
  }

  private parseAgent(value: string): AgentName {
    if (value !== "pi") {
      throw new Error(`Unsupported agent for Iteration 1: ${value}`);
    }
    return value;
  }
}

function shortId(session: HubSession): string {
  return session.id.slice(0, 8);
}

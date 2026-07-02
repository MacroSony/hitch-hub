import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { ChannelAdapter, InboundChatEvent } from "../channels/types.js";
import { parseCommand } from "../commands/parser.js";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import type { AgentBackend, AgentCommandResult, AgentEvent } from "../agents/types.js";
import { AuditLog } from "./audit-log.js";
import { isPathInsideAllowedRoots } from "./path-policy.js";
import { SessionRegistry, type PendingInteraction, type PendingInteractionOption } from "./session-registry.js";
import type { AgentName, ChatTarget, HubSession } from "./types.js";

const INTERACTION_TTL_MS = 5 * 60 * 1000;

export class RemoteAgentHub {
  private readonly sessions: SessionRegistry;
  private readonly audit: AuditLog;
  private readonly workers = new Map<string, AgentBackend>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly config: HubConfig,
    private readonly channel: ChannelAdapter,
    private readonly backendFactory: (config: HubConfig) => AgentBackend = (config) => new PiRpcBackend(config),
  ) {
    this.sessions = new SessionRegistry(config.dataDir);
    this.sessions.recoverInterruptedSessions();
    this.audit = new AuditLog(config.dataDir);
  }

  async run(): Promise<void> {
    try {
      for await (const event of this.channel.receive()) {
        if (shouldHandleInBackground(event)) {
          const task = this.handleEvent(event).catch((error: unknown) => {
            process.stderr.write(`[hitch] Event handling failed: ${formatError(error)}\n`);
          });
          this.inFlight.add(task);
          task.finally(() => {
            this.inFlight.delete(task);
          });
          continue;
        }

        await this.handleEvent(event);
      }
    } finally {
      await Promise.allSettled(this.inFlight);
      await this.stopWorkers();
    }
  }

  private async handleEvent(event: InboundChatEvent): Promise<void> {
    try {
      if (!this.isAuthorizedTarget(event)) {
        await this.channel.sendText(event.target, "Unauthorized chat/user.");
        return;
      }

      if (await this.handlePendingInteractionSelection(event)) {
        return;
      }

      const command = parseCommand(event.text);

      switch (command.type) {
        case "new":
          await this.handleNew(event, command.agent, command.cwd, command.name);
          return;
        case "status":
          await this.handleStatus(event);
          return;
        case "sessions":
          await this.handleSessions(event);
          return;
        case "switch":
          await this.handleSwitch(event, command.ref);
          return;
        case "cwd":
          await this.handleCwd(event);
          return;
        case "abort":
          await this.handleAbort(event);
          return;
        case "approve":
          await this.handleApprovalDecision(event, command.id, "allowed");
          return;
        case "deny":
          await this.handleApprovalDecision(event, command.id, "denied");
          return;
        case "agent_command":
          await this.handleAgentCommand(event, command.raw);
          return;
        case "prompt":
          await this.handlePrompt(event, command.text);
          return;
      }
    } catch (error) {
      await this.safeSendText(event.target, error instanceof Error ? error.message : String(error), {
        replyToEventId: event.id,
      });
    }
  }

  private async handleNew(event: InboundChatEvent, rawAgent: string, rawCwd?: string, name?: string): Promise<void> {
    const agent = this.parseAgent(rawAgent);
    const cwd = this.resolveRequestedCwd(rawCwd);
    const activeSession = this.sessions.getActiveForTarget(event.target);
    if (activeSession && isTurnBlocked(activeSession)) {
      await this.sendChunkedText(
        event.target,
        `Active session ${shortId(activeSession)} is ${activeSession.status}. Use \`!status\`, \`!abort\`, or finish the current turn before creating a new session.`,
      );
      return;
    }

    if (!isPathInsideAllowedRoots(cwd, this.config.allowedRoots)) {
      await this.audit.write({
        type: "session.rejected_cwd",
        target: event.target,
        details: { cwd },
      });
      await this.channel.sendText(event.target, `Rejected cwd outside allowed roots: ${cwd}`);
      return;
    }

    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      await this.audit.write({
        type: "session.rejected_missing_cwd",
        target: event.target,
        details: { cwd },
      });
      await this.sendChunkedText(event.target, `Rejected cwd because it is not an existing directory: ${cwd}`);
      return;
    }

    const session = this.sessions.createSession(event.target, agent, cwd, name);
    await this.audit.write({
      type: "session.created",
      sessionId: session.id,
      target: event.target,
      details: { agent, cwd, name },
    });

    await this.sendChunkedText(
      event.target,
      `${activeSession ? `Created and switched to session ${shortId(session)}` : `Created session ${shortId(session)}`}\n${session.name ? `name: ${session.name}\n` : ""}agent: ${session.agent}\ncwd: ${session.cwd}`,
    );
  }

  private async handleStatus(event: InboundChatEvent): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session.");
      return;
    }

    await this.sendChunkedText(
      event.target,
      `Session ${shortId(session)}\nagent: ${session.agent}\nstatus: ${session.status}\ncwd: ${session.cwd}`,
    );
  }

  private async handleSessions(event: InboundChatEvent): Promise<void> {
    const sessions = this.sessions.listForTarget(event.target);
    if (sessions.length === 0) {
      await this.sendChunkedText(event.target, "No sessions.");
      return;
    }

    const active = this.sessions.getActiveForTarget(event.target);
    const options = sessions.map((session) => ({
      label: session.name ? `${session.name} (${shortId(session)})` : shortId(session),
      description: `${active?.id === session.id ? "active | " : ""}${session.status} | ${session.agent} | ${session.cwd}`,
      value: { sessionId: session.id },
    }));
    await this.createAndSendInteraction(event.target, {
      owner: "hub",
      kind: "hub.session.switch",
      title: "Select session",
      options,
    });
  }

  private async handleSwitch(event: InboundChatEvent, ref: string): Promise<void> {
    const session = this.sessions.findForTarget(event.target, ref);
    if (!session) {
      await this.sendChunkedText(event.target, `No session found for ${ref}. Use \`!sessions\` to list sessions.`);
      return;
    }

    this.sessions.selectSession(session.id);
    const selected = this.sessions.getById(session.id) ?? session;
    await this.audit.write({
      type: "session.selected",
      sessionId: session.id,
      target: event.target,
      details: { ref },
    });
    await this.sendChunkedText(
      event.target,
      `Switched to session ${shortId(selected)}${selected.name ? ` (${selected.name})` : ""}\nstatus: ${selected.status}\ncwd: ${selected.cwd}`,
    );
  }

  private async handleCwd(event: InboundChatEvent): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    await this.sendChunkedText(event.target, session ? session.cwd : "No active session.");
  }

  private async handleAbort(event: InboundChatEvent): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session to abort.");
      return;
    }

    const worker = this.workers.get(session.id);
    await worker?.abort();
    this.workers.delete(session.id);
    this.sessions.updateStatus(session.id, "stopped");
    await this.audit.write({
      type: "session.aborted",
      sessionId: session.id,
      target: event.target,
    });
    await this.sendChunkedText(event.target, `Stopped session ${shortId(session)}.`);
  }

  private async handleAgentCommand(event: InboundChatEvent, raw: string): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session. Start one with `!new pi <cwd>`.");
      return;
    }

    if (isTurnBlocked(session)) {
      await this.sendBlockedTurn(event, session, "agent command");
      return;
    }

    const backend = this.getWorker(session);

    if (!backend.executeCommand) {
      await this.sendChunkedText(event.target, "This agent does not support native command passthrough.");
      return;
    }

    try {
      const processId = await backend.start(session);
      this.sessions.setBackendProcess(session.id, processId);
      await this.audit.write({
        type: "agent_command.received",
        sessionId: session.id,
        target: event.target,
        details: { command: raw, attachments: event.attachments?.length ?? 0 },
      });

      const input = event.attachments ? { raw, attachments: event.attachments } : { raw };
      const result = await backend.executeCommand(input);
      await this.handleAgentCommandResult(event.target, session, backend, result);
    } catch (error) {
      this.updateStatusUnlessStopped(session.id, "error");
      await this.audit.write({
        type: "agent_command.error",
        sessionId: session.id,
        target: event.target,
        details: { command: raw, error: error instanceof Error ? error.message : String(error) },
      });
      await this.sendChunkedText(event.target, error instanceof Error ? error.message : String(error));
    } finally {
      if (!backend.isAlive()) {
        this.workers.delete(session.id);
      }
    }
  }

  private async handlePrompt(event: InboundChatEvent, text: string): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session. Start one with `!new pi <cwd>`.");
      return;
    }

    if (isTurnBlocked(session)) {
      await this.sendBlockedTurn(event, session, "message");
      return;
    }

    this.sessions.updateStatus(session.id, "running");
    await this.audit.write({
      type: "prompt.received",
      sessionId: session.id,
      target: event.target,
      details: { length: text.length, attachments: event.attachments?.length ?? 0 },
    });

    const backend = this.getWorker(session);

    try {
      const processId = await backend.start(session);
      this.sessions.setBackendProcess(session.id, processId);
      await this.audit.write({
        type: "worker.started",
        sessionId: session.id,
        target: event.target,
        details: { processId },
      });

      await backend.send(event.attachments ? { text, attachments: event.attachments } : { text });
      await this.consumeAgentEvents(session, backend);
    } catch (error) {
      this.updateStatusUnlessStopped(session.id, "error");
      await this.audit.write({
        type: "worker.error",
        sessionId: session.id,
        target: event.target,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      await this.sendChunkedText(event.target, error instanceof Error ? error.message : String(error));
    } finally {
      if (!backend.isAlive()) {
        this.workers.delete(session.id);
      }
    }
  }

  private async handleApprovalDecision(
    event: InboundChatEvent,
    approvalId: string,
    decision: "allowed" | "denied",
  ): Promise<void> {
    const approval = this.sessions.getPendingApproval(approvalId);
    if (!approval) {
      await this.audit.write({
        type: "approval.decided",
        target: event.target,
        details: { approvalId, decision, updated: false },
      });
      await this.sendChunkedText(event.target, `No pending approval found for ${approvalId}.`);
      return;
    }

    const session = this.sessions.getById(approval.sessionId);
    if (!session || !targetMatchesSession(event.target, session)) {
      await this.audit.write({
        type: "approval.rejected_target",
        sessionId: approval.sessionId,
        target: event.target,
        details: { approvalId, decision },
      });
      await this.sendChunkedText(event.target, `No pending approval found for ${approvalId}.`);
      return;
    }

    const backend = this.workers.get(approval.sessionId);
    if (backend?.respondToApproval) {
      if (!backend.isAlive()) {
        await this.sendChunkedText(event.target, `Approval ${approvalId} could not be delivered because the agent is not running.`);
        return;
      }
      await backend.respondToApproval(approval.raw, decision);
    }

    this.sessions.updateApprovalStatus(approvalId, decision);
    await this.audit.write({
      type: "approval.decided",
      sessionId: approval.sessionId,
      target: event.target,
      details: { approvalId, decision, delivered: Boolean(backend?.respondToApproval) },
    });

    await this.sendChunkedText(event.target, `Approval ${approvalId} ${decision}.`);
  }

  private async handlePendingInteractionSelection(event: InboundChatEvent): Promise<boolean> {
    const selection = selectionNumberFromText(event.text);
    if (selection === undefined) {
      return false;
    }

    const interaction = this.sessions.getPendingInteractionForTarget(event.target);
    if (!interaction) {
      return false;
    }

    const page = interactionPage(interaction);
    const pageCount = Math.max(1, Math.ceil(interaction.options.length / interaction.pageSize));
    if (selection === 0) {
      const updated = this.sessions.updatePendingInteractionPage(interaction.id, (interaction.pageIndex + 1) % pageCount);
      await this.sendInteractionMenu(event.target, updated ?? interaction);
      return true;
    }

    const option = page[selection - 1];
    if (!option) {
      await this.sendChunkedText(event.target, `No option ${selection} for this menu.`);
      await this.sendInteractionMenu(event.target, interaction);
      return true;
    }

    this.sessions.deletePendingInteraction(interaction.id);
    await this.executeInteractionSelection(event.target, interaction, option);
    return true;
  }

  private async executeInteractionSelection(
    target: ChatTarget,
    interaction: PendingInteraction,
    option: PendingInteractionOption,
  ): Promise<void> {
    if (interaction.owner === "hub") {
      await this.executeHubSelection(target, interaction, option);
      return;
    }

    const session = interaction.sessionId ? this.sessions.getById(interaction.sessionId) : this.sessions.getActiveForTarget(target);
    if (!session || !targetMatchesSession(target, session)) {
      await this.sendChunkedText(target, "The selected session is no longer available.");
      return;
    }
    if (isTurnBlocked(session)) {
      await this.sendChunkedText(target, blockedTurnMessage(session, "selection"));
      return;
    }

    const backend = this.getWorker(session);
    if (!backend.executeSelection) {
      await this.sendChunkedText(target, "This agent does not support interactive selections.");
      return;
    }

    try {
      const processId = await backend.start(session);
      this.sessions.setBackendProcess(session.id, processId);
      const result = await backend.executeSelection({
        kind: interaction.kind,
        label: option.label,
        value: option.value,
      });
      await this.handleAgentCommandResult(target, session, backend, result);
    } catch (error) {
      this.updateStatusUnlessStopped(session.id, "error");
      await this.sendChunkedText(target, error instanceof Error ? error.message : String(error));
    } finally {
      if (!backend.isAlive()) {
        this.workers.delete(session.id);
      }
    }
  }

  private async executeHubSelection(
    target: ChatTarget,
    interaction: PendingInteraction,
    option: PendingInteractionOption,
  ): Promise<void> {
    if (interaction.kind !== "hub.session.switch") {
      await this.sendChunkedText(target, `Unsupported Hitch selection: ${interaction.kind}`);
      return;
    }

    const value = option.value;
    if (!isRecord(value) || typeof value.sessionId !== "string") {
      await this.sendChunkedText(target, "Invalid session selection.");
      return;
    }

    const session = this.sessions.getById(value.sessionId);
    if (!session || !targetMatchesSession(target, session)) {
      await this.sendChunkedText(target, "Selected session is no longer available.");
      return;
    }

    this.sessions.selectSession(session.id);
    const selected = this.sessions.getById(session.id) ?? session;
    await this.audit.write({
      type: "session.selected",
      sessionId: session.id,
      target,
      details: { ref: option.label, interactionId: interaction.id },
    });
    await this.sendChunkedText(
      target,
      `Switched to session ${shortId(selected)}${selected.name ? ` (${selected.name})` : ""}\nstatus: ${selected.status}\ncwd: ${selected.cwd}`,
    );
  }

  private async handleAgentCommandResult(
    target: ChatTarget,
    session: HubSession,
    backend: AgentBackend,
    result: AgentCommandResult,
  ): Promise<void> {
    if (result.text) {
      await this.sendChunkedText(target, result.text);
    }
    if (result.interaction) {
      await this.createAndSendInteraction(target, {
        owner: "agent",
        sessionId: session.id,
        kind: result.interaction.kind,
        title: result.interaction.title,
        options: result.interaction.options,
        ...(result.interaction.pageSize ? { pageSize: result.interaction.pageSize } : {}),
      });
    }
    if (result.consumesEvents) {
      this.sessions.updateStatus(session.id, "running");
      await this.consumeAgentEvents(session, backend);
    }
  }

  private async createAndSendInteraction(
    target: ChatTarget,
    input: {
      owner: "hub" | "agent";
      kind: string;
      title: string;
      options: PendingInteractionOption[];
      sessionId?: string;
      pageSize?: number;
    },
  ): Promise<void> {
    if (input.options.length === 0) {
      await this.sendChunkedText(target, "No options available.");
      return;
    }

    const interaction = this.sessions.createPendingInteraction(target, {
      ...input,
      expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString(),
    });
    await this.sendInteractionMenu(target, interaction);
  }

  private async sendInteractionMenu(target: ChatTarget, interaction: PendingInteraction): Promise<void> {
    await this.sendChunkedText(target, renderInteractionMenu(interaction));
  }

  private async sendBlockedTurn(event: InboundChatEvent, session: HubSession, inputKind: string): Promise<void> {
    if (session.status === "waiting_approval" && this.sessions.countPendingApprovalsForSession(session.id) === 0) {
      await this.sendChunkedText(
        event.target,
        `Session is waiting on an approval that is no longer pending. Use \`!abort\` or wait for the agent timeout before sending another ${inputKind}.`,
      );
      return;
    }

    await this.sendChunkedText(event.target, blockedTurnMessage(session, inputKind));
  }

  private parseAgent(value: string): AgentName {
    if (value !== "pi") {
      throw new Error(`Unsupported agent for Iteration 1: ${value}`);
    }
    return value;
  }

  private resolveRequestedCwd(rawCwd: string | undefined): string {
    const defaultCwd = this.config.defaultCwd;
    if (!defaultCwd) {
      throw new Error("No default cwd configured. Use `!new pi <absolute-cwd>` or set `default_cwd`.");
    }

    if (!rawCwd || rawCwd.trim().length === 0) {
      return path.resolve(defaultCwd);
    }

    const trimmed = rawCwd.trim();
    return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(defaultCwd, trimmed);
  }

  private getWorker(session: HubSession): AgentBackend {
    const existing = this.workers.get(session.id);
    if (existing) {
      return existing;
    }

    const backend = this.backendFactory(this.config);
    this.workers.set(session.id, backend);
    return backend;
  }

  private async stopWorkers(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(workers.map((worker) => worker.stop()));
  }

  private async consumeAgentEvents(session: HubSession, backend: AgentBackend): Promise<void> {
    let streamedText = "";
    let timedOut = false;
    const deliveredArtifactPaths = new Set<string>();
    const timeout = setTimeout(() => {
      timedOut = true;
      void backend.abort();
    }, this.config.agent_turn_timeout_ms);

    try {
      for await (const agentEvent of backend.events()) {
        if (this.sessions.getById(session.id)?.status === "stopped") {
          return;
        }
        const finished = await this.handleAgentEvent(session, agentEvent, streamedText, deliveredArtifactPaths);
        if (agentEvent.type === "text_delta") {
          streamedText += agentEvent.text;
        }
        if (finished) {
          this.updateStatusUnlessStopped(session.id, "idle");
          await this.audit.write({
            type: "worker.completed",
            sessionId: session.id,
            details: { streamedTextLength: streamedText.length },
          });
          return;
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (timedOut) {
      this.updateStatusUnlessStopped(session.id, "error");
      await this.audit.write({
        type: "worker.timeout",
        sessionId: session.id,
        details: { timeoutMs: this.config.agent_turn_timeout_ms },
      });
      await this.sendChunkedText(
        {
          platform: session.platform,
          chatId: session.chatId,
          ...(session.threadId ? { threadId: session.threadId } : {}),
          ...(session.userId ? { userId: session.userId } : {}),
        },
        `Agent turn timed out after ${this.config.agent_turn_timeout_ms}ms.`,
      );
      return;
    }

    if (this.sessions.getById(session.id)?.status === "stopped") {
      return;
    }

    this.sessions.updateStatus(session.id, "idle");
    await this.audit.write({
      type: "worker.exited",
      sessionId: session.id,
      details: { streamedTextLength: streamedText.length },
    });
    await this.sendChunkedText(
      {
        platform: session.platform,
        chatId: session.chatId,
        ...(session.threadId ? { threadId: session.threadId } : {}),
        ...(session.userId ? { userId: session.userId } : {}),
      },
      streamedText.length > 0 ? streamedText : "Pi worker exited before reporting a final response; session is idle.",
    );
  }

  private async handleAgentEvent(
    session: HubSession,
    event: AgentEvent,
    streamedText: string,
    deliveredArtifactPaths: Set<string>,
  ): Promise<boolean> {
    if (this.sessions.getById(session.id)?.status === "stopped") {
      return true;
    }

    const target = {
      platform: session.platform,
      chatId: session.chatId,
      ...(session.threadId ? { threadId: session.threadId } : {}),
      ...(session.userId ? { userId: session.userId } : {}),
    };

    switch (event.type) {
      case "text_delta":
        return false;
      case "final": {
        const finalText = streamedText.length > 0 && event.text === "Pi completed." ? streamedText : event.text;
        await this.sendChunkedText(target, finalText);
        await this.sendArtifactsMentionedInText(target, finalText, deliveredArtifactPaths);
        return true;
      }
      case "tool_call":
        await this.sendChunkedText(target, this.formatToolStart(event));
        return false;
      case "tool_result":
        await this.sendChunkedText(target, this.formatToolResult(event));
        return false;
      case "approval_request": {
        const method = piUiMethod(event.raw);
        const expiresAt = new Date(Date.now() + this.config.approval_timeout_ms).toISOString();
        const approvalId = this.sessions.createApproval({
          sessionId: session.id,
          agent: session.agent,
          actionKind: method ?? "unknown",
          cwd: session.cwd,
          title: method ? `Pi ${method} request` : "Pi approval request",
          preview: JSON.stringify(event.raw).slice(0, 1000),
          risk: "medium",
          raw: event.raw,
          expiresAt,
        });
        this.sessions.updateStatus(session.id, "waiting_approval");
        await this.safeSendText(
          target,
          `Approval requested: ${approvalId}\nexpires: ${expiresAt}\n\nFallback commands:\n!approve ${approvalId}\n!deny ${approvalId}`,
          {
            buttons: [
              { label: "Approve", text: `!approve ${approvalId}` },
              { label: "Deny", text: `!deny ${approvalId}` },
            ],
          },
        );
        return false;
      }
      case "status":
        this.updateStatusUnlessStopped(
          session.id,
          event.state === "running" ? "running" : event.state === "error" ? "error" : "idle",
        );
        return false;
    }
  }

  private async sendChunkedText(target: InboundChatEvent["target"], text: string): Promise<void> {
    const maxLength = 3900;
    if (text.length <= maxLength) {
      await this.safeSendText(target, text);
      return;
    }

    for (let start = 0; start < text.length; start += maxLength) {
      await this.safeSendText(target, text.slice(start, start + maxLength));
    }
  }

  private updateStatusUnlessStopped(id: string, status: HubSession["status"]): void {
    if (this.sessions.getById(id)?.status === "stopped") {
      return;
    }
    this.sessions.updateStatus(id, status);
  }

  private formatToolResult(event: Extract<AgentEvent, { type: "tool_result" }>): string {
    const status = event.succeeded === false ? "failed" : "succeeded";
    const summary = `Tool finished: ${event.name} (${status})`;
    return this.config.delivery.full_tool_output && event.text ? `${summary}\n${event.text}` : summary;
  }

  private formatToolStart(event: Extract<AgentEvent, { type: "tool_call" }>): string {
    const summary = `Tool started: ${event.name}`;
    return this.config.delivery.full_tool_output && event.preview ? `${summary}\n${event.preview}` : summary;
  }

  private async safeSendText(
    target: InboundChatEvent["target"],
    text: string,
    opts?: Parameters<ChannelAdapter["sendText"]>[2],
  ): Promise<void> {
    try {
      await this.channel.sendText(target, text, opts);
    } catch (error) {
      process.stderr.write(`[hitch] Send failed: ${formatError(error)}\n`);
    }
  }

  private async sendArtifactsMentionedInText(
    target: InboundChatEvent["target"],
    text: string,
    deliveredArtifactPaths: Set<string>,
  ): Promise<void> {
    if (!this.channel.sendArtifact) {
      return;
    }

    const artifacts = extractLocalArtifacts(text, [this.config.dataDir, ...this.config.allowedRoots])
      .filter((artifact) => !deliveredArtifactPaths.has(path.resolve(artifact.path)))
      .slice(0, Math.max(0, 5 - deliveredArtifactPaths.size));
    for (const artifact of artifacts) {
      deliveredArtifactPaths.add(path.resolve(artifact.path));
      try {
        const size = statSync(artifact.path).size;
        if (size > this.config.media.max_outbound_bytes) {
          await this.audit.write({
            type: "artifact.delivery",
            target,
            details: { path: artifact.path, kind: artifact.kind, status: "skipped", reason: "too_large", size },
          });
          continue;
        }

        await this.channel.sendArtifact(target, artifact);
        await this.audit.write({
          type: "artifact.delivery",
          target,
          details: { path: artifact.path, kind: artifact.kind, status: "sent", size },
        });
      } catch (error) {
        await this.audit.write({
          type: "artifact.delivery",
          target,
          details: { path: artifact.path, kind: artifact.kind, status: "failed", error: formatError(error) },
        });
        process.stderr.write(`[hitch] Artifact send failed for ${artifact.path}: ${formatError(error)}\n`);
      }
    }
  }

  private isAuthorizedTarget(event: InboundChatEvent): boolean {
    if (event.target.platform === "fake") {
      return true;
    }

    if (event.target.platform === "telegram") {
      if (this.config.channels.telegram.unsafe_allow_all) {
        return true;
      }

      const allowedChatIds = this.config.channels.telegram.allowed_chat_ids;
      if (allowedChatIds.length === 0 || !allowedChatIds.includes(event.target.chatId)) {
        return false;
      }

      const telegramUserIds = Object.values(this.config.users).flatMap((user) => user.telegram_ids);
      return event.target.userId !== undefined && telegramUserIds.includes(event.target.userId);
    }

    if (event.target.platform === "wechat") {
      if (this.config.channels.wechat.unsafe_allow_all) {
        return true;
      }

      const allowedChatIds = this.config.channels.wechat.allowed_chat_ids;
      if (allowedChatIds.length === 0 || !allowedChatIds.includes(event.target.chatId)) {
        return false;
      }

      const wechatUserIds = Object.values(this.config.users).flatMap((user) => user.wechat_ids);
      return event.target.userId !== undefined && wechatUserIds.includes(event.target.userId);
    }

    return false;
  }
}

function shortId(session: HubSession): string {
  return session.id.slice(0, 8);
}

function shouldHandleInBackground(event: InboundChatEvent): boolean {
  if (selectionNumberFromText(event.text) !== undefined) {
    return false;
  }

  try {
    const command = parseCommand(event.text);
    return command.type === "prompt" || command.type === "agent_command";
  } catch {
    return false;
  }
}

function targetMatchesSession(target: ChatTarget, session: HubSession): boolean {
  return (
    target.platform === session.platform &&
    target.chatId === session.chatId &&
    (target.threadId ?? "") === (session.threadId ?? "") &&
    (session.userId === undefined || target.userId === session.userId)
  );
}

function isTurnBlocked(session: HubSession): boolean {
  return session.status === "running" || session.status === "waiting_approval";
}

function blockedTurnMessage(session: HubSession, inputKind: string): string {
  if (session.status === "waiting_approval") {
    return `Session is waiting for approval since ${session.updatedAt}. Use \`!approve <id>\`, \`!deny <id>\`, \`!status\`, or \`!abort\` before sending another ${inputKind}.`;
  }

  return `Session is still running since ${session.updatedAt}. Wait for Pi to finish, use \`!status\`, or use \`!abort\` before sending another ${inputKind}.`;
}

function selectionNumberFromText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function interactionPage(interaction: PendingInteraction): PendingInteractionOption[] {
  const start = interaction.pageIndex * interaction.pageSize;
  return interaction.options.slice(start, start + interaction.pageSize);
}

function renderInteractionMenu(interaction: PendingInteraction): string {
  const page = interactionPage(interaction);
  const pageCount = Math.max(1, Math.ceil(interaction.options.length / interaction.pageSize));
  const lines = [
    `${interaction.title}${pageCount > 1 ? ` (${interaction.pageIndex + 1}/${pageCount})` : ""}`,
    ...page.map((option, index) => `${index + 1}. ${formatInteractionOption(option)}`),
  ];
  if (pageCount > 1) {
    lines.push("0. Next page");
  }
  return lines.join("\n");
}

function formatInteractionOption(option: PendingInteractionOption): string {
  return option.description ? `${option.label} | ${option.description}` : option.label;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function piUiMethod(raw: unknown): string | undefined {
  return raw !== null &&
    typeof raw === "object" &&
    (raw as Record<string, unknown>).type === "extension_ui_request" &&
    typeof (raw as Record<string, unknown>).method === "string"
    ? String((raw as Record<string, unknown>).method)
    : undefined;
}

function extractLocalArtifacts(text: string, allowedRoots: string[]): Array<{ path: string; kind: "image" | "file" }> {
  const paths = new Set<string>();
  const quoted = /["'`]([A-Za-z]:[\\/][^"'`\r\n]+|\/[^"'`\r\n]+)["'`]/g;
  const windowsUnquoted = /\b[A-Za-z]:[\\/][^\s<>"'`|]+/g;
  const posixUnquoted = /(^|\s)(\/[^\s<>"'`|]+)/g;

  for (const match of text.matchAll(quoted)) {
    paths.add(cleanCandidatePath(match[1]));
  }
  for (const match of text.matchAll(windowsUnquoted)) {
    paths.add(cleanCandidatePath(match[0]));
  }
  for (const match of text.matchAll(posixUnquoted)) {
    paths.add(cleanCandidatePath(match[2]));
  }

  return [...paths]
    .filter((candidate) => {
      try {
        return (
          path.isAbsolute(candidate) &&
          isPathInsideAllowedRoots(candidate, allowedRoots) &&
          existsSync(candidate) &&
          statSync(candidate).isFile()
        );
      } catch {
        return false;
      }
    })
    .map((candidate) => ({
      path: candidate,
      kind: isImagePath(candidate) ? "image" as const : "file" as const,
    }));
}

function cleanCandidatePath(value: string | undefined): string {
  return (value ?? "").replace(/[),.;\]]+$/g, "");
}

function isImagePath(value: string): boolean {
  const ext = path.extname(value).toLowerCase();
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif";
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

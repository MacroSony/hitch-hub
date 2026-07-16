import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { ChannelAdapter, ChannelHealth, InboundChatEvent } from "../channels/types.js";
import { parseCommand } from "../commands/parser.js";
import { PiRpcBackend } from "../agents/pi-rpc.js";
import type { AgentBackend, AgentCommandResult, AgentEvent } from "../agents/types.js";
import { AuditLog } from "./audit-log.js";
import { HubToolService } from "./hub-tools.js";
import { AgentToolBridge, type AgentToolContext } from "./tool-bridge.js";
import {
  DeliveryCoordinator,
  type DeliveryContext,
  type DeliveryHealth,
} from "./delivery-coordinator.js";
import { DeliveryStore } from "./delivery-store.js";
import {
  canonicalizeExistingDirectory,
  isPathInsideAllowedRoots,
  realDirectoryInsideAllowedRoots,
} from "./path-policy.js";
import { SessionRegistry, type PendingInteraction, type PendingInteractionOption } from "./session-registry.js";
import type { AgentName, ChatTarget, HubSession } from "./types.js";
import { PrincipalResolver } from "../security/authorization.js";
import type { AuthorizationContext } from "../security/policy.js";
import { SessionRuntimeStore, type SessionRuntimeOptions } from "../security/session-runtime.js";

const INTERACTION_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_PARTIAL_GRACE_MS = 2_000;

type ActiveTurn = {
  id: string;
  sessionId: string;
  startedAt: string;
  deadlineAt: string;
  lastEventAt?: string;
  phase: "running" | "waiting_approval" | "waiting_input" | "timed_out";
};

type SessionToolPump = {
  backend: AgentBackend;
  context: AgentToolContext;
  target: ChatTarget;
  timer?: ReturnType<typeof setInterval>;
  draining: boolean;
  requested: boolean;
  tail: Promise<void>;
  drain: () => void;
};

export class RemoteAgentHub {
  private readonly sessions: SessionRegistry;
  private readonly principals: PrincipalResolver;
  private readonly runtimeStore: SessionRuntimeStore;
  private readonly audit: AuditLog;
  private readonly deliveryStore: DeliveryStore;
  private readonly tools: HubToolService;
  private readonly toolBridge: AgentToolBridge;
  private readonly delivery: DeliveryCoordinator;
  private readonly workers = new Map<string, AgentBackend>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly toolPumps = new Map<string, SessionToolPump>();
  private readonly workerLastUsedAt = new Map<string, number>();
  private readonly lastInboundAt = new Map<string, string>();
  private readonly inboundCounts = new Map<string, number>();
  private readonly channelTransitionCounts = new Map<string, number>();
  private readonly startedAtMs = Date.now();
  private readonly recoveredDeliveryCount: number;
  private readonly prunedDeliveryCount: number;
  private readonly claimedLegacySessionCount: number;
  private readonly canonicalizedSessionCwdCount: number;
  private readonly inaccessibleSessionCount: number;
  private readonly initializedSessionSecurityCount: number;
  private readonly quarantinedSessionSecurityCount: number;
  private readonly migratedLegacyPiStateCount: number;
  private readonly migratedLegacyToolStateCount: number;
  private readonly migratedWritableSystemConfigCount: number;
  private workerSweepTimer: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly config: HubConfig,
    private readonly channel: ChannelAdapter,
    private readonly backendFactory: (config: HubConfig) => AgentBackend = (config) => new PiRpcBackend(config),
  ) {
    this.principals = new PrincipalResolver(config);
    this.sessions = new SessionRegistry(config.dataDir);
    this.claimedLegacySessionCount = this.sessions.assignLegacySessionOwners((target, cwd) => {
      const authorization = this.principals.resolve(target);
      const canonicalCwd = authorization
        ? realDirectoryInsideAllowedRoots(cwd, authorization.allowedRoots)
        : undefined;
      return authorization && canonicalCwd
        ? { principalId: authorization.principal.id, canonicalCwd }
        : undefined;
    });
    const reconciledSessions = this.sessions.reconcileOwnedSessionCwds((ownerPrincipalId, cwd) => {
      const allowedRoots = this.principals.allowedRootsFor(ownerPrincipalId);
      return allowedRoots ? realDirectoryInsideAllowedRoots(cwd, allowedRoots) : undefined;
    });
    this.canonicalizedSessionCwdCount = reconciledSessions.canonicalized;
    this.inaccessibleSessionCount = reconciledSessions.madeInaccessible;
    this.runtimeStore = new SessionRuntimeStore(config.dataDir);
    this.migratedLegacyPiStateCount = this.runtimeStore.migrateLegacySharedPiState(
      Object.keys(config.users),
      config.agents.pi.config_scope,
      config.agents.pi.legacy_state_principal,
    );
    this.migratedWritableSystemConfigCount =
      config.agents.pi.config_scope === "system" && config.piSystemConfigRoot
        ? this.sessions.migrateSystemAgentConfigMounts(config.piSystemConfigRoot)
        : 0;
    const reconciledSecurity = this.sessions.reconcileSessionSecurityMetadata(
      (sessionId, ownerPrincipalId, cwd, existing) => {
        const allowedRoots = this.principals.allowedRootsFor(ownerPrincipalId);
        const configuredPolicy = this.principals.executionPolicyFor(ownerPrincipalId);
        const executionPolicy =
          existing?.executionPolicy.sandbox === "disabled" && configuredPolicy?.sandbox !== "disabled"
            ? configuredPolicy
            : existing?.executionPolicy ?? configuredPolicy;
        return allowedRoots && executionPolicy
          ? this.runtimeStore.materialize(
              ownerPrincipalId,
              sessionId,
              cwd,
              executionPolicy,
              allowedRoots,
              sessionRuntimeOptions(this.config),
            )
          : undefined;
      },
    );
    this.initializedSessionSecurityCount = reconciledSecurity.initialized;
    this.quarantinedSessionSecurityCount = reconciledSecurity.quarantined;
    this.migratedLegacyToolStateCount = this.runtimeStore.migratedLegacyToolStates();
    this.sessions.recoverInterruptedSessions();
    this.deliveryStore = new DeliveryStore(config.dataDir);
    this.recoveredDeliveryCount = this.deliveryStore.recoverInterrupted();
    this.prunedDeliveryCount = this.deliveryStore.pruneTerminal(config.delivery.retention_ms);
    this.audit = new AuditLog(config.dataDir, {
      maxBytes: config.audit.max_bytes,
      maxFiles: config.audit.max_files,
    });
    channel.setHealthReporter?.((transition) => {
      this.channelTransitionCounts.set(
        transition.platform,
        (this.channelTransitionCounts.get(transition.platform) ?? 0) + 1,
      );
      void this.audit
        .write({
          type: "channel.health",
          details: {
            platform: transition.platform,
            previousState: transition.previousState,
            state: transition.health.state,
            ...(transition.health.lastError ? { error: transition.health.lastError } : {}),
          },
        })
        .catch((error: unknown) => {
          process.stderr.write(`[hitch] Channel health audit failed: ${formatError(error)}\n`);
        });
    });
    this.delivery = new DeliveryCoordinator(
      channel,
      this.audit,
      {
        sendTimeoutMs: config.delivery.send_timeout_ms,
        queueTtlMs: config.delivery.queue_ttl_ms,
        store: this.deliveryStore,
        wechatFailureCooldownMs: config.channels.wechat.failure_cooldown_ms,
      },
    );
    this.tools = new HubToolService(
      config,
      channel,
      this.audit,
      async (target, text, deliveryContext) => {
        this.delivery.enqueueText(target, text, undefined, deliveryContext ?? this.deliveryContextFor(target));
      },
      async (target, artifact, request) => {
        await this.delivery.sendArtifact(
          target,
          artifact,
          undefined,
          request.deliveryContext ?? this.deliveryContextFor(target),
          request,
        );
      },
      (target) => this.deliveryContextFor(target),
    );
    this.toolBridge = new AgentToolBridge();
  }

  async run(): Promise<void> {
    await this.audit.write({
      type: "hub.started",
      details: {
        recoveredDeliveries: this.recoveredDeliveryCount,
        prunedDeliveries: this.prunedDeliveryCount,
        claimedLegacySessions: this.claimedLegacySessionCount,
        canonicalizedSessionCwds: this.canonicalizedSessionCwdCount,
        inaccessibleSessions: this.inaccessibleSessionCount,
        initializedSessionSecurity: this.initializedSessionSecurityCount,
        quarantinedSessionSecurity: this.quarantinedSessionSecurityCount,
        migratedLegacyPiState: this.migratedLegacyPiStateCount,
        migratedLegacyToolState: this.migratedLegacyToolStateCount,
        migratedWritableSystemConfig: this.migratedWritableSystemConfigCount,
      },
    });
    this.startWorkerSweep();
    try {
      for await (const event of this.channel.receive()) {
        if (this.shuttingDown) {
          break;
        }
        if (this.shouldHandleInBackground(event)) {
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
      this.stopWorkerSweep();
      await Promise.allSettled(this.inFlight);
      await this.stopWorkers("hub_exit");
      await Promise.allSettled(this.backgroundTasks);
      await this.delivery.drain();
      await this.audit.drain();
      this.deliveryStore.close();
      this.sessions.close();
    }
  }

  async shutdown(reason: "SIGINT" | "SIGTERM" | "requested" = "requested"): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.stopWorkerSweep();
    this.shutdownPromise = (async () => {
      await this.audit.write({ type: "hub.shutdown", details: { reason } });
      await this.channel.stop?.();
      await this.stopWorkers("shutdown");
    })();
    return this.shutdownPromise;
  }

  private shouldHandleInBackground(event: InboundChatEvent): boolean {
    const authorization = this.principals.resolve(event.target);
    if (
      selectionReplyFromText(event.text) !== undefined &&
      authorization &&
      this.sessions.getPendingInteractionForTarget(event.target, authorization.principal.id)
    ) {
      return false;
    }

    try {
      const command = parseCommand(event.text);
      return command.type === "prompt" || command.type === "agent_command";
    } catch {
      return false;
    }
  }

  private async handleEvent(event: InboundChatEvent): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    try {
      const key = targetRuntimeKey(event.target);
      this.lastInboundAt.set(key, event.receivedAt);
      this.inboundCounts.set(key, (this.inboundCounts.get(key) ?? 0) + 1);
      // A fresh inbound message proves the user is present and supplies a new
      // WeChat context token, so allow one new delivery attempt immediately.
      this.delivery.noteInbound(event.target);
      const authorization = this.principals.resolve(event.target);
      if (!authorization) {
        await this.safeSendText(event.target, "Unauthorized chat/user.");
        return;
      }

      if (await this.handlePendingInteractionSelection(event, authorization)) {
        return;
      }

      const command = parseCommand(event.text);

      switch (command.type) {
        case "new":
          await this.handleNew(event, authorization, command.agent, command.cwd, command.name);
          return;
        case "status":
          await this.handleStatus(event, authorization);
          return;
        case "health":
          await this.handleHealth(event, authorization);
          return;
        case "sessions":
          await this.handleSessions(event, authorization);
          return;
        case "switch":
          await this.handleSwitch(event, authorization, command.ref);
          return;
        case "cwd":
          await this.handleCwd(event, authorization);
          return;
        case "abort":
          await this.handleAbort(event, authorization);
          return;
        case "send":
          await this.handleSendMedia(event, authorization, command.path, command.caption);
          return;
        case "approve":
          await this.handleApprovalDecision(event, authorization, command.id, "allowed");
          return;
        case "deny":
          await this.handleApprovalDecision(event, authorization, command.id, "denied");
          return;
        case "agent_command":
          await this.handleAgentCommand(event, authorization, command.raw);
          return;
        case "prompt":
          await this.handlePrompt(event, authorization, command.text);
          return;
      }
    } catch (error) {
      await this.safeSendText(event.target, error instanceof Error ? error.message : String(error), {
        replyToEventId: event.id,
      });
    }
  }

  private async handleNew(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
    rawAgent: string,
    rawCwd?: string,
    name?: string,
  ): Promise<void> {
    const agent = this.parseAgent(rawAgent);
    const requestedCwd = this.resolveRequestedCwd(rawCwd, authorization.allowedRoots);
    const activeSession = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    if (activeSession && isTurnBlocked(activeSession)) {
      await this.sendChunkedText(
        event.target,
        `Active session ${shortId(activeSession)} is ${activeSession.status}. Use \`!status\`, \`!abort\`, or finish the current turn before creating a new session.`,
      );
      return;
    }

    let cwd: string;
    try {
      cwd = canonicalizeExistingDirectory(requestedCwd, "Requested cwd");
    } catch {
      await this.audit.write({
        type: "session.rejected_missing_cwd",
        target: event.target,
        details: { cwd: requestedCwd },
      });
      await this.sendChunkedText(event.target, `Rejected cwd because it is not an existing directory: ${requestedCwd}`);
      return;
    }

    if (!isPathInsideAllowedRoots(cwd, authorization.allowedRoots)) {
      await this.audit.write({
        type: "session.rejected_cwd",
        target: event.target,
        details: { cwd: requestedCwd, canonicalCwd: cwd },
      });
      await this.safeSendText(event.target, `Rejected cwd outside allowed roots: ${requestedCwd}`);
      return;
    }

    const session = this.sessions.createSession(
      event.target,
      authorization.principal.id,
      agent,
      cwd,
      (sessionId) =>
        this.runtimeStore.materialize(
          authorization.principal.id,
          sessionId,
          cwd,
          authorization.executionPolicy,
          authorization.allowedRoots,
          sessionRuntimeOptions(this.config),
        ),
      name,
    );
    await this.audit.write({
      type: "session.created",
      sessionId: session.id,
      target: event.target,
      details: {
        agent,
        cwd,
        name,
        ownerPrincipalId: authorization.principal.id,
        visibility: session.visibility,
        authorizationMode: authorization.authorizationMode,
      },
    });

    await this.sendChunkedText(
      event.target,
      `${activeSession ? `Created and switched to session ${shortId(session)}` : `Created session ${shortId(session)}`}\n${session.name ? `name: ${session.name}\n` : ""}agent: ${session.agent}\ncwd: ${session.cwd}`,
    );
  }

  private async handleStatus(event: InboundChatEvent, authorization: AuthorizationContext): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session.");
      return;
    }

    const turn = this.activeTurns.get(session.id);
    const worker = this.workers.get(session.id);
    const delivery = this.delivery.health(event.target);
    const channel = this.channel.health?.(event.target);
    const lines = [
      `Session ${shortId(session)}`,
      `agent: ${session.agent}`,
      `status: ${session.status}`,
      `turn: ${formatTurnHealth(turn, session.status)}`,
      `worker: ${formatWorkerHealth(worker, session.processId, Boolean(turn))}`,
      `delivery: ${formatDeliveryHealth(delivery)}`,
      `channel: ${formatChannelHealth(channel)}`,
      `cwd: ${session.cwd}`,
    ];
    await this.sendChunkedText(event.target, lines.join("\n"));
  }

  private async handleHealth(event: InboundChatEvent, authorization: AuthorizationContext): Promise<void> {
    const key = targetRuntimeKey(event.target);
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    const turn = session ? this.activeTurns.get(session.id) : undefined;
    const worker = session ? this.workers.get(session.id) : undefined;
    const delivery = this.delivery.health(event.target);
    const channel = this.channel.health?.(event.target);
    const inboundAt = this.lastInboundAt.get(key);
    const visibleSessionIds = new Set(
      this.sessions.listForTarget(event.target, authorization.principal.id).map((item) => item.id),
    );
    const visibleWorkerCount = [...this.workers.keys()].filter((sessionId) => visibleSessionIds.has(sessionId)).length;
    const visibleTurnCount = [...this.activeTurns.keys()].filter((sessionId) => visibleSessionIds.has(sessionId)).length;
    const operator = authorization.principal.capabilities.includes("operator");
    const lines = [
      "Hitch health",
      `uptime: ${formatDuration(Date.now() - this.startedAtMs)}`,
      `channel: ${formatChannelHealth(channel)}`,
      ...(operator
        ? [`channel transitions: ${this.channelTransitionCounts.get(event.target.platform) ?? 0}`]
        : []),
      `last inbound: ${inboundAt ? `${formatDuration(Math.max(0, Date.now() - Date.parse(inboundAt)))} ago` : "none"}; received ${this.inboundCounts.get(key) ?? 0}`,
      `delivery runtime: ${formatDeliveryHealth(delivery)}`,
      `delivery ledger: ${formatDeliveryLedger(delivery)}`,
      `workers: ${visibleWorkerCount}; active turns: ${visibleTurnCount}`,
      session
        ? `active session: ${shortId(session)}; ${session.status}; turn ${formatTurnHealth(turn, session.status)}; worker ${formatWorkerHealth(worker, session.processId, Boolean(turn))}`
        : "active session: none",
      ...(operator
        ? [
            `startup recovery: expired ${this.recoveredDeliveryCount}; retention pruned ${this.prunedDeliveryCount}; claimed legacy sessions ${this.claimedLegacySessionCount}; canonicalized session cwds ${this.canonicalizedSessionCwdCount}; inaccessible sessions ${this.inaccessibleSessionCount}; initialized session security ${this.initializedSessionSecurityCount}; quarantined session security ${this.quarantinedSessionSecurityCount}; migrated legacy Pi state ${this.migratedLegacyPiStateCount}; migrated legacy tool state ${this.migratedLegacyToolStateCount}; migrated writable system config ${this.migratedWritableSystemConfigCount}`,
          ]
        : []),
    ];
    await this.sendChunkedText(event.target, lines.join("\n"));
  }

  private async handleSessions(event: InboundChatEvent, authorization: AuthorizationContext): Promise<void> {
    const sessions = this.sessions.listForTarget(event.target, authorization.principal.id);
    if (sessions.length === 0) {
      await this.sendChunkedText(event.target, "No sessions.");
      return;
    }

    const active = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    const options = sessions.map((session) => ({
      label: session.name ? `${session.name} (${shortId(session)})` : shortId(session),
      description: `${active?.id === session.id ? "active | " : ""}${session.status} | ${session.agent} | ${session.cwd}`,
      value: { sessionId: session.id },
    }));
    await this.createAndSendInteraction(event.target, {
      ownerPrincipalId: authorization.principal.id,
      owner: "hub",
      kind: "hub.session.switch",
      title: "Select session",
      options,
    });
  }

  private async handleSwitch(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
    ref: string,
  ): Promise<void> {
    const session = this.sessions.findForTarget(event.target, authorization.principal.id, ref);
    if (!session) {
      await this.sendChunkedText(event.target, `No session found for ${ref}. Use \`!sessions\` to list sessions.`);
      return;
    }

    if (!this.sessions.selectSession(session.id, authorization.principal.id)) {
      await this.sendChunkedText(event.target, "Session selection was rejected because ownership changed.");
      return;
    }
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

  private async handleCwd(event: InboundChatEvent, authorization: AuthorizationContext): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    await this.sendChunkedText(event.target, session ? session.cwd : "No active session.");
  }

  private async handleAbort(event: InboundChatEvent, authorization: AuthorizationContext): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session to abort.");
      return;
    }

    const worker = this.workers.get(session.id);
    this.activeTurns.delete(session.id);
    this.sessions.updateStatus(session.id, "stopped");
    if (worker) {
      await worker.abort();
      await this.stopWorker(session.id, worker, "user_abort");
    }
    this.sessions.setBackendProcess(session.id, undefined);
    await this.audit.write({
      type: "session.aborted",
      sessionId: session.id,
      target: event.target,
    });
    await this.sendChunkedText(event.target, `Stopped session ${shortId(session)}.`);
  }

  private async handleSendMedia(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
    mediaPath: string,
    caption?: string,
  ): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    const result = await this.tools.sendMedia(
      event.target,
      {
        path: mediaPath,
        ...(caption ? { caption } : {}),
      },
      {
        source: "hub_command",
        ...(session ? { deliveryContext: { sessionId: session.id } } : {}),
      },
    );

    if (result.status === "sent") {
      await this.sendChunkedText(event.target, `Media sent: ${path.basename(result.path)}`);
      return;
    }

    await this.sendChunkedText(event.target, `Media delivery failed: ${result.message ?? "unknown error"}`);
  }

  private async handleAgentCommand(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
    raw: string,
  ): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session. Start one with `!new pi <cwd>`.");
      return;
    }

    if (this.activeTurns.has(session.id) || isTurnBlocked(session)) {
      await this.sendBlockedTurn(event, session, "agent command");
      return;
    }

    const backend = this.getWorker(session);

    if (!backend.executeCommand) {
      await this.sendChunkedText(event.target, "This agent does not support native command passthrough.");
      return;
    }

    const turn = this.beginTurn(session.id);
    this.sessions.updateStatus(session.id, "running");
    try {
      await this.startBackendForTurn(session, backend, turn, event.target);
      await this.audit.write({
        type: "agent_command.received",
        sessionId: session.id,
        target: event.target,
        details: { command: raw, attachments: event.attachments?.length ?? 0 },
      });

      const input = event.attachments ? { raw, attachments: event.attachments } : { raw };
      const result = await backend.executeCommand(input);
      await this.handleAgentCommandResult(event.target, session, backend, result, turn);
    } catch (error) {
      this.updateStatusForTurn(turn, "error");
      await this.audit.write({
        type: "agent_command.error",
        sessionId: session.id,
        target: event.target,
        details: { command: raw, error: error instanceof Error ? error.message : String(error) },
      });
      await this.sendChunkedText(event.target, error instanceof Error ? error.message : String(error));
    } finally {
      this.releaseTurn(turn);
      if (!backend.isAlive()) {
        this.workers.delete(session.id);
        this.workerLastUsedAt.delete(session.id);
        await this.stopToolPump(session.id, backend);
        if (!this.workers.has(session.id)) {
          this.sessions.setBackendProcess(session.id, undefined);
        }
      }
    }
  }

  private async handlePrompt(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
    text: string,
  ): Promise<void> {
    const session = this.sessions.getActiveForTarget(event.target, authorization.principal.id);
    if (!session) {
      await this.sendChunkedText(event.target, "No active session. Start one with `!new pi <cwd>`.");
      return;
    }

    if (this.activeTurns.has(session.id) || isTurnBlocked(session)) {
      await this.sendBlockedTurn(event, session, "message");
      return;
    }

    const turn = this.beginTurn(session.id);
    this.sessions.updateStatus(session.id, "running");
    await this.audit.write({
      type: "prompt.received",
      sessionId: session.id,
      target: event.target,
      details: { length: text.length, attachments: event.attachments?.length ?? 0 },
    });

    const backend = this.getWorker(session);

    try {
      await this.startBackendForTurn(session, backend, turn, event.target);

      await backend.send(event.attachments ? { text, attachments: event.attachments } : { text });
      await this.consumeAgentEvents(session, backend, turn);
    } catch (error) {
      this.updateStatusForTurn(turn, "error");
      await this.audit.write({
        type: "turn.error",
        sessionId: session.id,
        target: event.target,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      await this.sendChunkedText(event.target, error instanceof Error ? error.message : String(error));
    } finally {
      this.releaseTurn(turn);
      if (!backend.isAlive()) {
        this.workers.delete(session.id);
        this.workerLastUsedAt.delete(session.id);
        await this.stopToolPump(session.id, backend);
        if (!this.workers.has(session.id)) {
          this.sessions.setBackendProcess(session.id, undefined);
        }
      }
    }
  }

  private async handleApprovalDecision(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
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
    if (
      !session ||
      session.ownerPrincipalId !== authorization.principal.id ||
      !targetMatchesSession(event.target, session)
    ) {
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
    if (this.sessions.countPendingApprovalsForSession(approval.sessionId) === 0) {
      const current = this.sessions.getById(approval.sessionId);
      if (current?.status === "waiting_approval") {
        this.updateStatusUnlessStopped(approval.sessionId, backend?.respondToApproval ? "running" : "idle");
        const turn = this.activeTurns.get(approval.sessionId);
        if (turn && backend?.respondToApproval) {
          this.setTurnPhase(turn, "running");
        }
      }
    }
    await this.audit.write({
      type: "approval.decided",
      sessionId: approval.sessionId,
      target: event.target,
      details: { approvalId, decision, delivered: Boolean(backend?.respondToApproval) },
    });

    await this.sendChunkedText(event.target, `Approval ${approvalId} ${decision}.`);
  }

  private async handlePendingInteractionSelection(
    event: InboundChatEvent,
    authorization: AuthorizationContext,
  ): Promise<boolean> {
    const selection = selectionReplyFromText(event.text);
    if (selection === undefined) {
      return false;
    }

    const interaction = this.sessions.getPendingInteractionForTarget(event.target, authorization.principal.id);
    if (!interaction) {
      return false;
    }

    const page = interactionPage(interaction);
    const pageCount = Math.max(1, Math.ceil(interaction.options.length / interaction.pageSize));
    if (selection.type === "next" || selection.type === "previous") {
      const nextPage =
        selection.type === "next"
          ? (interaction.pageIndex + 1) % pageCount
          : (interaction.pageIndex - 1 + pageCount) % pageCount;
      const updated = this.sessions.updatePendingInteractionPage(
        interaction.id,
        authorization.principal.id,
        nextPage,
      );
      await this.sendInteractionMenu(event.target, updated ?? interaction);
      return true;
    }

    const option = page[selection.index];
    if (!option) {
      await this.sendChunkedText(event.target, `No option ${selection.index} for this menu.`);
      await this.sendInteractionMenu(event.target, interaction);
      return true;
    }

    this.sessions.deletePendingInteraction(interaction.id, authorization.principal.id);
    await this.executeInteractionSelection(event.target, authorization, interaction, option);
    return true;
  }

  private async executeInteractionSelection(
    target: ChatTarget,
    authorization: AuthorizationContext,
    interaction: PendingInteraction,
    option: PendingInteractionOption,
  ): Promise<void> {
    if (interaction.owner === "hub") {
      await this.executeHubSelection(target, authorization, interaction, option);
      return;
    }

    const session = interaction.sessionId
      ? this.sessions.getById(interaction.sessionId)
      : this.sessions.getActiveForTarget(target, authorization.principal.id);
    if (
      !session ||
      session.ownerPrincipalId !== authorization.principal.id ||
      !targetMatchesSession(target, session)
    ) {
      await this.sendChunkedText(target, "The selected session is no longer available.");
      return;
    }
    if (isTurnBlocked(session) && session.status !== "waiting_input") {
      await this.sendChunkedText(target, blockedTurnMessage(session, "selection"));
      return;
    }

    const backend = this.getWorker(session);
    if (!backend.executeSelection) {
      await this.sendChunkedText(target, "This agent does not support interactive selections.");
      return;
    }

    try {
      this.assertSessionCwdAuthorized(session);
      const processId = await backend.start(session, this.toolBridge.contextFor(session));
      await this.ensureToolPump(session, backend);
      this.sessions.setBackendProcess(session.id, processId);
      if (this.sessions.getById(session.id)?.status === "waiting_input") {
        this.updateStatusUnlessStopped(session.id, "running");
      }
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
        this.workerLastUsedAt.delete(session.id);
        await this.stopToolPump(session.id, backend);
        if (!this.workers.has(session.id)) {
          this.sessions.setBackendProcess(session.id, undefined);
        }
      } else {
        this.workerLastUsedAt.set(session.id, Date.now());
      }
    }
  }

  private async executeHubSelection(
    target: ChatTarget,
    authorization: AuthorizationContext,
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
    if (
      !session ||
      session.ownerPrincipalId !== authorization.principal.id ||
      !targetMatchesSession(target, session)
    ) {
      await this.sendChunkedText(target, "Selected session is no longer available.");
      return;
    }

    if (!this.sessions.selectSession(session.id, authorization.principal.id)) {
      await this.sendChunkedText(target, "Selected session ownership changed; selection was rejected.");
      return;
    }
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
    turn?: ActiveTurn,
  ): Promise<void> {
    if (result.text) {
      await this.sendChunkedText(target, result.text);
    }
    if (result.interaction) {
      await this.createAndSendInteraction(target, {
        ownerPrincipalId: session.ownerPrincipalId,
        owner: "agent",
        sessionId: session.id,
        kind: result.interaction.kind,
        title: result.interaction.title,
        options: result.interaction.options,
        ...(result.interaction.pageSize ? { pageSize: result.interaction.pageSize } : {}),
      });
    }
    if (result.consumesEvents) {
      const existingTurn = this.activeTurns.get(session.id);
      const consumingTurn = turn ?? existingTurn ?? this.beginTurn(session.id);
      const ownsTurn = turn === undefined && existingTurn === undefined;
      this.updateStatusForTurn(consumingTurn, "running");
      try {
        await this.consumeAgentEvents(session, backend, consumingTurn);
      } finally {
        if (ownsTurn) {
          this.releaseTurn(consumingTurn);
        }
      }
      return;
    }
    if (turn) {
      this.updateStatusForTurn(turn, "idle");
    }
  }

  private async createAndSendInteraction(
    target: ChatTarget,
    input: {
      ownerPrincipalId: string;
      owner: "hub" | "agent";
      kind: string;
      title: string;
      options: PendingInteractionOption[];
      sessionId?: string;
      pageSize?: number;
      deliveryContext?: DeliveryContext;
    },
  ): Promise<void> {
    if (input.options.length === 0) {
      await this.sendChunkedText(target, "No options available.", input.deliveryContext);
      return;
    }

    const interaction = this.sessions.createPendingInteraction(target, {
      ownerPrincipalId: input.ownerPrincipalId,
      owner: input.owner,
      kind: input.kind,
      title: input.title,
      options: input.options,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.pageSize ? { pageSize: input.pageSize } : {}),
      expiresAt: new Date(Date.now() + INTERACTION_TTL_MS).toISOString(),
    });
    await this.sendInteractionMenu(target, interaction, input.deliveryContext);
  }

  private async sendInteractionMenu(
    target: ChatTarget,
    interaction: PendingInteraction,
    deliveryContext?: DeliveryContext,
  ): Promise<void> {
    await this.sendChunkedText(target, renderInteractionMenu(interaction), deliveryContext);
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

  private resolveRequestedCwd(rawCwd: string | undefined, allowedRoots: string[]): string {
    const defaultCwd =
      this.config.defaultCwd && isPathInsideAllowedRoots(this.config.defaultCwd, allowedRoots)
        ? this.config.defaultCwd
        : allowedRoots[0];
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
      this.workerLastUsedAt.set(session.id, Date.now());
      return existing;
    }

    const backend = this.backendFactory(this.config);
    this.workers.set(session.id, backend);
    this.workerLastUsedAt.set(session.id, Date.now());
    return backend;
  }

  private assertSessionCwdAuthorized(session: HubSession): void {
    const allowedRoots = this.principals.allowedRootsFor(session.ownerPrincipalId);
    const currentCwd = allowedRoots ? realDirectoryInsideAllowedRoots(session.cwd, allowedRoots) : undefined;
    if (!allowedRoots || !currentCwd || currentCwd !== session.cwd) {
      throw new Error(`Session cwd is no longer an authorized canonical directory: ${session.cwd}`);
    }
    const expected = this.runtimeStore.materialize(
      session.ownerPrincipalId,
      session.id,
      session.cwd,
      session.executionPolicy,
      allowedRoots,
      sessionRuntimeOptions(this.config),
    );
    if (
      expected.statePath !== session.statePath ||
      JSON.stringify(expected.executionPolicy) !== JSON.stringify(session.executionPolicy) ||
      JSON.stringify(expected.mountPlan) !== JSON.stringify(session.mountPlan)
    ) {
      throw new Error(`Session security metadata no longer matches its authorized snapshot: ${session.id}`);
    }
  }

  private async startBackendForTurn(
    session: HubSession,
    backend: AgentBackend,
    turn: ActiveTurn,
    target: ChatTarget,
  ): Promise<number | undefined> {
    this.assertSessionCwdAuthorized(session);
    const wasAlive = backend.isAlive();
    const processId = await backend.start(session, this.toolBridge.contextFor(session));
    await this.ensureToolPump(session, backend);
    this.sessions.setBackendProcess(session.id, processId);
    if (!wasAlive) {
      await this.audit.write({
        type: "worker.spawned",
        sessionId: session.id,
        target,
        details: { processId },
      });
    }
    await this.audit.write({
      type: "turn.started",
      sessionId: session.id,
      target,
      details: { turnId: turn.id, processId, workerReused: wasAlive },
    });
    return processId;
  }

  private async stopWorker(sessionId: string, worker: AgentBackend, reason: string): Promise<void> {
    if (this.workers.get(sessionId) === worker) {
      this.workers.delete(sessionId);
      this.workerLastUsedAt.delete(sessionId);
    }
    const session = this.sessions.getById(sessionId);
    const processId = session?.processId;
    let stopError: string | undefined;
    try {
      await worker.stop();
    } catch (error) {
      stopError = formatError(error);
      process.stderr.write(`[hitch] Worker stop failed for ${sessionId.slice(0, 8)}: ${stopError}\n`);
    } finally {
      await this.stopToolPump(sessionId, worker);
      if (!this.workers.has(sessionId)) {
        this.sessions.setBackendProcess(sessionId, undefined);
      }
      await this.audit.write({
        type: "worker.stopped",
        sessionId,
        details: { reason, ...(processId ? { processId } : {}), ...(stopError ? { error: stopError } : {}) },
      });
    }
  }

  private async stopWorkers(reason: string): Promise<void> {
    const workers = [...this.workers.entries()];
    await Promise.allSettled(
      workers.map(async ([sessionId, worker]) => {
        if (this.activeTurns.has(sessionId)) {
          await worker.abort().catch(() => undefined);
        }
        await this.stopWorker(sessionId, worker, reason);
      }),
    );
    await Promise.allSettled([...this.toolPumps.keys()].map((sessionId) => this.stopToolPump(sessionId)));
  }

  private async ensureToolPump(session: HubSession, backend: AgentBackend): Promise<void> {
    const existing = this.toolPumps.get(session.id);
    if (existing?.backend === backend) {
      return;
    }
    if (existing) {
      await this.stopToolPump(session.id, existing.backend);
    }

    const pump: SessionToolPump = {
      backend,
      context: this.toolBridge.contextFor(session),
      target: targetForSession(session),
      draining: false,
      requested: false,
      tail: Promise.resolve(),
      drain: () => {},
    };
    pump.drain = () => {
      if (pump.draining) {
        pump.requested = true;
        return;
      }
      pump.draining = true;
      pump.tail = (async () => {
        do {
          pump.requested = false;
          const turn = this.activeTurns.get(session.id);
          await this.toolBridge.processPending(pump.context, pump.target, this.tools, {
            sessionId: session.id,
            ...(turn ? { turnId: turn.id } : {}),
          });
        } while (pump.requested);
      })()
        .catch((error: unknown) => {
          process.stderr.write(`[hitch] Agent tool bridge failed: ${formatError(error)}\n`);
        })
        .finally(() => {
          pump.draining = false;
        });
    };
    this.toolPumps.set(session.id, pump);
    pump.drain();
    pump.timer = setInterval(pump.drain, 250);
    pump.timer.unref();
  }

  private async stopToolPump(sessionId: string, expectedBackend?: AgentBackend): Promise<void> {
    const pump = this.toolPumps.get(sessionId);
    if (!pump || (expectedBackend && pump.backend !== expectedBackend)) {
      return;
    }
    this.toolPumps.delete(sessionId);
    if (pump.timer) {
      clearInterval(pump.timer);
      delete pump.timer;
    }
    pump.drain();
    await pump.tail;
  }

  private async drainToolPump(sessionId: string): Promise<void> {
    const pump = this.toolPumps.get(sessionId);
    if (!pump) {
      return;
    }
    pump.drain();
    await pump.tail;
  }

  private startWorkerSweep(): void {
    const idleTimeoutMs = this.config.worker_idle_timeout_ms;
    if (idleTimeoutMs <= 0 || this.workerSweepTimer) {
      return;
    }
    const intervalMs = Math.min(60_000, Math.max(25, Math.floor(idleTimeoutMs / 2)));
    this.workerSweepTimer = setInterval(() => {
      const task = this.evictIdleWorkers();
      this.trackBackground(task);
    }, intervalMs);
    this.workerSweepTimer.unref();
  }

  private stopWorkerSweep(): void {
    if (!this.workerSweepTimer) {
      return;
    }
    clearInterval(this.workerSweepTimer);
    this.workerSweepTimer = undefined;
  }

  private async evictIdleWorkers(): Promise<void> {
    const idleTimeoutMs = this.config.worker_idle_timeout_ms;
    const now = Date.now();
    const evictions: Promise<void>[] = [];
    for (const [sessionId, worker] of this.workers) {
      const lastUsedAt = this.workerLastUsedAt.get(sessionId) ?? now;
      if (this.activeTurns.has(sessionId) || now - lastUsedAt < idleTimeoutMs) {
        continue;
      }
      evictions.push(this.stopWorker(sessionId, worker, "idle_timeout"));
    }
    await Promise.allSettled(evictions);
  }

  private async consumeAgentEvents(session: HubSession, backend: AgentBackend, turn: ActiveTurn): Promise<void> {
    let streamedText = "";
    const deliveredArtifactPaths = new Set<string>();
    const target = targetForSession(session);
    const deliveryContext: DeliveryContext = { sessionId: session.id, turnId: turn.id };
    const toolMessages = new ToolStatusBatcher(this.config.delivery.tool_status_batch_ms, (text) =>
      this.sendChunkedText(target, text, deliveryContext),
    );
    const deadline = turnDeadline(turn);
    const iterator = backend.events()[Symbol.asyncIterator]();

    try {
      while (true) {
        if (this.shuttingDown) {
          return;
        }
        const pendingNext = iterator.next();
        const next = await Promise.race([
          pendingNext.then((result) => ({ type: "event" as const, result })),
          deadline.promise,
        ]);
        if (next.type === "timeout") {
          await this.handleTurnTimeout(
            session,
            backend,
            turn,
            target,
            toolMessages,
            iterator,
            pendingNext,
            streamedText,
          );
          return;
        }
        if (next.result.done) {
          break;
        }
        const agentEvent = next.result.value;
        if (this.sessions.getById(session.id)?.status === "stopped") {
          return;
        }
        this.touchTurn(turn);
        const handled = await Promise.race([
          this.handleAgentEvent(
            session,
            turn,
            agentEvent,
            streamedText,
            deliveredArtifactPaths,
            toolMessages,
            deliveryContext,
          ).then((finished) => ({ type: "handled" as const, finished })),
          deadline.promise,
        ]);
        if (handled.type === "timeout") {
          await this.handleTurnTimeout(session, backend, turn, target, toolMessages, iterator, undefined, streamedText);
          return;
        }
        if (agentEvent.type === "text_delta") {
          streamedText += agentEvent.text;
        }
        if (handled.finished) {
          this.updateStatusForTurn(turn, "idle");
          await this.audit.write({
            type: "turn.completed",
            sessionId: session.id,
            details: { turnId: turn.id, streamedTextLength: streamedText.length },
          });
          return;
        }
      }
    } finally {
      deadline.cancel();
      toolMessages.cancelTimer();
      await this.drainToolPump(session.id);
    }

    if (this.sessions.getById(session.id)?.status === "stopped") {
      return;
    }
    if (this.shuttingDown) {
      return;
    }

    this.updateStatusForTurn(turn, "idle");
    await this.audit.write({
      type: "worker.exited",
      sessionId: session.id,
      details: { turnId: turn.id, streamedTextLength: streamedText.length },
    });
    await toolMessages.flush();
    await this.sendChunkedText(
      target,
      streamedText.length > 0 ? streamedText : "Pi worker exited before reporting a final response; session is idle.",
      deliveryContext,
    );
  }

  private async handleAgentEvent(
    session: HubSession,
    turn: ActiveTurn,
    event: AgentEvent,
    streamedText: string,
    deliveredArtifactPaths: Set<string>,
    toolMessages: ToolStatusBatcher,
    deliveryContext: DeliveryContext,
  ): Promise<boolean> {
    if (this.shuttingDown || !this.isTurnCurrent(turn) || this.sessions.getById(session.id)?.status === "stopped") {
      return true;
    }

    const target = targetForSession(session);

    switch (event.type) {
      case "text_delta":
        return false;
      case "final": {
        const finalText = streamedText.length > 0 && isEmptyFinalFallback(event.text) ? streamedText : event.text;
        await toolMessages.flush();
        if (finalText.length > 0) {
          await this.sendChunkedText(target, finalText, deliveryContext);
          await this.sendArtifactsMentionedInText(
            target,
            finalText,
            deliveredArtifactPaths,
            deliveryContext,
            this.principals.allowedRootsFor(session.ownerPrincipalId) ?? [],
          );
        }
        return true;
      }
      case "tool_call":
        if (
          this.config.delivery.tool_status_mode === "all" ||
          (this.config.delivery.tool_status_mode === "failures" && this.isHitchMediaToolCall(event))
        ) {
          await toolMessages.add(this.formatToolStart(event));
        }
        return false;
      case "tool_result":
        if (
          this.config.delivery.tool_status_mode === "all" ||
          (this.config.delivery.tool_status_mode === "failures" &&
            (event.succeeded === false || this.isHitchMediaToolResult(event)))
        ) {
          await toolMessages.add(this.formatToolResult(event));
        }
        return false;
      case "notification":
        if (event.completesTurn) {
          this.updateStatusForTurn(turn, "idle");
        }
        await toolMessages.flush();
        await this.sendChunkedText(target, this.formatNotification(event), deliveryContext);
        return event.completesTurn === true;
      case "approval_request": {
        await toolMessages.flush();
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
        this.setTurnPhase(turn, "waiting_approval");
        this.updateStatusForTurn(turn, "waiting_approval");
        await this.safeSendText(
          target,
          `Approval requested: ${approvalId}\nexpires: ${expiresAt}\n\nFallback commands:\n!approve ${approvalId}\n!deny ${approvalId}`,
          {
            buttons: [
              { label: "Approve", text: `!approve ${approvalId}` },
              { label: "Deny", text: `!deny ${approvalId}` },
            ],
          },
          deliveryContext,
        );
        return false;
      }
      case "interaction_request":
        await toolMessages.flush();
        this.setTurnPhase(turn, "waiting_input");
        this.updateStatusForTurn(turn, "waiting_input");
        await this.createAndSendInteraction(target, {
          ownerPrincipalId: session.ownerPrincipalId,
          owner: "agent",
          sessionId: session.id,
          kind: event.interaction.kind,
          title: event.interaction.title,
          options: event.interaction.options,
          ...(event.interaction.pageSize ? { pageSize: event.interaction.pageSize } : {}),
          deliveryContext,
        });
        return false;
      case "status":
        if (event.state === "running") {
          this.setTurnPhase(turn, "running");
          this.updateStatusForTurn(turn, "running");
        } else if (event.state === "error") {
          this.updateStatusForTurn(turn, "error");
        }
        return false;
    }
  }

  private async sendChunkedText(
    target: InboundChatEvent["target"],
    text: string,
    deliveryContext?: DeliveryContext,
  ): Promise<void> {
    const maxLength = 3900;
    if (text.length <= maxLength) {
      await this.safeSendText(target, text, undefined, deliveryContext);
      return;
    }

    for (let start = 0; start < text.length; start += maxLength) {
      await this.safeSendText(target, text.slice(start, start + maxLength), undefined, deliveryContext);
    }
  }

  private beginTurn(sessionId: string): ActiveTurn {
    if (this.activeTurns.has(sessionId)) {
      throw new Error(`Session ${sessionId.slice(0, 8)} already has an active turn.`);
    }
    const startedAtMs = Date.now();
    const turn: ActiveTurn = {
      id: crypto.randomUUID(),
      sessionId,
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(startedAtMs + this.config.agent_turn_timeout_ms).toISOString(),
      phase: "running",
    };
    this.activeTurns.set(sessionId, turn);
    return turn;
  }

  private trackBackground(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private releaseTurn(turn: ActiveTurn): void {
    if (this.isTurnCurrent(turn)) {
      this.activeTurns.delete(turn.sessionId);
      if (this.workers.has(turn.sessionId)) {
        this.workerLastUsedAt.set(turn.sessionId, Date.now());
      }
    }
  }

  private isTurnCurrent(turn: ActiveTurn): boolean {
    return this.activeTurns.get(turn.sessionId)?.id === turn.id;
  }

  private touchTurn(turn: ActiveTurn): void {
    if (this.isTurnCurrent(turn)) {
      turn.lastEventAt = new Date().toISOString();
    }
  }

  private setTurnPhase(turn: ActiveTurn, phase: ActiveTurn["phase"]): void {
    if (this.isTurnCurrent(turn)) {
      turn.phase = phase;
    }
  }

  private updateStatusForTurn(turn: ActiveTurn, status: HubSession["status"]): void {
    if (this.isTurnCurrent(turn)) {
      this.updateStatusUnlessStopped(turn.sessionId, status);
    }
  }

  private async handleTurnTimeout(
    session: HubSession,
    backend: AgentBackend,
    turn: ActiveTurn,
    target: ChatTarget,
    toolMessages: ToolStatusBatcher,
    iterator: AsyncIterator<AgentEvent>,
    pendingNext: Promise<IteratorResult<AgentEvent>> | undefined,
    streamedText: string,
  ): Promise<void> {
    if (!this.isTurnCurrent(turn)) {
      return;
    }
    this.setTurnPhase(turn, "timed_out");
    this.updateStatusForTurn(turn, "error");
    await backend.abort().catch((error: unknown) => {
      process.stderr.write(`[hitch] Agent abort after timeout failed: ${formatError(error)}\n`);
    });
    const partialText = await interruptedFinalAfterTimeout(iterator, pendingNext, streamedText, TIMEOUT_PARTIAL_GRACE_MS);
    await this.stopWorker(session.id, backend, "turn_timeout");
    await this.audit.write({
      type: "turn.timeout",
      sessionId: session.id,
      target,
      details: {
        turnId: turn.id,
        timeoutMs: this.config.agent_turn_timeout_ms,
        partialResultLength: partialText?.length ?? 0,
      },
    });
    await toolMessages.flush();
    const notice = `Agent turn timed out after ${this.config.agent_turn_timeout_ms}ms.`;
    await this.sendChunkedText(
      target,
      partialText ? `${notice}\n\nPartial result from the cancelled turn:\n${partialText}` : notice,
      { sessionId: session.id, turnId: turn.id },
    );
  }

  private updateStatusUnlessStopped(id: string, status: HubSession["status"]): void {
    if (this.sessions.getById(id)?.status === "stopped") {
      return;
    }
    this.sessions.updateStatus(id, status);
  }

  private formatToolResult(event: Extract<AgentEvent, { type: "tool_result" }>): string {
    const mediaFailure = this.isHitchMediaToolFailure(event);
    const status =
      mediaFailure || event.succeeded === false
        ? "failed"
        : event.succeeded === true
          ? "succeeded"
          : "completed";
    const name = this.isHitchMediaToolResult(event) ? "hitch.send_media" : event.name;
    const summary = `Tool finished: ${name} (${status})`;
    // Always surface tool output for failures so the user (and the chat) sees the
    // real error; only gate successful/noisy output behind full_tool_output.
    if (event.text && (mediaFailure || event.succeeded === false || this.config.delivery.full_tool_output)) {
      return `${summary}\n${event.text}`;
    }
    return summary;
  }

  private formatToolStart(event: Extract<AgentEvent, { type: "tool_call" }>): string {
    const name = this.isHitchMediaToolCall(event) ? "hitch.send_media" : event.name;
    const summary = `Tool started: ${name}`;
    return this.config.delivery.full_tool_output && event.preview ? `${summary}\n${event.preview}` : summary;
  }

  private isHitchMediaToolCall(event: Extract<AgentEvent, { type: "tool_call" }>): boolean {
    return event.name === "mcp" && /(?:hitch_hitch\.)?send_media/.test(event.preview ?? "");
  }

  private isHitchMediaToolResult(event: Extract<AgentEvent, { type: "tool_result" }>): boolean {
    return (
      event.name === "mcp" &&
      /(?:Media sent to|Media delivery failed|hitch(?:_hitch)?\.send_media|send_media)/i.test(event.text ?? "")
    );
  }

  private isHitchMediaToolFailure(event: Extract<AgentEvent, { type: "tool_result" }>): boolean {
    return event.name === "mcp" && /Media delivery failed/i.test(event.text ?? "");
  }

  private formatNotification(event: Extract<AgentEvent, { type: "notification" }>): string {
    return event.text.startsWith("Pi ") ? event.text : `Pi notification: ${event.text}`;
  }

  private async safeSendText(
    target: InboundChatEvent["target"],
    text: string,
    opts?: Parameters<ChannelAdapter["sendText"]>[2],
    deliveryContext?: DeliveryContext,
  ): Promise<void> {
    this.delivery.enqueueText(target, text, opts, deliveryContext ?? this.deliveryContextFor(target));
  }

  private deliveryContextFor(target: ChatTarget): DeliveryContext {
    const authorization = this.principals.resolve(target);
    if (!authorization) {
      return {};
    }
    const session = this.sessions.getActiveForTarget(target, authorization.principal.id);
    if (!session) {
      return {};
    }
    const turn = this.activeTurns.get(session.id);
    return {
      sessionId: session.id,
      ...(turn ? { turnId: turn.id } : {}),
    };
  }

  private async sendArtifactsMentionedInText(
    target: InboundChatEvent["target"],
    text: string,
    deliveredArtifactPaths: Set<string>,
    deliveryContext?: DeliveryContext,
    principalRoots: string[] = [],
  ): Promise<void> {
    if (!this.config.media.auto_discovery || !this.channel.sendArtifact) {
      return;
    }

    const artifacts = extractLocalArtifacts(text, [path.join(this.config.dataDir, "media", "outbound"), ...principalRoots])
      .filter((artifact) => !deliveredArtifactPaths.has(path.resolve(artifact.path)))
      .slice(0, Math.max(0, 5 - deliveredArtifactPaths.size));
    for (const artifact of artifacts) {
      deliveredArtifactPaths.add(path.resolve(artifact.path));
      const result = await this.tools.sendMedia(target, artifact, {
        source: "auto_discovery",
        notifyOnFailure: true,
        extraAllowedRoots: principalRoots,
        ...(deliveryContext ? { deliveryContext } : {}),
      });
      if (result.status === "failed") {
        process.stderr.write(`[hitch] Artifact send failed for ${artifact.path}: ${result.message ?? "unknown error"}\n`);
      }
    }
  }

}

function sessionRuntimeOptions(config: HubConfig): SessionRuntimeOptions {
  return config.agents.pi.config_scope === "system" && config.piSystemConfigRoot
    ? { agentConfig: { hostPath: config.piSystemConfigRoot, mode: "rw" } }
    : {};
}

class ToolStatusBatcher {
  private messages: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushQueue = Promise.resolve();

  constructor(
    private readonly batchMs: number,
    private readonly send: (text: string) => Promise<void>,
  ) {}

  async add(message: string): Promise<void> {
    if (this.batchMs <= 0) {
      await this.send(message);
      return;
    }

    this.messages.push(message);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.batchMs);
    }
  }

  async flush(): Promise<void> {
    this.cancelTimer();
    const text = this.messages.splice(0).join("\n");
    if (text.length > 0) {
      this.flushQueue = this.flushQueue.then(() => this.send(text));
    }
    await this.flushQueue;
  }

  cancelTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function turnDeadline(turn: ActiveTurn): {
  promise: Promise<{ type: "timeout" }>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remainingMs = Math.max(0, Date.parse(turn.deadlineAt) - Date.now());
  const promise = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ type: "timeout" }), remainingMs);
  });
  return {
    promise,
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

async function interruptedFinalAfterTimeout(
  iterator: AsyncIterator<AgentEvent>,
  pendingNext: Promise<IteratorResult<AgentEvent>> | undefined,
  streamedText: string,
  graceMs: number,
): Promise<string | undefined> {
  const deadlineAt = Date.now() + graceMs;
  let accumulatedText = streamedText;
  let next = pendingNext ?? iterator.next();

  while (Date.now() < deadlineAt) {
    const result = await settleIteratorBefore(next, deadlineAt - Date.now());
    if (!result || result.done) {
      return undefined;
    }
    const event = result.value;
    if (event.type === "text_delta") {
      accumulatedText += event.text;
    } else if (event.type === "final") {
      if (!event.interrupted) {
        return undefined;
      }
      if (isEmptyFinalFallback(event.text)) {
        return accumulatedText.length > 0 ? accumulatedText : undefined;
      }
      return event.text.length > 0 ? event.text : undefined;
    }
    next = iterator.next();
  }
  return undefined;
}

function isEmptyFinalFallback(text: string): boolean {
  return text.length === 0 || text === "Pi completed." || text === "Pi finished without a final response.";
}

async function settleIteratorBefore<T>(
  next: Promise<IteratorResult<T>>,
  remainingMs: number,
): Promise<IteratorResult<T> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, remainingMs));
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatTurnHealth(turn: ActiveTurn | undefined, persistedStatus: HubSession["status"]): string {
  if (!turn) {
    return persistedStatus === "running" || persistedStatus === "waiting_approval" || persistedStatus === "waiting_input"
      ? "stale (no active in-memory turn)"
      : "none";
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(turn.startedAt));
  const remainingMs = Math.max(0, Date.parse(turn.deadlineAt) - Date.now());
  return `${turn.phase}; active ${formatDuration(ageMs)}; deadline in ${formatDuration(remainingMs)}${
    turn.lastEventAt ? `; last event ${formatDuration(Math.max(0, Date.now() - Date.parse(turn.lastEventAt)))} ago` : "; no agent events yet"
  }`;
}

function formatWorkerHealth(worker: AgentBackend | undefined, storedPid: number | undefined, turnActive: boolean): string {
  if (worker) {
    return `${worker.isAlive() ? "alive" : "not alive"}${storedPid ? ` (pid ${storedPid})` : ""}`;
  }
  if (turnActive) {
    return `missing${storedPid ? ` (stored pid ${storedPid})` : ""}`;
  }
  return storedPid ? `not loaded (stored pid ${storedPid})` : "not loaded";
}

function formatDeliveryHealth(health: DeliveryHealth): string {
  const fields: string[] = [`${health.state}`, `pending ${health.pending}`];
  if (health.lastSuccessAt) {
    fields.push(`last success ${formatDuration(Math.max(0, Date.now() - Date.parse(health.lastSuccessAt)))} ago`);
  }
  if (health.lastError) {
    fields.push(`last error: ${health.lastError}`);
  }
  if (health.cooldownUntil && Date.parse(health.cooldownUntil) > Date.now()) {
    fields.push(`cooldown ${formatDuration(Date.parse(health.cooldownUntil) - Date.now())}`);
  }
  return fields.join("; ");
}

function formatDeliveryLedger(health: DeliveryHealth): string {
  const summary = health.durable;
  const fields = [
    `queued ${summary.queued}`,
    `sending ${summary.sending}`,
    `sent ${summary.sent}`,
    `failed ${summary.failed}`,
    `expired ${summary.expired}`,
    `recent failures ${summary.recentFailures}`,
  ];
  if (summary.lastSentAt) {
    fields.push(`last sent ${formatDuration(Math.max(0, Date.now() - Date.parse(summary.lastSentAt)))} ago`);
  }
  if (summary.lastError) {
    fields.push(`last terminal error: ${summary.lastError}`);
  }
  return fields.join("; ");
}

function formatChannelHealth(health: ChannelHealth | undefined): string {
  if (!health) {
    return "unknown";
  }
  const fields: string[] = [health.state];
  if (health.lastSuccessAt) {
    fields.push(`last success ${formatDuration(Math.max(0, Date.now() - Date.parse(health.lastSuccessAt)))} ago`);
  }
  if (health.lastError) {
    fields.push(`last error: ${health.lastError}`);
  }
  return fields.join("; ");
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${Math.ceil(ms)}ms`;
  }
  const seconds = Math.ceil(ms / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function shortId(session: HubSession): string {
  return session.id.slice(0, 8);
}

function targetRuntimeKey(target: ChatTarget): string {
  return [target.platform, target.chatId, target.threadId ?? "", target.userId ?? ""].join(":");
}

function targetForSession(session: HubSession): ChatTarget {
  return {
    platform: session.platform,
    chatId: session.chatId,
    ...(session.threadId ? { threadId: session.threadId } : {}),
    ...(session.userId ? { userId: session.userId } : {}),
  };
}

function targetMatchesSession(target: ChatTarget, session: HubSession): boolean {
  return (
    target.platform === session.platform &&
    target.chatId === session.chatId &&
    (target.threadId ?? "") === (session.threadId ?? "")
  );
}

function isTurnBlocked(session: HubSession): boolean {
  return session.status === "running" || session.status === "waiting_approval" || session.status === "waiting_input";
}

function blockedTurnMessage(session: HubSession, inputKind: string): string {
  if (session.status === "waiting_approval") {
    return `Session is waiting for approval since ${session.updatedAt}. Use \`!approve <id>\`, \`!deny <id>\`, \`!status\`, or \`!abort\` before sending another ${inputKind}.`;
  }
  if (session.status === "waiting_input") {
    return `Session is waiting for a selection since ${session.updatedAt}. Reply with an option, use \`!status\`, or use \`!abort\` before sending another ${inputKind}.`;
  }

  return `Session is still running since ${session.updatedAt}. Wait for Pi to finish, use \`!status\`, or use \`!abort\` before sending another ${inputKind}.`;
}

type SelectionReply = { type: "option"; index: number } | { type: "next" } | { type: "previous" };

function selectionReplyFromText(text: string): SelectionReply | undefined {
  const trimmed = text.trim().toLowerCase();
  if (/^[0-9]$/.test(trimmed)) {
    return { type: "option", index: Number(trimmed) };
  }
  if (trimmed === "n") {
    return { type: "next" };
  }
  if (trimmed === "p") {
    return { type: "previous" };
  }
  return undefined;
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
    ...page.map((option, index) => `${index}. ${formatInteractionOption(option)}`),
  ];
  if (pageCount > 1) {
    lines.push("n. Next page", "p. Previous page");
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

import { randomUUID } from "node:crypto";
import type { ChannelAdapter, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { AuditLog } from "./audit-log.js";
import type { DeliveryRecord, DeliveryStore, DeliverySummary } from "./delivery-store.js";
import type { ChatTarget } from "./types.js";

export type DeliveryHealth = {
  state: "healthy" | "pending" | "degraded";
  pending: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  cooldownUntil?: string;
  durable: DeliverySummary;
};

export type DeliveryContext = {
  sessionId?: string;
  turnId?: string;
};

export type DeliveryPriority = "progress" | "normal" | "authoritative";

export type DeliveryCoordinatorOptions = {
  sendTimeoutMs: number;
  queueTtlMs: number;
  store: DeliveryStore;
  wechatFailureCooldownMs?: number;
};

export type ArtifactDeliveryMetadata = {
  deliveryId?: string;
  source?: string;
  contentLength?: number;
};

type DeliveryState = Omit<DeliveryHealth, "durable"> & {
  tail: Promise<void>;
  progressGeneration: number;
  cooldownWaiters: Set<() => void>;
};

export class DeliveryCoordinator {
  private readonly states = new Map<string, DeliveryState>();
  private readonly textCompletions = new Map<string, Promise<void>>();
  private cooldownWaitsDisabled = false;

  constructor(
    private readonly channel: ChannelAdapter,
    private readonly audit: AuditLog,
    private readonly options: DeliveryCoordinatorOptions,
  ) {}

  enqueueText(
    target: ChatTarget,
    text: string,
    opts?: SendOptions,
    context: DeliveryContext = {},
    priority: DeliveryPriority = "normal",
  ): string | undefined {
    if (text.length === 0) {
      return undefined;
    }

    const deliveryId = randomUUID();
    const state = this.stateFor(target);
    if (priority === "authoritative") {
      state.progressGeneration += 1;
    }
    const progressGeneration = state.progressGeneration;
    const enqueuedAtMs = Date.now();
    const queuedAt = new Date(enqueuedAtMs).toISOString();
    const expiresAtMs = enqueuedAtMs + this.options.queueTtlMs;
    this.options.store.create({
      id: deliveryId,
      kind: "text",
      target,
      ...context,
      source: "hub_text",
      contentLength: text.length,
      queuedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    state.pending += 1;
    if (state.state !== "degraded") {
      state.state = "pending";
    }

    const run = state.tail.then(async () => {
      try {
        if (priority === "progress" && progressGeneration !== state.progressGeneration) {
          const supersededAt = new Date().toISOString();
          const message = "Progress delivery superseded by an authoritative response";
          this.options.store.markTerminal(deliveryId, "expired", supersededAt, {
            code: "superseded",
            message,
          });
          await this.writeTextAudit(target, context, {
            deliveryId,
            status: "expired",
            priority,
            length: text.length,
            expiredAt: supersededAt,
            queuedMs: Date.now() - enqueuedAtMs,
            error: message,
          });
          return;
        }
        if (priority === "authoritative" && !(await this.waitForCooldown(target, state, expiresAtMs))) {
          const stoppedAt = new Date().toISOString();
          const message = "Delivery stopped before its send attempt started";
          this.options.store.markTerminal(deliveryId, "expired", stoppedAt, {
            code: "delivery_stopped",
            message,
          });
          await this.writeTextAudit(target, context, {
            deliveryId,
            status: "expired",
            priority,
            length: text.length,
            expiredAt: stoppedAt,
            queuedMs: Date.now() - enqueuedAtMs,
            error: message,
          });
          return;
        }
        const attemptedAt = new Date().toISOString();
        if (this.options.store.expireQueuedIfDue(deliveryId, attemptedAt)) {
          const message = "Text delivery expired before its send attempt started";
          this.markFailure(target, state, new DeliveryExpiredError(message), message);
          await this.writeTextAudit(target, context, {
            deliveryId,
            status: "expired",
            priority,
            length: text.length,
            expiredAt: attemptedAt,
            queuedMs: Date.now() - enqueuedAtMs,
            error: message,
          });
          return;
        }
        if (!this.options.store.markSending(deliveryId, attemptedAt)) {
          throw new Error(`Delivery ${deliveryId} was not queued when its send attempt started`);
        }
        state.lastAttemptAt = attemptedAt;
        try {
          this.assertNotCoolingDown(target, state);
          await runWithTimeout(
            (signal) => this.channel.sendText(target, text, mergeSignal(opts, signal)),
            this.options.sendTimeoutMs,
            `Text delivery timed out after ${this.options.sendTimeoutMs}ms`,
          );
          this.requireTerminalTransition(deliveryId, "sent", new Date().toISOString());
          this.markSuccess(state);
          await this.writeTextAudit(target, context, {
            deliveryId,
            status: "sent",
            priority,
            length: text.length,
            attemptedAt,
            queuedMs: Date.parse(attemptedAt) - enqueuedAtMs,
          });
        } catch (error) {
          const message = formatError(error);
          this.options.store.markTerminal(deliveryId, "failed", new Date().toISOString(), {
            code: deliveryErrorCode(error),
            message,
          });
          this.markFailure(target, state, error, message);
          await this.writeTextAudit(target, context, {
            deliveryId,
            status: "failed",
            priority,
            length: text.length,
            attemptedAt,
            queuedMs: Date.parse(attemptedAt) - enqueuedAtMs,
            error: message,
          });
          process.stderr.write(`[hitch] Send failed: ${message}\n`);
        }
      } finally {
        state.pending -= 1;
        if (state.pending > 0 && state.state !== "degraded") {
          state.state = "pending";
        }
      }
    });

    const completion = run.catch(() => undefined);
    this.textCompletions.set(deliveryId, completion);
    state.tail = completion;
    void completion.finally(() => {
      if (this.textCompletions.get(deliveryId) === completion) {
        this.textCompletions.delete(deliveryId);
      }
    });
    return deliveryId;
  }

  async waitForTextDelivery(deliveryId: string): Promise<DeliveryRecord | undefined> {
    await this.textCompletions.get(deliveryId);
    return this.options.store.get(deliveryId);
  }

  async sendArtifact(
    target: ChatTarget,
    artifact: OutboundArtifact,
    opts?: SendOptions,
    context: DeliveryContext = {},
    metadata: ArtifactDeliveryMetadata = {},
    priority: DeliveryPriority = "normal",
  ): Promise<string> {
    if (!this.channel.sendArtifact) {
      throw new Error(`Channel does not support artifact delivery: ${target.platform}`);
    }

    const deliveryId = metadata.deliveryId ?? randomUUID();
    const state = this.stateFor(target);
    if (priority === "authoritative") {
      state.progressGeneration += 1;
    }
    const enqueuedAtMs = Date.now();
    const queuedAt = new Date(enqueuedAtMs).toISOString();
    const expiresAtMs = enqueuedAtMs + this.options.queueTtlMs;
    this.options.store.create({
      id: deliveryId,
      kind: "artifact",
      target,
      ...context,
      ...(metadata.source ? { source: metadata.source } : {}),
      ...(metadata.contentLength === undefined ? {} : { contentLength: metadata.contentLength }),
      queuedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    state.pending += 1;
    if (state.state !== "degraded") {
      state.state = "pending";
    }

    const run = state.tail.then(async () => {
      try {
        if (priority === "authoritative" && !(await this.waitForCooldown(target, state, expiresAtMs))) {
          const message = "Delivery stopped before its send attempt started";
          this.options.store.markTerminal(deliveryId, "expired", new Date().toISOString(), {
            code: "delivery_stopped",
            message,
          });
          throw new DeliveryStoppedError(message);
        }
        const attemptedAt = new Date().toISOString();
        if (this.options.store.expireQueuedIfDue(deliveryId, attemptedAt)) {
          const message = "Media delivery expired before its send attempt started";
          this.markFailure(target, state, new DeliveryExpiredError(message), message);
          throw new DeliveryExpiredError(message);
        }
        if (!this.options.store.markSending(deliveryId, attemptedAt)) {
          throw new Error(`Delivery ${deliveryId} was not queued when its send attempt started`);
        }
        state.lastAttemptAt = attemptedAt;
        try {
          this.assertNotCoolingDown(target, state);
          await runWithTimeout(
            (signal) => this.channel.sendArtifact!(target, artifact, mergeSignal(opts, signal)),
            this.options.sendTimeoutMs,
            `Media delivery timed out after ${this.options.sendTimeoutMs}ms`,
          );
          this.requireTerminalTransition(deliveryId, "sent", new Date().toISOString());
          this.markSuccess(state);
        } catch (error) {
          const message = formatError(error);
          this.options.store.markTerminal(deliveryId, "failed", new Date().toISOString(), {
            code: deliveryErrorCode(error),
            message,
          });
          this.markFailure(target, state, error, message);
          throw error;
        }
      } finally {
        state.pending -= 1;
        if (state.pending > 0 && state.state !== "degraded") {
          state.state = "pending";
        }
      }
    });

    state.tail = run.catch(() => undefined);
    await run;
    return deliveryId;
  }

  noteInbound(target: ChatTarget): void {
    const state = this.states.get(targetKey(target));
    if (state) {
      delete state.cooldownUntil;
      this.wakeCooldownWaiters(state);
    }
  }

  stop(): void {
    this.cooldownWaitsDisabled = true;
    for (const state of this.states.values()) {
      this.wakeCooldownWaiters(state);
    }
  }

  health(target: ChatTarget): DeliveryHealth {
    const state = this.states.get(targetKey(target));
    if (!state) {
      return { state: "healthy", pending: 0, durable: this.options.store.summary(target) };
    }
    return {
      state: state.state,
      pending: state.pending,
      durable: this.options.store.summary(target),
      ...(state.lastAttemptAt ? { lastAttemptAt: state.lastAttemptAt } : {}),
      ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.cooldownUntil ? { cooldownUntil: state.cooldownUntil } : {}),
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.states.values()].map((state) => state.tail));
  }

  private stateFor(target: ChatTarget): DeliveryState {
    const key = targetKey(target);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const created: DeliveryState = {
      state: "healthy",
      pending: 0,
      tail: Promise.resolve(),
      progressGeneration: 0,
      cooldownWaiters: new Set(),
    };
    this.states.set(key, created);
    return created;
  }

  private assertNotCoolingDown(target: ChatTarget, state: DeliveryState): void {
    if (target.platform !== "wechat" || !state.cooldownUntil) {
      return;
    }
    const remainingMs = Date.parse(state.cooldownUntil) - Date.now();
    if (remainingMs <= 0) {
      delete state.cooldownUntil;
      return;
    }
    throw new DeliveryCooldownError(
      `WeChat delivery cooling down for ${Math.ceil(remainingMs / 1_000)}s after: ${state.lastError ?? "send failure"}`,
    );
  }

  private async waitForCooldown(target: ChatTarget, state: DeliveryState, expiresAtMs: number): Promise<boolean> {
    if (target.platform !== "wechat" || !state.cooldownUntil) {
      return true;
    }
    while (!this.cooldownWaitsDisabled && state.cooldownUntil) {
      const remainingMs = Date.parse(state.cooldownUntil) - Date.now();
      if (remainingMs <= 0) {
        delete state.cooldownUntil;
        break;
      }
      const ttlRemainingMs = expiresAtMs - Date.now();
      if (ttlRemainingMs <= 0) {
        return true;
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = () => {
          if (timer) {
            clearTimeout(timer);
          }
          state.cooldownWaiters.delete(wake);
          resolve();
        };
        state.cooldownWaiters.add(wake);
        timer = setTimeout(wake, Math.min(remainingMs, ttlRemainingMs));
      });
    }
    return !state.cooldownUntil;
  }

  private wakeCooldownWaiters(state: DeliveryState): void {
    for (const wake of [...state.cooldownWaiters]) {
      wake();
    }
  }

  private markSuccess(state: DeliveryState): void {
    state.lastSuccessAt = new Date().toISOString();
    delete state.cooldownUntil;
    this.wakeCooldownWaiters(state);
    if (state.pending === 1) {
      state.state = "healthy";
    }
  }

  private markFailure(target: ChatTarget, state: DeliveryState, error: unknown, message: string): void {
    state.state = "degraded";
    state.lastFailureAt = new Date().toISOString();
    if (error instanceof DeliveryCooldownError) {
      return;
    }
    state.lastError = message;
    if (error instanceof DeliveryExpiredError) {
      return;
    }
    const cooldownMs = this.options.wechatFailureCooldownMs ?? 0;
    if (target.platform === "wechat" && cooldownMs > 0) {
      state.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    }
  }

  private requireTerminalTransition(deliveryId: string, status: "sent", at: string): void {
    if (!this.options.store.markTerminal(deliveryId, status, at)) {
      throw new Error(`Delivery ${deliveryId} could not transition to ${status}`);
    }
  }

  private async writeTextAudit(
    target: ChatTarget,
    context: DeliveryContext,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.writeAudit({
      type: "text.delivery",
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      target,
      details: {
        ...details,
        ...(context.turnId ? { turnId: context.turnId } : {}),
      },
    });
  }

  private async writeAudit(event: Parameters<AuditLog["write"]>[0]): Promise<void> {
    try {
      await this.audit.write(event);
    } catch (error) {
      process.stderr.write(`[hitch] Delivery audit failed: ${formatError(error)}\n`);
    }
  }
}

class DeliveryCooldownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryCooldownError";
  }
}

class DeliveryExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryExpiredError";
  }
}

class DeliveryStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryStoppedError";
  }
}

export async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = operation(controller.signal);
  // Some third-party clients do not observe AbortSignal. The race still keeps
  // Hitch bounded, while this catch prevents a later rejection from becoming
  // unhandled.
  void operationPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(timeoutMessage);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function mergeSignal(opts: SendOptions | undefined, signal: AbortSignal): SendOptions {
  return {
    ...(opts ?? {}),
    signal: opts?.signal ? AbortSignal.any([opts.signal, signal]) : signal,
  };
}

function targetKey(target: ChatTarget): string {
  return [target.platform, target.chatId, target.threadId ?? "", target.userId ?? ""].join(":");
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

function deliveryErrorCode(error: unknown): string {
  if (error instanceof DeliveryCooldownError) {
    return "cooldown";
  }
  if (error instanceof DeliveryExpiredError) {
    return "queue_expired";
  }
  if (error instanceof Error && error.message.includes("timed out")) {
    return "send_timeout";
  }
  return "send_failed";
}

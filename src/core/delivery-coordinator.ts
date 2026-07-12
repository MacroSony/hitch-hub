import type { ChannelAdapter, SendOptions } from "../channels/types.js";
import type { AuditLog } from "./audit-log.js";
import type { ChatTarget } from "./types.js";

export type DeliveryHealth = {
  state: "healthy" | "pending" | "degraded";
  pending: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
};

type DeliveryState = DeliveryHealth & {
  tail: Promise<void>;
};

export class DeliveryCoordinator {
  private readonly states = new Map<string, DeliveryState>();

  constructor(
    private readonly channel: ChannelAdapter,
    private readonly audit: AuditLog,
    private readonly timeoutMs: number,
  ) {}

  enqueueText(target: ChatTarget, text: string, opts?: SendOptions): void {
    if (text.length === 0) {
      return;
    }

    const state = this.stateFor(target);
    const enqueuedAtMs = Date.now();
    const deadlineAtMs = enqueuedAtMs + this.timeoutMs;
    state.pending += 1;
    if (state.state !== "degraded") {
      state.state = "pending";
    }

    const run = state.tail.then(async () => {
      const attemptedAt = new Date().toISOString();
      state.lastAttemptAt = attemptedAt;
      try {
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`Text delivery expired in the queue after ${this.timeoutMs}ms`);
        }
        await runWithTimeout(
          (signal) => this.channel.sendText(target, text, mergeSignal(opts, signal)),
          remainingMs,
          `Text delivery timed out after ${this.timeoutMs}ms`,
        );
        state.lastSuccessAt = new Date().toISOString();
        if (state.pending === 1) {
          state.state = "healthy";
        }
        await this.writeAudit({
          type: "text.delivery",
          target,
          details: { status: "sent", length: text.length, attemptedAt, queuedMs: Date.now() - enqueuedAtMs },
        });
      } catch (error) {
        const message = formatError(error);
        state.state = "degraded";
        state.lastFailureAt = new Date().toISOString();
        state.lastError = message;
        await this.writeAudit({
          type: "text.delivery",
          target,
          details: { status: "failed", length: text.length, attemptedAt, queuedMs: Date.now() - enqueuedAtMs, error: message },
        });
        process.stderr.write(`[hitch] Send failed: ${message}\n`);
      } finally {
        state.pending -= 1;
        if (state.pending > 0 && state.state !== "degraded") {
          state.state = "pending";
        }
      }
    });

    state.tail = run.catch(() => undefined);
  }

  health(target: ChatTarget): DeliveryHealth {
    const state = this.states.get(targetKey(target));
    if (!state) {
      return { state: "healthy", pending: 0 };
    }
    return {
      state: state.state,
      pending: state.pending,
      ...(state.lastAttemptAt ? { lastAttemptAt: state.lastAttemptAt } : {}),
      ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
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
    };
    this.states.set(key, created);
    return created;
  }

  private async writeAudit(event: Parameters<AuditLog["write"]>[0]): Promise<void> {
    try {
      await this.audit.write(event);
    } catch (error) {
      process.stderr.write(`[hitch] Delivery audit failed: ${formatError(error)}\n`);
    }
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

import type { Platform } from "../core/types.js";
import type { ChannelAdapter, ChannelHealth, InboundChatEvent, OutboundArtifact, SendOptions } from "./types.js";

type ChannelEntry = {
  platform: Platform;
  adapter: ChannelAdapter;
};

type QueueItem =
  | { type: "event"; event: InboundChatEvent }
  | { type: "error"; error: unknown };

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }

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

export class MultiChannelAdapter implements ChannelAdapter {
  private readonly adapters = new Map<Platform, ChannelAdapter>();

  constructor(entries: ChannelEntry[]) {
    if (entries.length === 0) {
      throw new Error("MultiChannelAdapter requires at least one channel.");
    }

    for (const entry of entries) {
      if (this.adapters.has(entry.platform)) {
        throw new Error(`Duplicate channel adapter for platform: ${entry.platform}`);
      }
      this.adapters.set(entry.platform, entry.adapter);
    }
  }

  async *receive(): AsyncIterable<InboundChatEvent> {
    const queue = new AsyncEventQueue<QueueItem>();
    let active = this.adapters.size;
    let lastError: unknown;

    for (const [platform, adapter] of this.adapters) {
      void (async () => {
        try {
          for await (const event of adapter.receive()) {
            queue.push({ type: "event", event });
          }
        } catch (error) {
          lastError = error;
          process.stderr.write(`[hitch] ${platform} channel receive stopped: ${formatError(error)}\n`);
        } finally {
          active -= 1;
          if (active === 0) {
            if (lastError) {
              queue.push({ type: "error", error: lastError });
            }
            queue.close();
          }
        }
      })();
    }

    for await (const item of queue.iterate()) {
      if (item.type === "error") {
        throw item.error;
      }
      yield item.event;
    }
  }

  async sendText(target: InboundChatEvent["target"], text: string, opts?: SendOptions): Promise<void> {
    await this.adapterFor(target.platform).sendText(target, text, opts);
  }

  async sendArtifact(target: InboundChatEvent["target"], artifact: OutboundArtifact, opts?: SendOptions): Promise<void> {
    const adapter = this.adapterFor(target.platform);
    if (!adapter.sendArtifact) {
      throw new Error(`Channel does not support artifact delivery: ${target.platform}`);
    }
    await adapter.sendArtifact(target, artifact, opts);
  }

  health(target: InboundChatEvent["target"]): ChannelHealth {
    return this.adapterFor(target.platform).health?.(target) ?? { state: "healthy" };
  }

  private adapterFor(platform: Platform): ChannelAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`No channel adapter for platform: ${platform}`);
    }
    return adapter;
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

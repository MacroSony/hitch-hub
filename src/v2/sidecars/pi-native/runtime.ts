import { AsyncLocalStorage } from "node:async_hooks";

import {
  PI_NATIVE_BRIDGE_COMPATIBILITY,
  PI_NATIVE_BRIDGE_LIMITS,
  PI_NATIVE_BRIDGE_PROTOCOL_VERSION,
  PiNativeBridgeCorrelationGuard,
  decodePiNativeBridgeClientFrame,
  decodePiNativeBridgeSidecarFrame,
  type PiNativeBridgeBinding,
  type PiNativeBridgeSidecarFrame,
  type PiNativeCancelFrame,
  type PiNativeErrorFrame,
  type PiNativeInvokeFrame,
} from "../../bridges/pi-native/frames.js";
import {
  PiNativeCredentialUnavailableError,
  type BoundPiNativeCredentialSource,
} from "./credential-store.js";
import type { InstalledPiNativeSidecarFetchBoundary } from "./fetch-boundary.js";
import {
  PiNativeEventAdapter,
  type PiNativeAdaptedEvent,
  type PiNativeEventStream,
} from "./native-events.js";
import { PiNativeReplayError, PiNativeReplayGuard } from "./replay-guard.js";
import {
  enforcePiNativeInvocationPolicy,
  preparePiNativeSidecar,
  type PiNativeInvocationExecutor,
} from "./sidecar.js";

export const PI_NATIVE_MAXIMUM_OAUTH_STATUS_EVENTS = 256;
const PI_NATIVE_DELTA_COALESCE_CHARACTERS = 1_024;

type PiNativeAdaptedDelta = Extract<
  PiNativeAdaptedEvent,
  { readonly delta: string }
>;

type OAuthRefreshState =
  | "refresh-started"
  | "refresh-succeeded"
  | "refresh-failed";

interface OAuthInvocationContext {
  readonly states: OAuthRefreshState[];
  count: number;
  credentialUnavailable: boolean;
}

interface ActivePiNativeInvocation {
  readonly controller: AbortController;
  invocation?: PiNativeBridgeInvocation;
  nativeOpened: boolean;
  started: boolean;
}

export type PiNativeExecutionErrorCode =
  | "provider-error"
  | "credential-unavailable";

/** A sanitized failure classification supplied by the trusted A/B integration. */
export class PiNativeExecutionError extends Error {
  constructor(readonly code: PiNativeExecutionErrorCode) {
    super(`Pi native execution failed with ${code}`);
    this.name = "PiNativeExecutionError";
  }
}

export interface PiNativeBridgeInvocation extends AsyncIterable<PiNativeBridgeSidecarFrame> {
  readonly correlationId: string;
  dispose(): Promise<void>;
}

export interface PiNativeBridgeRuntime {
  invoke(frame: unknown): PiNativeBridgeInvocation;
  cancel(frame: unknown): void;
  close(): void;
}

class PiNativeRuntimeFailure extends Error {
  constructor(readonly code: PiNativeErrorFrame["code"]) {
    super(`Pi native runtime failed with ${code}`);
    this.name = "PiNativeRuntimeFailure";
  }
}

/**
 * One-process A3 event runtime. Replay records intentionally live only for
 * this runtime lifetime; V2-011 owns durable forwarding and restart replay.
 */
export function createPiNativeBridgeRuntime(input: {
  readonly boundary: InstalledPiNativeSidecarFetchBoundary;
  readonly credentialSource: BoundPiNativeCredentialSource;
  readonly executor: PiNativeInvocationExecutor<PiNativeEventStream>;
  readonly replayMaximumRecords?: number;
}): PiNativeBridgeRuntime {
  const oauthStorage = new AsyncLocalStorage<OAuthInvocationContext>();
  const sidecar = preparePiNativeSidecar({
    boundary: input.boundary,
    credentialSource: input.credentialSource,
    executor: input.executor,
    credentialObserver: {
      onOAuthRefreshState(state): void {
        const context = oauthStorage.getStore();
        if (context === undefined) {
          throw new PiNativeRuntimeFailure("protocol-error");
        }
        context.count += 1;
        if (context.count > PI_NATIVE_MAXIMUM_OAUTH_STATUS_EVENTS) {
          throw new PiNativeRuntimeFailure("protocol-error");
        }
        context.states.push(state);
      },
      onCredentialUnavailable(): void {
        const context = oauthStorage.getStore();
        if (context === undefined) {
          throw new PiNativeRuntimeFailure("protocol-error");
        }
        context.credentialUnavailable = true;
      },
    },
  });
  const binding: PiNativeBridgeBinding = Object.freeze({
    bridgeId: sidecar.manifest.bridge.id,
    nativeStackDigest: sidecar.manifest.nativeStackDigest,
    nativeCatalogDigest: sidecar.manifest.catalog.digest,
  });
  const correlations = new PiNativeBridgeCorrelationGuard();
  const replay = new PiNativeReplayGuard(input.replayMaximumRecords);
  const active = new Map<string, ActivePiNativeInvocation>();
  let closed = false;

  const decodeOutput = (
    invocation: PiNativeInvokeFrame,
    fields: Record<string, unknown>,
  ): PiNativeBridgeSidecarFrame => {
    const frame = decodePiNativeBridgeSidecarFrame(
      {
        protocolVersion: PI_NATIVE_BRIDGE_PROTOCOL_VERSION,
        correlationId: invocation.correlationId,
        compatibility: PI_NATIVE_BRIDGE_COMPATIBILITY,
        binding,
        ...fields,
      },
      { correlationId: invocation.correlationId, binding },
    );
    correlations.acceptSidecar(frame);
    if (frame.kind === "terminal" || frame.kind === "cancelled" || frame.kind === "error") {
      const activeInvocation = active.get(frame.correlationId);
      if (activeInvocation !== undefined) {
        if (frame.kind !== "terminal") activeInvocation.controller.abort();
        active.delete(frame.correlationId);
      }
    }
    return frame;
  };

  const failedInvocation = (
    invocation: PiNativeInvokeFrame,
    code: PiNativeErrorFrame["code"],
  ): PiNativeBridgeInvocation => {
    const failure = decodeOutput(invocation, {
      kind: "error",
      code,
      message: errorMessage(code),
    });
    return oneUseInvocation(
      invocation.correlationId,
      async function* failed(): AsyncGenerator<PiNativeBridgeSidecarFrame> {
        yield failure;
      },
    );
  };

  const run = async function* runInvocation(
    invocation: PiNativeInvokeFrame,
    activeInvocation: ActivePiNativeInvocation,
  ): AsyncGenerator<PiNativeBridgeSidecarFrame> {
    const { controller } = activeInvocation;
    const oauth: OAuthInvocationContext = {
      states: [],
      count: 0,
      credentialUnavailable: false,
    };
    let iterator: AsyncIterator<unknown> | undefined;
    let iteratorFinished = false;
    const pendingDeltas = new Map<string, PiNativeAdaptedDelta>();
    const drainOAuth = (): PiNativeBridgeSidecarFrame[] => oauth.states.splice(0).map(
      (state) => decodeOutput(invocation, { kind: "oauth-status", state }),
    );
    const deltaKey = (
      delta: Pick<PiNativeAdaptedDelta, "kind" | "contentIndex">,
    ): string => `${delta.kind}:${delta.contentIndex}`;
    const flushPendingDeltas = (onlyKey?: string): PiNativeBridgeSidecarFrame[] => {
      const keys = onlyKey === undefined ? [...pendingDeltas.keys()] : [onlyKey];
      const frames: PiNativeBridgeSidecarFrame[] = [];
      for (const key of keys) {
        const pending = pendingDeltas.get(key);
        if (pending === undefined) continue;
        pendingDeltas.delete(key);
        const { kind, ...fields } = pending;
        frames.push(decodeOutput(invocation, { kind, ...fields }));
      }
      return frames;
    };
    const adaptForBridge = (
      adapted: PiNativeAdaptedEvent,
    ): PiNativeBridgeSidecarFrame[] => {
      if (adapted.kind === "native-terminal") return flushPendingDeltas();
      if (
        adapted.kind !== "text-delta" &&
        adapted.kind !== "reasoning-delta" &&
        adapted.kind !== "tool-delta"
      ) {
        const endingDeltaKind = adapted.kind === "text-end"
          ? "text-delta"
          : adapted.kind === "reasoning-end"
            ? "reasoning-delta"
            : adapted.kind === "tool-end"
              ? "tool-delta"
              : undefined;
        const prior = endingDeltaKind === undefined
          ? []
          : flushPendingDeltas(`${endingDeltaKind}:${adapted.contentIndex}`);
        const { kind, ...fields } = adapted;
        return [...prior, decodeOutput(invocation, { kind, ...fields })];
      }
      if (adapted.delta.length === 0) return [];
      const key = deltaKey(adapted);
      const pending = pendingDeltas.get(key);
      const combined = pending === undefined
        ? adapted
        : { ...adapted, delta: pending.delta + adapted.delta };
      pendingDeltas.set(key, combined);
      return combined.delta.length >= PI_NATIVE_DELTA_COALESCE_CHARACTERS
        ? flushPendingDeltas(key)
        : [];
    };
    try {
      if (controller.signal.aborted) {
        yield decodeOutput(invocation, { kind: "cancelled" });
        return;
      }
      yield decodeOutput(invocation, { kind: "started" });
      if (controller.signal.aborted) {
        yield decodeOutput(invocation, { kind: "cancelled" });
        return;
      }

      let stream: PiNativeEventStream;
      try {
        activeInvocation.nativeOpened = true;
        stream = await oauthStorage.run(
          oauth,
          () => sidecar.invoke(invocation, controller.signal),
        );
      } catch (error) {
        yield* drainOAuth();
        if (controller.signal.aborted) {
          yield decodeOutput(invocation, { kind: "cancelled" });
          return;
        }
        throw classifyExecutionFailure(error);
      }
      yield* drainOAuth();
      if (!isPiNativeEventStream(stream)) {
        throw new PiNativeRuntimeFailure("protocol-error");
      }

      const adapter = new PiNativeEventAdapter(sidecar.manifest.catalog.model);
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        let step: IteratorResult<unknown>;
        try {
          step = await oauthStorage.run(oauth, () => iterator!.next());
        } catch (error) {
          yield* flushPendingDeltas();
          yield* drainOAuth();
          if (controller.signal.aborted) {
            yield decodeOutput(invocation, { kind: "cancelled" });
            return;
          }
          throw classifyExecutionFailure(error);
        }
        if (oauth.states.length > 0) {
          yield* drainOAuth();
        }
        if (controller.signal.aborted) {
          yield* flushPendingDeltas();
          yield decodeOutput(invocation, { kind: "cancelled" });
          return;
        }
        if (step.done) {
          yield* flushPendingDeltas();
          iteratorFinished = true;
          break;
        }
        let adapted: PiNativeAdaptedEvent | undefined;
        try {
          adapted = adapter.accept(step.value);
        } catch {
          yield* flushPendingDeltas();
          throw new PiNativeRuntimeFailure("protocol-error");
        }
        if (adapted === undefined) continue;
        yield* adaptForBridge(adapted);
      }

      let rawResult: unknown;
      try {
        rawResult = await oauthStorage.run(oauth, () => stream.result());
      } catch (error) {
        yield* drainOAuth();
        if (controller.signal.aborted) {
          yield decodeOutput(invocation, { kind: "cancelled" });
          return;
        }
        throw classifyExecutionFailure(error);
      }
      yield* drainOAuth();
      let terminal;
      try {
        terminal = adapter.finish(rawResult);
      } catch {
        throw new PiNativeRuntimeFailure("protocol-error");
      }
      yield decodeOutput(invocation, { kind: "usage", usage: terminal.usage });
      if (terminal.outcome === "done") {
        yield decodeOutput(invocation, {
          kind: "terminal",
          reason: terminal.reason,
          usage: terminal.usage,
        });
      } else if (terminal.reason === "aborted") {
        yield decodeOutput(invocation, { kind: "cancelled" });
      } else {
        yield decodeOutput(invocation, {
          kind: "error",
          code: oauth.credentialUnavailable
            ? "credential-unavailable"
            : "provider-error",
          message: errorMessage(
            oauth.credentialUnavailable
              ? "credential-unavailable"
              : "provider-error",
          ),
        });
      }
    } catch (error) {
      const failure = error instanceof PiNativeRuntimeFailure
        ? error
        : new PiNativeRuntimeFailure("protocol-error");
      yield decodeOutput(invocation, {
        kind: "error",
        code: failure.code,
        message: errorMessage(failure.code),
      });
    } finally {
      if (!iteratorFinished) controller.abort();
      if (active.get(invocation.correlationId) === activeInvocation) {
        active.delete(invocation.correlationId);
      }
      correlations.release(invocation.correlationId);
      if (!activeInvocation.nativeOpened) replay.release(invocation.correlationId);
      if (!iteratorFinished && iterator?.return !== undefined) {
        try {
          await iterator.return();
        } catch {
          // The bridge outcome is already fixed and sanitized.
        }
      }
    }
  };

  return Object.freeze({
    invoke(rawFrame: unknown): PiNativeBridgeInvocation {
      if (closed) throw new Error("Pi native bridge runtime is closed");
      const frame = decodePiNativeBridgeClientFrame(rawFrame, { binding });
      if (frame.kind !== "invoke") {
        throw new Error("Pi native runtime invoke requires an invocation frame");
      }
      correlations.acceptClient(frame);
      try {
        enforcePiNativeInvocationPolicy(frame, sidecar.manifest.catalog.model);
      } catch {
        return failedInvocation(frame, "policy-denied");
      }
      try {
        replay.claim(
          frame,
          Math.min(
            sidecar.manifest.catalog.model.maximumOutputTokens,
            PI_NATIVE_BRIDGE_LIMITS.maximumOutputTokens,
          ),
        );
      } catch (error) {
        if (error instanceof PiNativeReplayError) {
          return failedInvocation(frame, "policy-denied");
        }
        correlations.release(frame.correlationId);
        throw error;
      }
      const activeInvocation: ActivePiNativeInvocation = {
        controller: new AbortController(),
        nativeOpened: false,
        started: false,
      };
      active.set(frame.correlationId, activeInvocation);
      const invocation = oneUseInvocation(
        frame.correlationId,
        () => run(frame, activeInvocation),
        {
          onStart(): void {
            activeInvocation.started = true;
          },
          onDispose(started): void {
            if (active.get(frame.correlationId) !== activeInvocation) return;
            if (started) {
              activeInvocation.controller.abort();
              return;
            }
            active.delete(frame.correlationId);
            correlations.release(frame.correlationId);
            replay.release(frame.correlationId);
          },
        },
      );
      activeInvocation.invocation = invocation;
      return invocation;
    },

    cancel(rawFrame: unknown): void {
      const frame = decodePiNativeBridgeClientFrame(rawFrame, { binding });
      if (frame.kind !== "cancel") {
        throw new Error("Pi native runtime cancel requires a cancellation frame");
      }
      const activeInvocation = active.get(frame.correlationId);
      if (activeInvocation === undefined) {
        throw new Error("Pi native cancellation has no active invocation");
      }
      correlations.acceptClient(frame as PiNativeCancelFrame);
      activeInvocation.controller.abort();
    },

    close(): void {
      if (closed) return;
      closed = true;
      for (const activeInvocation of active.values()) {
        activeInvocation.controller.abort();
        void activeInvocation.invocation?.dispose().catch(() => {
          // The controller is already aborted and final cleanup is best-effort.
        });
      }
    },
  });
}

function oneUseInvocation(
  correlationId: string,
  open: () => AsyncGenerator<PiNativeBridgeSidecarFrame>,
  lifecycle: {
    readonly onStart?: () => void;
    readonly onDispose?: (opened: boolean) => void;
  } = {},
): PiNativeBridgeInvocation {
  let opened = false;
  let started = false;
  let disposed = false;
  let iterator: AsyncGenerator<PiNativeBridgeSidecarFrame> | undefined;
  let lifecycleDisposed = false;
  const disposeLifecycle = (): void => {
    if (lifecycleDisposed) return;
    lifecycleDisposed = true;
    lifecycle.onDispose?.(started);
  };
  return Object.freeze({
    correlationId,
    [Symbol.asyncIterator](): AsyncIterator<PiNativeBridgeSidecarFrame> {
      if (disposed) throw new Error("Pi native bridge invocation stream is disposed");
      if (opened) throw new Error("Pi native bridge invocation stream is one-use");
      opened = true;
      iterator = open();
      return {
        next(): Promise<IteratorResult<PiNativeBridgeSidecarFrame>> {
          if (disposed) {
            return Promise.reject(new Error("Pi native bridge invocation stream is disposed"));
          }
          if (!started) {
            started = true;
            lifecycle.onStart?.();
          }
          return iterator!.next();
        },
        async return(): Promise<IteratorResult<PiNativeBridgeSidecarFrame>> {
          disposed = true;
          disposeLifecycle();
          return iterator!.return(undefined);
        },
        async throw(error?: unknown): Promise<IteratorResult<PiNativeBridgeSidecarFrame>> {
          disposed = true;
          disposeLifecycle();
          return iterator!.throw(error);
        },
      };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      disposeLifecycle();
      if (iterator?.return !== undefined) await iterator.return(undefined);
    },
  });
}

function classifyExecutionFailure(error: unknown): PiNativeRuntimeFailure {
  if (error instanceof PiNativeRuntimeFailure) return error;
  if (error instanceof PiNativeCredentialUnavailableError) {
    return new PiNativeRuntimeFailure("credential-unavailable");
  }
  if (error instanceof PiNativeExecutionError) {
    return new PiNativeRuntimeFailure(error.code);
  }
  return new PiNativeRuntimeFailure("provider-error");
}

function isPiNativeEventStream(input: unknown): input is PiNativeEventStream {
  return input !== null &&
    typeof input === "object" &&
    typeof (input as Partial<PiNativeEventStream>).result === "function" &&
    typeof (input as Partial<PiNativeEventStream>)[Symbol.asyncIterator] === "function";
}

function errorMessage(code: PiNativeErrorFrame["code"]): string {
  switch (code) {
    case "provider-error": return "The native provider request failed.";
    case "credential-unavailable": return "The bound provider credential was unavailable.";
    case "protocol-error": return "The pinned native event stream violated its protocol.";
    case "policy-denied": return "The native invocation was denied by frozen policy or replay protection.";
  }
}

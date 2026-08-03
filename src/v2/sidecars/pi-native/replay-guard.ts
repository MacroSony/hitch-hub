import type { PiNativeInvokeFrame } from "../../bridges/pi-native/frames.js";
import { digestDecodedPiNativeValue } from "./digest.js";

export const PI_NATIVE_REPLAY_GUARD_MAXIMUM_RECORDS = 256;

export class PiNativeReplayError extends Error {
  constructor(
    readonly reason: "correlation-replay" | "semantic-replay",
  ) {
    super(`Pi native invocation replay guard rejected ${reason}`);
    this.name = "PiNativeReplayError";
  }
}

/**
 * Bounded process-local prefilter for one sidecar lifetime. V2-011 remains the
 * durable forwarding/restart replay authority.
 */
export class PiNativeReplayGuard {
  readonly #correlations = new Map<string, string>();
  readonly #fingerprints = new Set<string>();
  readonly #order: string[] = [];

  constructor(
    readonly maximumRecords = PI_NATIVE_REPLAY_GUARD_MAXIMUM_RECORDS,
  ) {
    if (
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords < 1 ||
      maximumRecords > PI_NATIVE_REPLAY_GUARD_MAXIMUM_RECORDS
    ) {
      throw new Error("Pi native replay capacity is outside its reviewed bound");
    }
  }

  get size(): number {
    return this.#correlations.size;
  }

  claim(frame: PiNativeInvokeFrame, modelMaximumOutputTokens: number): void {
    if (!Number.isSafeInteger(modelMaximumOutputTokens) || modelMaximumOutputTokens < 1) {
      throw new Error("Pi native replay normalization requires a positive model output limit");
    }
    if (this.#correlations.has(frame.correlationId)) {
      throw new PiNativeReplayError("correlation-replay");
    }
    const fingerprint = digestDecodedPiNativeValue({
      protocolVersion: frame.protocolVersion,
      compatibility: frame.compatibility,
      binding: frame.binding,
      context: {
        messages: frame.context.messages,
        ...(frame.context.systemPrompt === undefined || frame.context.systemPrompt.length === 0
          ? {}
          : { systemPrompt: frame.context.systemPrompt }),
        ...(frame.context.tools === undefined || frame.context.tools.length === 0
          ? {}
          : { tools: frame.context.tools }),
      },
      options: {
        maximumOutputTokens:
          frame.options.maximumOutputTokens ?? modelMaximumOutputTokens,
        ...(frame.options.reasoning === undefined
          ? {}
          : { reasoning: frame.options.reasoning }),
      },
      nativeSeam: frame.nativeSeam,
    });
    if (this.#fingerprints.has(fingerprint)) {
      throw new PiNativeReplayError("semantic-replay");
    }
    if (this.#order.length >= this.maximumRecords) {
      const evictedCorrelation = this.#order.shift()!;
      const evictedFingerprint = this.#correlations.get(evictedCorrelation)!;
      this.#correlations.delete(evictedCorrelation);
      this.#fingerprints.delete(evictedFingerprint);
    }
    this.#correlations.set(frame.correlationId, fingerprint);
    this.#fingerprints.add(fingerprint);
    this.#order.push(frame.correlationId);
  }

  /** Release a claim only when no native execution was opened. */
  release(correlationId: string): void {
    const fingerprint = this.#correlations.get(correlationId);
    if (fingerprint === undefined) return;
    this.#correlations.delete(correlationId);
    this.#fingerprints.delete(fingerprint);
    const index = this.#order.indexOf(correlationId);
    if (index >= 0) this.#order.splice(index, 1);
  }
}

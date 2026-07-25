import type {
  Clock,
  IdSource,
  ServiceAllocatedIdKind,
} from "../model/application.js";
import type {
  Id,
  IsoTimestamp,
  OriginMessageId,
  TurnIdempotencyKey,
} from "../model/primitives.js";

const DEFAULT_INSTANT = "2000-01-01T00:00:00.000Z";

function asIsoTimestamp(value: string): IsoTimestamp {
  return value as IsoTimestamp;
}

function requireFiniteMilliseconds(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError("milliseconds must be a non-negative safe integer");
  }
}

/** Deterministic implementation of the production Clock port. */
export class DeterministicClock implements Clock {
  #milliseconds: number;

  constructor(initial: string = DEFAULT_INSTANT) {
    const milliseconds = Date.parse(initial);
    if (
      !Number.isFinite(milliseconds) ||
      new Date(milliseconds).toISOString() !== initial
    ) {
      throw new TypeError(
        "initial clock value must be a canonical UTC timestamp",
      );
    }
    this.#milliseconds = milliseconds;
  }

  now(): IsoTimestamp {
    return asIsoTimestamp(new Date(this.#milliseconds).toISOString());
  }

  advance(milliseconds: number): IsoTimestamp {
    requireFiniteMilliseconds(milliseconds);
    const next = this.#milliseconds + milliseconds;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("clock advance exceeds the safe integer range");
    }
    if (!Number.isFinite(new Date(next).getTime())) {
      throw new RangeError("clock advance exceeds the supported date range");
    }
    this.#milliseconds = next;
    return this.now();
  }
}

function requireNamespace(namespace: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(namespace)) {
    throw new TypeError(
      "deterministic ID namespace must be 1-32 lowercase alphanumeric/hyphen characters",
    );
  }
}

/** Deterministic, readable implementation of the production IdSource port. */
export class DeterministicIdSource implements IdSource {
  readonly #namespace: string;
  readonly #kindCounters = new Map<ServiceAllocatedIdKind, number>();
  #idempotencyCounter = 0;
  #originCounter = 0;

  constructor(namespace = "test") {
    requireNamespace(namespace);
    this.#namespace = namespace;
  }

  next<Kind extends ServiceAllocatedIdKind>(kind: Kind): Id<Kind> {
    const sequence = (this.#kindCounters.get(kind) ?? 0) + 1;
    this.#kindCounters.set(kind, sequence);
    return `${this.#namespace}:${kind}:${sequence.toString().padStart(4, "0")}` as Id<Kind>;
  }

  nextTurnIdempotencyKey(): TurnIdempotencyKey {
    this.#idempotencyCounter += 1;
    return `${this.#namespace}:turn-idempotency:${this.#idempotencyCounter
      .toString()
      .padStart(4, "0")}` as TurnIdempotencyKey;
  }

  nextOriginMessageId(): OriginMessageId {
    this.#originCounter += 1;
    return `${this.#namespace}:origin-message:${this.#originCounter
      .toString()
      .padStart(4, "0")}` as OriginMessageId;
  }
}

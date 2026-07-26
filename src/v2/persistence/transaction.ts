import type { DatabaseSync } from "node:sqlite";

import {
  AsyncTransactionWorkError,
  NestedTransactionError,
  TransactionConnectionPoisonedError,
  TransactionBoundaryFaultError,
  TransactionRollbackFailedError,
  type TransactionBoundary,
} from "./errors.js";

export interface TransactionFaultInjector {
  hit(boundary: TransactionBoundary): void;
}

/** A deterministic one-shot boundary fault source intended for tests. */
export class DeterministicTransactionFaults implements TransactionFaultInjector {
  #pending = new Map<TransactionBoundary, number>();

  failNext(boundary: TransactionBoundary): void {
    this.#pending.set(boundary, (this.#pending.get(boundary) ?? 0) + 1);
  }

  hit(boundary: TransactionBoundary): void {
    const count = this.#pending.get(boundary) ?? 0;
    if (count === 0) return;
    if (count === 1) this.#pending.delete(boundary);
    else this.#pending.set(boundary, count - 1);
    throw new TransactionBoundaryFaultError(boundary);
  }
}

export class ExplicitTransactionRunner {
  #active = false;
  #poisoned: TransactionRollbackFailedError | undefined;
  readonly #database: DatabaseSync;
  readonly #faults: TransactionFaultInjector | undefined;
  readonly #beforeCommit: (() => void) | undefined;

  constructor(database: DatabaseSync, faults?: TransactionFaultInjector, beforeCommit?: () => void) {
    this.#database = database;
    this.#faults = faults;
    this.#beforeCommit = beforeCommit;
  }

  get isActive(): boolean { return this.#active; }

  get isPoisoned(): boolean { return this.#poisoned !== undefined; }

  assertUsable(): void {
    if (this.#poisoned !== undefined) {
      throw new TransactionConnectionPoisonedError(
        "v2 SQLite connection is indeterminate after a failed rollback; close it before opening a new connection",
        { cause: this.#poisoned },
      );
    }
  }

  run<Result>(work: () => Result extends PromiseLike<unknown> ? never : Result): Result {
    this.assertUsable();
    if (this.#active) throw new NestedTransactionError();
    this.#faults?.hit("before-begin");
    this.#database.exec("BEGIN IMMEDIATE");
    this.#active = true;
    let committed = false;
    try {
      this.#faults?.hit("after-begin");
      const result = work();
      if (
        (typeof result === "object" || typeof result === "function") &&
        result !== null &&
        typeof (result as unknown as { then?: unknown }).then === "function"
      ) {
        throw new AsyncTransactionWorkError();
      }
      this.#beforeCommit?.();
      this.#faults?.hit("before-commit");
      this.#database.exec("COMMIT");
      committed = true;
      this.#faults?.hit("after-commit");
      return result;
    } catch (error) {
      if (!committed) {
        const observationFailures: unknown[] = [];
        try {
          this.#faults?.hit("before-rollback");
        } catch (failure) {
          observationFailures.push(failure);
        }
        let rollbackFailure: unknown;
        try {
          this.#database.exec("ROLLBACK");
        } catch (failure) {
          rollbackFailure = failure;
        }
        try {
          this.#faults?.hit("after-rollback");
        } catch (failure) {
          observationFailures.push(failure);
        }
        if (rollbackFailure !== undefined) {
          const combined = new AggregateError(
            [error, rollbackFailure, ...observationFailures],
            "transaction work and rollback failed",
          );
          const poisoned = new TransactionRollbackFailedError(
            "v2 SQLite rollback failed; the connection is indeterminate and must not be reused",
            { cause: combined },
          );
          this.#poisoned = poisoned;
          throw poisoned;
        }
        if (observationFailures.length > 0) {
          throw new AggregateError([error, ...observationFailures], "transaction work and rollback observation failed");
        }
      }
      throw error;
    } finally {
      this.#active = false;
    }
  }
}

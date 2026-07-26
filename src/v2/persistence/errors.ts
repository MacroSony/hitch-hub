/** Typed failures from the deliberately small v2 persistence foundation. */
export class V2PersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The configured root or one of its required direct children is unsafe. */
export class V2DataRootError extends V2PersistenceError {}

/** The root is not an installation created by this v2 foundation. */
export class V2InstallationMarkerError extends V2DataRootError {}

/** The root contains state this slice does not understand and will not mutate. */
export class V2UnknownDataRootContentsError extends V2DataRootError {}

/** A database boundary was deliberately faulted by a deterministic test hook. */
export class TransactionBoundaryFaultError extends V2PersistenceError {
  readonly boundary: TransactionBoundary;

  constructor(boundary: TransactionBoundary) {
    super(`deterministic transaction fault injected at ${boundary}`);
    this.boundary = boundary;
  }
}

/** A caller tried to enter a transaction while the connection is already active. */
export class NestedTransactionError extends V2PersistenceError {
  constructor() {
    super("nested SQLite transactions are forbidden by the v2 persistence boundary");
  }
}

/** Transaction callbacks must complete synchronously on this synchronous SQLite connection. */
export class AsyncTransactionWorkError extends V2PersistenceError {
  constructor() {
    super("v2 SQLite transaction callbacks must not return a Promise or thenable");
  }
}

/** Closing a connection while its explicit transaction is live would strand its boundary. */
export class ActiveTransactionCloseError extends V2PersistenceError {
  constructor() {
    super("v2 SQLite database cannot close while an explicit transaction is active");
  }
}

/**
 * SQLite rejected an actual ROLLBACK. The connection may still have an open
 * transaction, so it must be discarded rather than reused.
 */
export class TransactionRollbackFailedError extends V2PersistenceError {}

/** A previous rollback failure made the SQLite connection unsafe to reuse. */
export class TransactionConnectionPoisonedError extends V2PersistenceError {}

/** Generic SQL helpers may not bypass transaction ownership or required pragmas. */
export class UnsafeSqlStatementError extends V2PersistenceError {}

export type TransactionBoundary =
  | "before-begin"
  | "after-begin"
  | "before-commit"
  | "after-commit"
  | "before-rollback"
  | "after-rollback";

import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementResultingChanges,
} from "node:sqlite";
import {
  constants as filesystemConstants,
  copyFileSync,
  existsSync,
} from "node:fs";

import {
  ActiveTransactionCloseError,
  AsyncTransactionWorkError,
  UnsafeSqlStatementError,
  V2DataRootError,
} from "./errors.js";
import {
  createNewV2DatabaseFile,
  createV2DatabaseInspectionSnapshot,
  prepareV2DataRoot,
  inspectExistingV2DataRoot,
  removeV2DatabaseInspectionSnapshot,
  revalidateV2DataRoot,
  type PreparedV2DataRoot,
} from "./root.js";
import { ExplicitTransactionRunner, type TransactionFaultInjector } from "./transaction.js";

export interface OpenV2DatabaseOptions {
  readonly dataRoot: string;
  readonly transactionFaults?: TransactionFaultInjector;
  /**
   * V2-003B supplies this for a previously initialized database. It runs after
   * inspecting an isolated snapshot but before any persistent SQLite
   * pragma/WAL change, and must reject unknown state without mutation.
   */
  readonly validateExistingDatabase?: (validation: ExistingV2DatabaseValidation) => void;
}

export interface ExistingV2DatabaseInspection {
  readonly applicationId: number;
  readonly userVersion: number;
  readonly schemaObjects: readonly SQLiteSchemaObject[];
}

export interface SQLiteSchemaObject {
  readonly type: "index" | "table" | "trigger" | "view";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

/** Read-only capability that exists only while existing schema is being accepted. */
export interface ExistingV2DatabaseValidation extends ExistingV2DatabaseInspection {
  queryRows(sql: string): readonly Readonly<Record<string, unknown>>[];
}

/** Narrow initialization capability reserved for the V2-003B schema owner. */
export interface V2SchemaInitializer {
  executeSchemaStatement(sql: string): void;
  queryRows(sql: string): readonly Readonly<Record<string, unknown>>[];
  stampSchemaIdentity(applicationId: number, userVersion: number): void;
}

export type SQLiteBindValue = SQLInputValue;
export type SQLiteBindParameters = readonly SQLiteBindValue[] | Readonly<Record<string, SQLiteBindValue>>;
export type SQLiteRow = Readonly<Record<string, SQLOutputValue>>;
export type SQLiteRunResult = Readonly<Pick<StatementResultingChanges, "changes" | "lastInsertRowid">>;

/** A transaction-scoped, bound-parameter-only repository capability. */
export interface V2RepositoryTransaction {
  get(sql: string, parameters?: SQLiteBindParameters): SQLiteRow | undefined;
  all(sql: string, parameters?: SQLiteBindParameters): readonly SQLiteRow[];
  run(sql: string, parameters?: SQLiteBindParameters): SQLiteRunResult;
}

export class V2Database {
  readonly root: PreparedV2DataRoot;
  readonly #database: DatabaseSync;
  readonly #transactions: ExplicitTransactionRunner;
  #closed = false;
  #schemaInitializationActive = false;

  private constructor(root: PreparedV2DataRoot, database: DatabaseSync, faults?: TransactionFaultInjector) {
    this.root = root;
    this.#database = database;
    this.#transactions = new ExplicitTransactionRunner(database, faults, () => revalidateV2DataRoot(this.root));
  }

  static open(options: OpenV2DatabaseOptions): V2Database {
    const root = prepareV2DataRoot(options.dataRoot);
    let database: DatabaseSync | undefined;
    try {
      const inspectedRoot = root.databaseExisted
        ? inspectExistingDatabaseSnapshot(root, options.validateExistingDatabase)
        : createAndInspectNewDatabaseFile(root);
      database = new DatabaseSync(root.databasePath, {
        allowExtension: false,
        allowBareNamedParameters: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: 5000,
      });
      const openedRoot = inspectExistingV2DataRoot(root.path);
      assertSameRootIdentity(inspectedRoot, openedRoot, true);
      if (!root.databaseExisted) assertUninitializedDatabase(inspectExistingDatabase(database));
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = WAL");
      assertRequiredConnectionConfiguration(database);
      const configuredRoot = inspectExistingV2DataRoot(root.path);
      assertSameRootIdentity(openedRoot, configuredRoot, true);
      return new V2Database({
        ...configuredRoot,
        newlyCreated: root.newlyCreated,
        databaseExisted: root.databaseExisted,
      }, database, options.transactionFaults);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the setup failure; a best-effort close is all that is safe here.
      }
      throw new V2DataRootError("unable to open and configure v2 SQLite database", { cause: error });
    }
  }

  get isClosed(): boolean { return this.#closed; }

  transaction<Result>(work: (transaction: V2RepositoryTransaction) => Result extends PromiseLike<unknown> ? never : Result): Result {
    this.#assertUsable();
    return this.#transactions.run(() => {
      let capabilityLive = true;
      const requireLive = (): void => {
        if (!capabilityLive) throw new V2DataRootError("repository transaction capability has expired");
        this.#transactions.assertUsable();
        revalidateV2DataRoot(this.root);
      };
      const transaction: V2RepositoryTransaction = Object.freeze({
        get: (sql: string, parameters: SQLiteBindParameters = []) => {
          requireLive();
          assertPermittedQuery(sql);
          return getBoundRow(this.#database, sql, parameters);
        },
        all: (sql: string, parameters: SQLiteBindParameters = []) => {
          requireLive();
          assertPermittedQuery(sql);
          return allBoundRows(this.#database, sql, parameters);
        },
        run: (sql: string, parameters: SQLiteBindParameters = []) => {
          requireLive();
          assertRepositoryDataModification(sql);
          return runBoundStatement(this.#database, sql, parameters);
        },
      });
      try {
        return work(transaction);
      } finally {
        capabilityLive = false;
      }
    });
  }

  /**
   * Internal schema-owner seam. It is available only while this database has
   * no user schema and zero identity stamps, and holds one explicit immediate
   * transaction for all DDL plus the final identity stamp.
   */
  initializePristineSchema(work: (initializer: V2SchemaInitializer) => void): void {
    this.#assertUsable();
    this.#transactions.run(() => {
      assertUninitializedDatabase(inspectExistingDatabase(this.#database));
      this.#schemaInitializationActive = true;
      let capabilityLive = true;
      let stamped = false;
      let stampedApplicationId: number | undefined;
      let stampedUserVersion: number | undefined;
      const assertCapabilityLive = (): void => {
        if (!capabilityLive) {
          throw new V2DataRootError("schema initialization capability has expired");
        }
        this.#transactions.assertUsable();
        revalidateV2DataRoot(this.root);
      };
      const initializer: V2SchemaInitializer = {
        executeSchemaStatement: (sql) => {
          assertCapabilityLive();
          if (stamped) {
            throw new V2DataRootError("schema statements must be complete before its identity is stamped");
          }
          assertPermittedTrustedSql(sql);
          this.#database.exec(sql);
        },
        queryRows: (sql) => {
          assertCapabilityLive();
          return queryReadOnlyRows(this.#database, sql);
        },
        stampSchemaIdentity: (applicationId, userVersion) => {
          assertCapabilityLive();
          if (stamped) throw new V2DataRootError("schema identity may be stamped exactly once");
          assertSchemaIdentity(applicationId, "application_id");
          assertSchemaIdentity(userVersion, "user_version");
          this.#database.exec(`PRAGMA application_id = ${applicationId}`);
          this.#database.exec(`PRAGMA user_version = ${userVersion}`);
          stamped = true;
          stampedApplicationId = applicationId;
          stampedUserVersion = userVersion;
        },
      };
      try {
        const result = work(initializer);
        if (isThenable(result)) throw new AsyncTransactionWorkError();
        if (!stamped || stampedApplicationId === undefined || stampedUserVersion === undefined) {
          throw new V2DataRootError("a pristine schema initialization must stamp application_id and user_version");
        }
        const finalInspection = inspectExistingDatabase(this.#database);
        if (
          finalInspection.applicationId !== stampedApplicationId ||
          finalInspection.userVersion !== stampedUserVersion ||
          finalInspection.schemaObjects.length === 0
        ) {
          throw new V2DataRootError("schema initialization did not produce a nonempty schema with its exact identity stamps");
        }
      } finally {
        capabilityLive = false;
        this.#schemaInitializationActive = false;
      }
    });
  }

  /**
   * Safe to call repeatedly; no schema or root cleanup is implied. A poisoned
   * connection may only be closed (not queried, executed, or transacted).
   */
  close(): void {
    if (this.#closed) return;
    if (this.#schemaInitializationActive) {
      throw new V2DataRootError("v2 SQLite database cannot be re-entered during schema initialization");
    }
    if (this.#transactions.isActive) throw new ActiveTransactionCloseError();
    this.#database.close();
    this.#closed = true;
  }

  #assertUsable(): void {
    if (this.#closed) throw new V2DataRootError("v2 SQLite database is closed");
    if (this.#schemaInitializationActive) {
      throw new V2DataRootError("v2 SQLite database cannot be re-entered during schema initialization");
    }
    this.#transactions.assertUsable();
    revalidateV2DataRoot(this.root);
  }
}

function inspectExistingDatabaseSnapshot(
  root: PreparedV2DataRoot,
  validate: OpenV2DatabaseOptions["validateExistingDatabase"],
): PreparedV2DataRoot {
  // Even a read-only SQLite connection may create or rewrite the WAL shared
  // memory file while opening an unknown database. Inspect a managed private
  // snapshot so rejection cannot mutate the installation's DB/WAL/SHM bytes
  // and startup can recover an inspection interrupted by process death.
  const snapshot = createV2DatabaseInspectionSnapshot(root);

  let database: DatabaseSync | undefined;
  let inspectionFailure: unknown;
  try {
    copyPrivateSnapshotFile(root.databasePath, snapshot.databasePath);
    for (const suffix of ["-wal", "-journal"] as const) {
      const source = `${root.databasePath}${suffix}`;
      if (existsSync(source)) {
        copyPrivateSnapshotFile(source, `${snapshot.databasePath}${suffix}`);
      }
    }
    database = new DatabaseSync(snapshot.databasePath, {
      allowExtension: false,
      allowBareNamedParameters: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: false,
      timeout: 5000,
    });
    const inspection = inspectExistingDatabase(database);
    if (validate === undefined) assertUninitializedDatabase(inspection);
    else validateExistingDatabase(database, inspection, validate);
  } catch (error) {
    inspectionFailure = error;
  } finally {
    try {
      database?.close();
    } catch (error) {
      inspectionFailure =
        inspectionFailure === undefined
          ? error
          : new AggregateError(
              [inspectionFailure, error],
              "v2 database inspection and snapshot close both failed",
            );
    }
    try {
      removeV2DatabaseInspectionSnapshot(root, snapshot);
    } catch (error) {
      inspectionFailure =
        inspectionFailure === undefined
          ? error
          : new AggregateError(
              [inspectionFailure, error],
              "v2 database inspection and snapshot cleanup both failed",
            );
    }
  }
  if (inspectionFailure !== undefined) throw inspectionFailure;
  const inspectedRoot = inspectExistingV2DataRoot(root.path);
  assertSameRootIdentity(root, inspectedRoot, true);
  return inspectedRoot;
}

function copyPrivateSnapshotFile(source: string, destination: string): void {
  copyFileSync(source, destination, filesystemConstants.COPYFILE_EXCL);
}

function createAndInspectNewDatabaseFile(root: PreparedV2DataRoot): PreparedV2DataRoot {
  createNewV2DatabaseFile(root.databasePath);
  const inspectedRoot = inspectExistingV2DataRoot(root.path);
  assertSameRootIdentity(root, inspectedRoot, false);
  return inspectedRoot;
}

function assertRequiredConnectionConfiguration(database: DatabaseSync): void {
  if (pragmaNumber(database, "foreign_keys") !== 1) {
    throw new V2DataRootError("SQLite foreign_keys must be enabled");
  }
  if (pragmaNumber(database, "busy_timeout") !== 5000) {
    throw new V2DataRootError("SQLite busy_timeout must be 5000 milliseconds");
  }
  const journalMode = pragmaText(database, "journal_mode");
  if (journalMode.toLowerCase() !== "wal") {
    throw new V2DataRootError("SQLite journal_mode must be WAL");
  }
}

function getBoundRow(database: DatabaseSync, sql: string, parameters: SQLiteBindParameters): SQLiteRow | undefined {
  const statement = database.prepare(sql);
  const row = Array.isArray(parameters)
    ? statement.get(...parameters)
    : statement.get(parameters as Record<string, SQLiteBindValue>);
  return row === undefined ? undefined : freezeRow(row);
}

function allBoundRows(database: DatabaseSync, sql: string, parameters: SQLiteBindParameters): readonly SQLiteRow[] {
  const statement = database.prepare(sql);
  const rows = Array.isArray(parameters)
    ? statement.all(...parameters)
    : statement.all(parameters as Record<string, SQLiteBindValue>);
  return Object.freeze(rows.map(freezeRow));
}

function runBoundStatement(database: DatabaseSync, sql: string, parameters: SQLiteBindParameters): SQLiteRunResult {
  const statement = database.prepare(sql);
  const result = Array.isArray(parameters)
    ? statement.run(...parameters)
    : statement.run(parameters as Record<string, SQLiteBindValue>);
  return Object.freeze({ changes: result.changes, lastInsertRowid: result.lastInsertRowid });
}

function freezeRow(row: Record<string, SQLOutputValue>): SQLiteRow {
  return Object.freeze({ ...row });
}

function inspectExistingDatabase(database: DatabaseSync): ExistingV2DatabaseInspection {
  const applicationId = pragmaNumber(database, "application_id");
  const userVersion = pragmaNumber(database, "user_version");
  const rows = database.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all() as readonly Record<string, unknown>[];
  const schemaObjects = Object.freeze(rows.map((row) => {
    const type = row.type;
    const name = row.name;
    const tableName = row.tbl_name;
    const sql = row.sql;
    if (
      (type !== "index" && type !== "table" && type !== "trigger" && type !== "view") ||
      typeof name !== "string" ||
      typeof tableName !== "string" ||
      typeof sql !== "string"
    ) {
      throw new V2DataRootError("SQLite schema inspection returned an invalid row");
    }
    return Object.freeze({ type, name, tableName, sql });
  }));
  return Object.freeze({ applicationId, userVersion, schemaObjects });
}

function validateExistingDatabase(
  database: DatabaseSync,
  inspection: ExistingV2DatabaseInspection,
  validate: (validation: ExistingV2DatabaseValidation) => void,
): void {
  let capabilityLive = true;
  const validation: ExistingV2DatabaseValidation = Object.freeze({
    ...inspection,
    queryRows: (sql: string) => {
      if (!capabilityLive) throw new V2DataRootError("existing-schema validation capability has expired");
      return queryReadOnlyRows(database, sql);
    },
  });
  try {
    const result = validate(validation);
    if (isThenable(result)) {
      throw new V2DataRootError("existing-schema validation must complete synchronously");
    }
  } finally {
    capabilityLive = false;
  }
}

function queryReadOnlyRows(database: DatabaseSync, sql: string): readonly Readonly<Record<string, unknown>>[] {
  assertPermittedQuery(sql);
  const rows = database.prepare(sql).all() as readonly Record<string, unknown>[];
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function assertSameRootIdentity(
  expected: PreparedV2DataRoot,
  actual: PreparedV2DataRoot,
  compareDatabase: boolean,
): void {
  if (
    actual.parentDevice !== expected.parentDevice ||
    actual.parentInode !== expected.parentInode ||
    actual.rootDevice !== expected.rootDevice ||
    actual.rootInode !== expected.rootInode ||
    (compareDatabase && (
      actual.databaseDevice !== expected.databaseDevice ||
      actual.databaseInode !== expected.databaseInode
    ))
  ) {
    throw new V2DataRootError("v2 data root, parent, or SQLite database changed while opening");
  }
}

function pragmaNumber(
  database: DatabaseSync,
  name: "application_id" | "user_version" | "foreign_keys" | "busy_timeout",
): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new V2DataRootError(`SQLite ${name} is not a non-negative safe integer`);
  }
  return value;
}

function pragmaText(database: DatabaseSync, name: "journal_mode"): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "string") throw new V2DataRootError(`SQLite ${name} is not text`);
  return value;
}

function assertUninitializedDatabase(inspection: ExistingV2DatabaseInspection): void {
  if (inspection.applicationId !== 0 || inspection.userVersion !== 0 || inspection.schemaObjects.length !== 0) {
    throw new V2DataRootError("existing v2 SQLite database is not the exact uninitialized foundation state");
  }
}

function assertSchemaIdentity(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fff_ffff) {
    throw new V2DataRootError(`${name} must be a positive signed 32-bit integer`);
  }
}

function assertPermittedTrustedSql(sql: string): InspectedStatement {
  const statement = inspectSingleStatement(sql);
  const rootKeyword = rootStatementKeyword(statement);
  if (rootKeyword !== undefined && UNSAFE_EXECUTE_ROOT_KEYWORDS.has(rootKeyword)) {
    throw new UnsafeSqlStatementError("trusted SQL must not change pragmas, transaction boundaries, or attached databases");
  }
  return statement;
}

function assertRepositoryDataModification(sql: string): void {
  const statement = assertPermittedTrustedSql(sql);
  const rootKeyword = rootStatementKeyword(statement);
  if (rootKeyword === undefined || !REPOSITORY_DML_ROOT_KEYWORDS.has(rootKeyword)) {
    throw new UnsafeSqlStatementError("repository run accepts only one INSERT, UPDATE, DELETE, or REPLACE statement");
  }
}

function assertPermittedQuery(sql: string): void {
  const statement = inspectSingleStatement(sql);
  if (statement.keywords[0] === "PRAGMA") {
    if (
      statement.keywords.length === 2 &&
      statement.nonWordTokens.length === 0 &&
      READ_ONLY_PRAGMA_NAMES.has(statement.keywords[1] ?? "")
    ) {
      return;
    }
    throw new UnsafeSqlStatementError("queryValue permits only exact read-only v2 SQLite pragmas");
  }
  if (statement.keywords[0] === "SELECT") {
    return;
  }
  throw new UnsafeSqlStatementError("queryValue accepts only one SELECT statement or an exact read-only v2 SQLite PRAGMA");
}

const UNSAFE_EXECUTE_ROOT_KEYWORDS = new Set([
  "PRAGMA", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "END", "ATTACH", "DETACH", "VACUUM",
]);
const REPOSITORY_DML_ROOT_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);
const READ_ONLY_PRAGMA_NAMES = new Set(["FOREIGN_KEYS", "BUSY_TIMEOUT", "JOURNAL_MODE", "APPLICATION_ID", "USER_VERSION"]);

interface InspectedStatement {
  readonly firstKeyword: string | undefined;
  readonly keywords: readonly string[];
  readonly nonWordTokens: readonly string[];
}

function rootStatementKeyword(statement: InspectedStatement): string | undefined {
  if (statement.keywords[0] !== "EXPLAIN") return statement.firstKeyword;
  if (statement.keywords[1] === "QUERY" && statement.keywords[2] === "PLAN") {
    return statement.keywords[3];
  }
  return statement.keywords[1];
}

/** Parses only enough SQLite lexical structure to enforce this small helper API. */
function inspectSingleStatement(sql: string): InspectedStatement {
  const keywords: string[] = [];
  const nonWordTokens: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === undefined) break;
    if (/\s/u.test(character)) { index += 1; continue; }
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new UnsafeSqlStatementError("trusted SQL has an unterminated block comment");
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      nonWordTokens.push(character);
      const terminator = character === "[" ? "]" : character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === terminator) {
          if (terminator !== "]" && sql[index + 1] === terminator) { index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new UnsafeSqlStatementError("trusted SQL has an unterminated quoted value");
      continue;
    }
    if (character === ";") {
      throw new UnsafeSqlStatementError("SQL helpers accept exactly one statement without a semicolon");
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/u.test(sql[index] ?? "")) index += 1;
      keywords.push(sql.slice(start, index).toUpperCase());
      continue;
    }
    nonWordTokens.push(character);
    index += 1;
  }
  if (keywords.length === 0) throw new UnsafeSqlStatementError("SQL helpers require one non-empty statement");
  return { firstKeyword: keywords[0], keywords, nonWordTokens };
}

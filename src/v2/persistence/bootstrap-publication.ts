import type {
  BootstrapPublicationRecords,
  BootstrapPublicationUnitOfWork,
  Clock,
  IdSource,
} from "../model/application.js";
import {
  decodeJsonValue,
  digestCanonicalJson,
  encodeCanonicalJson,
} from "../codecs/json.js";
import type { JsonObject, JsonValue } from "../model/primitives.js";
import { insertAuditEnvelope } from "./audit-repository.js";
import type {
  SQLiteBindValue,
  SQLiteRow,
  V2Database,
  V2RepositoryTransaction,
} from "./database.js";
import {
  BOOTSTRAP_FOUNDATION_TABLES,
  BOOTSTRAP_FOUNDATION_PRIMARY_KEYS,
  projectBootstrapFoundationRows,
  type BootstrapFoundationRow,
  type BootstrapFoundationRowProjection,
  type BootstrapFoundationTable,
} from "./foundation-rows.js";

export interface SQLiteBootstrapPublicationOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
}

export class BootstrapPublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapPublicationConflictError";
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new BootstrapPublicationConflictError(
      "bootstrap row plan contains an unsafe SQL identifier",
    );
  }
  return `"${identifier}"`;
}

function sqliteValueEquals(
  actual: SQLiteRow[string],
  expected: SQLiteBindValue,
): boolean {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return (
      actual.byteLength === expected.byteLength &&
      actual.every((value, index) => value === expected[index])
    );
  }
  return Object.is(actual, expected);
}

function primaryKeyValues(
  row: BootstrapFoundationRow,
): readonly SQLiteBindValue[] {
  return row.primaryKey.map((column) => {
    const index = row.columns.indexOf(column);
    if (index < 0) {
      throw new BootstrapPublicationConflictError(
        `bootstrap row for ${row.table} lost a primary-key column`,
      );
    }
    return row.values[index]!;
  });
}

function sqliteJsonValue(
  value: SQLiteRow[string] | SQLiteBindValue,
  label: string,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new BootstrapPublicationConflictError(
        `${label} contains a non-finite number`,
      );
    }
    return value;
  }
  throw new BootstrapPublicationConflictError(
    `${label} contains a non-JSON SQLite value`,
  );
}

function ledgerPrimaryKey(row: BootstrapFoundationRow): string {
  return encodeCanonicalJson(
    primaryKeyValues(row).map((value) =>
      sqliteJsonValue(value, `${row.table} primary key`),
    ),
  );
}

function persistedRowDigest(
  table: BootstrapFoundationTable,
  persisted: SQLiteRow,
): string {
  const values: Record<string, JsonValue> = {};
  for (const [column, value] of Object.entries(persisted)) {
    values[column] = sqliteJsonValue(
      value,
      `${table}.${column}`,
    );
  }
  return digestCanonicalJson([
    table,
    values as JsonObject,
  ]);
}

function readPersistedRow(
  transaction: V2RepositoryTransaction,
  row: BootstrapFoundationRow,
): SQLiteRow | undefined {
  const where = row.primaryKey
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(" AND ");
  return transaction.get(
    `SELECT * FROM ${quoteIdentifier(row.table)} WHERE ${where}`,
    primaryKeyValues(row),
  );
}

function readLedgerDigest(
  transaction: V2RepositoryTransaction,
  row: BootstrapFoundationRow,
): string | undefined {
  const ledger = transaction.get(
    `SELECT row_digest
      FROM bootstrap_publication_rows
      WHERE table_name = ? AND primary_key_json = ?`,
    [row.table, ledgerPrimaryKey(row)],
  );
  if (ledger === undefined) return undefined;
  if (typeof ledger.row_digest !== "string") {
    throw new BootstrapPublicationConflictError(
      "bootstrap publication ledger contains an invalid digest",
    );
  }
  return ledger.row_digest;
}

const BOOTSTRAP_FOUNDATION_TABLE_SET =
  new Set<string>(BOOTSTRAP_FOUNDATION_TABLES);

function decodeLedgerPrimaryKey(
  table: BootstrapFoundationTable,
  encoded: string,
): readonly SQLiteBindValue[] {
  let decoded: JsonValue;
  try {
    decoded = decodeJsonValue(JSON.parse(encoded) as unknown);
  } catch {
    throw new BootstrapPublicationConflictError(
      "bootstrap publication ledger contains an invalid primary key",
    );
  }
  const expectedColumns = BOOTSTRAP_FOUNDATION_PRIMARY_KEYS[table];
  if (
    !Array.isArray(decoded) ||
    decoded.length !== expectedColumns.length
  ) {
    throw new BootstrapPublicationConflictError(
      `bootstrap publication ledger has an invalid ${table} primary key`,
    );
  }
  const values = decoded.map((value) => {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number"
    ) {
      throw new BootstrapPublicationConflictError(
        `bootstrap publication ledger has an invalid ${table} primary-key value`,
      );
    }
    return value;
  });
  if (encodeCanonicalJson(values) !== encoded) {
    throw new BootstrapPublicationConflictError(
      "bootstrap publication ledger primary keys must be canonical JSON",
    );
  }
  return values;
}

function assertAllLedgerRowsIntact(
  transaction: V2RepositoryTransaction,
): void {
  const entries = transaction.all(
    `SELECT table_name, primary_key_json, row_digest
      FROM bootstrap_publication_rows`,
  );
  for (const entry of entries) {
    const tableName = entry.table_name;
    const primaryKeyJson = entry.primary_key_json;
    const digest = entry.row_digest;
    if (
      typeof tableName !== "string" ||
      !BOOTSTRAP_FOUNDATION_TABLE_SET.has(tableName) ||
      typeof primaryKeyJson !== "string" ||
      typeof digest !== "string"
    ) {
      throw new BootstrapPublicationConflictError(
        "bootstrap publication ledger contains an invalid entry",
      );
    }
    const table = tableName as BootstrapFoundationTable;
    const primaryKey = decodeLedgerPrimaryKey(table, primaryKeyJson);
    const where = BOOTSTRAP_FOUNDATION_PRIMARY_KEYS[table]
      .map((column) => `${quoteIdentifier(column)} = ?`)
      .join(" AND ");
    const persisted = transaction.get(
      `SELECT * FROM ${quoteIdentifier(table)} WHERE ${where}`,
      primaryKey,
    );
    if (persisted === undefined) {
      throw new BootstrapPublicationConflictError(
        `previously published ${table} row is missing`,
      );
    }
    if (persistedRowDigest(table, persisted) !== digest) {
      throw new BootstrapPublicationConflictError(
        `previously published ${table} row has changed`,
      );
    }
  }
}

function persistedRowMatches(
  persisted: SQLiteRow,
  row: BootstrapFoundationRow,
): boolean {
  return row.columns.every((column, index) => {
    if (column === "created_at" || column === "updated_at") {
      return true;
    }
    const actual = persisted[column];
    return (
      actual !== undefined &&
      sqliteValueEquals(actual, row.values[index]!)
    );
  });
}

function tableCount(
  transaction: V2RepositoryTransaction,
  table: BootstrapFoundationTable,
): number {
  const result = transaction.get(
    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`,
  );
  if (
    result === undefined ||
    typeof result.count !== "number" ||
    !Number.isSafeInteger(result.count) ||
    result.count < 0
  ) {
    throw new BootstrapPublicationConflictError(
      `cannot determine durable row count for ${table}`,
    );
  }
  return result.count;
}

function foundationIsEmpty(
  transaction: V2RepositoryTransaction,
): boolean {
  return BOOTSTRAP_FOUNDATION_TABLES.every(
    (table) => tableCount(transaction, table) === 0,
  );
}

function rowValue(
  row: BootstrapFoundationRow,
  column: string,
): SQLiteBindValue {
  const index = row.columns.indexOf(column);
  if (index < 0) {
    throw new BootstrapPublicationConflictError(
      `${row.table} row is missing required ${column}`,
    );
  }
  return row.values[index]!;
}

function updateWorkspaceReference(
  transaction: V2RepositoryTransaction,
  persisted: SQLiteRow,
  row: BootstrapFoundationRow,
): void {
  for (const column of [
    "workspace_id",
    "installation_id",
    "binding_reference",
  ] as const) {
    const actual = persisted[column];
    if (
      actual === undefined ||
      !sqliteValueEquals(
        actual,
        rowValue(row, column),
      )
    ) {
      throw new BootstrapPublicationConflictError(
        "workspace reference binding identity differs from bootstrap",
      );
    }
  }
  const currentRevisionId = persisted.workspace_revision_id;
  const nextRevisionId = rowValue(row, "workspace_revision_id");
  const workspaceId = rowValue(row, "workspace_id");
  if (
    typeof currentRevisionId !== "string" ||
    typeof nextRevisionId !== "string" ||
    typeof workspaceId !== "string"
  ) {
    throw new BootstrapPublicationConflictError(
      "workspace reference binding has invalid revision identifiers",
    );
  }
  const current = transaction.get(
    "SELECT workspace_id, revision FROM workspace_revisions WHERE id = ?",
    [currentRevisionId],
  );
  const next = transaction.get(
    "SELECT workspace_id, revision FROM workspace_revisions WHERE id = ?",
    [nextRevisionId],
  );
  if (
    current === undefined ||
    next === undefined ||
    current.workspace_id !== workspaceId ||
    next.workspace_id !== workspaceId ||
    typeof current.revision !== "number" ||
    typeof next.revision !== "number" ||
    next.revision <= current.revision
  ) {
    throw new BootstrapPublicationConflictError(
      "workspace reference binding cannot move backward or sideways",
    );
  }
  const updated = transaction.run(
    `UPDATE workspace_reference_bindings
      SET workspace_revision_id = ?
      WHERE workspace_id = ? AND workspace_revision_id = ?`,
    [
      nextRevisionId,
      rowValue(row, "workspace_id"),
      currentRevisionId,
    ],
  );
  if (updated.changes !== 1) {
    throw new BootstrapPublicationConflictError(
      "workspace reference binding changed during bootstrap publication",
    );
  }
}

function insertRow(
  transaction: V2RepositoryTransaction,
  row: BootstrapFoundationRow,
): void {
  assertNextRevision(transaction, row);
  const columns = row.columns.map(quoteIdentifier).join(", ");
  const placeholders = row.columns.map(() => "?").join(", ");
  const result = transaction.run(
    `INSERT INTO ${quoteIdentifier(row.table)} (${columns}) VALUES (${placeholders})`,
    row.values,
  );
  if (result.changes !== 1) {
    throw new BootstrapPublicationConflictError(
      `bootstrap insert did not create exactly one ${row.table} row`,
    );
  }
}

const REVISION_PARENT_COLUMNS = Object.freeze({
  workspace_revisions: "workspace_id",
  execution_policy_snapshots: "policy_id",
  turn_policy_snapshots: "policy_id",
  agent_profile_revisions: "profile_id",
  extension_revisions: "extension_id",
} satisfies Partial<Record<BootstrapFoundationTable, string>>);

function revisionParentColumn(
  row: BootstrapFoundationRow,
): string | undefined {
  return REVISION_PARENT_COLUMNS[
    row.table as keyof typeof REVISION_PARENT_COLUMNS
  ];
}

function assertNextRevision(
  transaction: V2RepositoryTransaction,
  row: BootstrapFoundationRow,
): void {
  const parentColumn = revisionParentColumn(row);
  if (parentColumn === undefined) return;
  const parentId = rowValue(row, parentColumn);
  const revision = rowValue(row, "revision");
  if (typeof parentId !== "string" || typeof revision !== "number") {
    throw new BootstrapPublicationConflictError(
      `${row.table} has invalid revision identity`,
    );
  }
  const result = transaction.get(
    `SELECT MAX(revision) AS revision
      FROM ${quoteIdentifier(row.table)}
      WHERE ${quoteIdentifier(parentColumn)} = ?`,
    [parentId],
  );
  const current = result?.revision;
  if (
    current !== null &&
    (typeof current !== "number" || !Number.isSafeInteger(current))
  ) {
    throw new BootstrapPublicationConflictError(
      `cannot determine current ${row.table} revision`,
    );
  }
  const expected = (current ?? 0) + 1;
  if (revision !== expected) {
    throw new BootstrapPublicationConflictError(
      `${row.table} revision must append exactly ${expected}`,
    );
  }
}

function assertProjectedRevisionsAreLatest(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): void {
  for (const row of projection.rows) {
    const parentColumn = revisionParentColumn(row);
    if (parentColumn === undefined) continue;
    const parentId = rowValue(row, parentColumn);
    const projectedRevision = rowValue(row, "revision");
    if (
      typeof parentId !== "string" ||
      typeof projectedRevision !== "number"
    ) {
      throw new BootstrapPublicationConflictError(
        `${row.table} has invalid revision identity`,
      );
    }
    const result = transaction.get(
      `SELECT MAX(revision) AS revision
        FROM ${quoteIdentifier(row.table)}
        WHERE ${quoteIdentifier(parentColumn)} = ?`,
      [parentId],
    );
    if (result?.revision !== projectedRevision) {
      throw new BootstrapPublicationConflictError(
        `${row.table} bootstrap revision is not the durable latest revision`,
      );
    }
  }
}

function installationUpdatedAt(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): string {
  const installation = projection.rows.find(
    (row) => row.table === "installations",
  );
  if (installation === undefined) {
    throw new BootstrapPublicationConflictError(
      "bootstrap projection has no installation row",
    );
  }
  const persisted = transaction.get(
    "SELECT updated_at FROM installations WHERE id = ?",
    [rowValue(installation, "id")],
  );
  if (typeof persisted?.updated_at !== "string") {
    throw new BootstrapPublicationConflictError(
      "cannot read durable installation update time",
    );
  }
  return persisted.updated_at;
}

function assertAppendChronology(
  projection: BootstrapFoundationRowProjection,
  previousUpdatedAt: string,
  insertedRows: readonly BootstrapFoundationRow[],
): void {
  const installation = projection.rows.find(
    (row) => row.table === "installations",
  );
  const nextUpdatedAt =
    installation === undefined
      ? undefined
      : rowValue(installation, "updated_at");
  if (
    typeof nextUpdatedAt !== "string" ||
    nextUpdatedAt <= previousUpdatedAt
  ) {
    throw new BootstrapPublicationConflictError(
      "bootstrap append must advance installation update time",
    );
  }
  for (const row of insertedRows) {
    for (const column of ["created_at", "updated_at"] as const) {
      if (!row.columns.includes(column)) continue;
      const value = rowValue(row, column);
      if (typeof value !== "string" || value < previousUpdatedAt) {
        throw new BootstrapPublicationConflictError(
          `new ${row.table} row predates the durable bootstrap graph`,
        );
      }
    }
  }
}

function mergeProjection(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): boolean {
  const previousUpdatedAt = installationUpdatedAt(
    transaction,
    projection,
  );
  let changed = false;
  const insertedRows: BootstrapFoundationRow[] = [];
  for (const row of projection.rows) {
    const persisted = readPersistedRow(transaction, row);
    const ledgerDigest = readLedgerDigest(transaction, row);
    if (persisted === undefined) {
      if (ledgerDigest !== undefined) {
        throw new BootstrapPublicationConflictError(
          `previously published ${row.table} row is missing`,
        );
      }
      insertRow(transaction, row);
      insertedRows.push(row);
      changed = true;
      continue;
    }
    if (ledgerDigest === undefined) {
      throw new BootstrapPublicationConflictError(
        `existing ${row.table} row is absent from the publication ledger`,
      );
    }
    if (persistedRowDigest(row.table, persisted) !== ledgerDigest) {
      throw new BootstrapPublicationConflictError(
        `existing ${row.table} row differs from its publication ledger`,
      );
    }
    if (!persistedRowMatches(persisted, row)) {
      if (row.table !== "workspace_reference_bindings") {
        throw new BootstrapPublicationConflictError(
          `existing ${row.table} row differs from bootstrap publication`,
        );
      }
      updateWorkspaceReference(transaction, persisted, row);
      changed = true;
    }
  }
  assertExactActiveBootstrapAuthority(transaction, projection);
  assertProjectedRevisionsAreLatest(transaction, projection);
  if (changed) {
    assertAppendChronology(
      projection,
      previousUpdatedAt,
      insertedRows,
    );
    updateInstallationTimestamp(transaction, projection);
  }
  return changed;
}

function updateInstallationTimestamp(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): void {
  const installation = projection.rows.find(
    (row) => row.table === "installations",
  );
  if (installation === undefined) {
    throw new BootstrapPublicationConflictError(
      "bootstrap projection has no installation row",
    );
  }
  const result = transaction.run(
    "UPDATE installations SET updated_at = ? WHERE id = ?",
    [
      rowValue(installation, "updated_at"),
      rowValue(installation, "id"),
    ],
  );
  if (result.changes !== 1) {
    throw new BootstrapPublicationConflictError(
      "bootstrap publication could not update installation metadata",
    );
  }
}

function assertExactActiveBootstrapAuthority(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): void {
  const expectedActiveGrants = projection.rows.filter(
    (row) => row.table === "access_grants",
  ).length;
  const expectedActiveCredentials = projection.rows.filter(
    (row) => row.table === "provider_credential_bindings",
  ).length;
  const checks = [
    {
      sql: "SELECT COUNT(*) AS count FROM principals WHERE state = 'active'",
      expected: 1,
      label: "active bootstrap principal",
    },
    {
      sql: "SELECT COUNT(*) AS count FROM identity_bindings WHERE state = 'active'",
      expected: 1,
      label: "active bootstrap identity binding",
    },
    {
      sql: "SELECT COUNT(*) AS count FROM access_grants WHERE state = 'active'",
      expected: expectedActiveGrants,
      label: "active bootstrap access grants",
    },
    {
      sql: "SELECT COUNT(*) AS count FROM provider_credential_bindings WHERE state = 'active'",
      expected: expectedActiveCredentials,
      label: "active bootstrap credential bindings",
    },
  ] as const;
  for (const check of checks) {
    const result = transaction.get(check.sql);
    if (result?.count !== check.expected) {
      throw new BootstrapPublicationConflictError(
        `${check.label} differ from the exact publication graph`,
      );
    }
  }
}

function insertProjection(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): void {
  for (const row of projection.rows) insertRow(transaction, row);
  assertExactActiveBootstrapAuthority(transaction, projection);
  assertProjectedRevisionsAreLatest(transaction, projection);
}

function requiredCount(
  transaction: V2RepositoryTransaction,
  sql: string,
  parameters: readonly SQLiteBindValue[] = [],
): number {
  const result = transaction.get(sql, parameters);
  if (
    result === undefined ||
    typeof result.count !== "number" ||
    !Number.isSafeInteger(result.count) ||
    result.count < 0
  ) {
    throw new BootstrapPublicationConflictError(
      "cannot determine bootstrap publication metadata count",
    );
  }
  return result.count;
}

function assertEstablishedPublication(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
): void {
  const installation = projection.rows.find(
    (row) => row.table === "installations",
  );
  if (installation === undefined) {
    throw new BootstrapPublicationConflictError(
      "bootstrap projection has no installation row",
    );
  }
  const installationId = rowValue(installation, "id");
  if (typeof installationId !== "string") {
    throw new BootstrapPublicationConflictError(
      "bootstrap projection has an invalid installation identifier",
    );
  }
  const publicationAudits = requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM audit_envelopes
      WHERE installation_id = ?
        AND action = 'installation-published'
        AND outcome = 'succeeded'`,
    [installationId],
  );
  const ledgerCount = requiredCount(
    transaction,
    "SELECT COUNT(*) AS count FROM bootstrap_publication_rows",
  );
  const foundationCount = BOOTSTRAP_FOUNDATION_TABLES.reduce(
    (sum, table) => sum + tableCount(transaction, table),
    0,
  );
  if (
    publicationAudits < 1 ||
    ledgerCount < 1 ||
    ledgerCount !== foundationCount
  ) {
    throw new BootstrapPublicationConflictError(
      "durable bootstrap foundation has no complete publication baseline",
    );
  }
  assertAllLedgerRowsIntact(transaction);
}

function recordProjectionLedger(
  transaction: V2RepositoryTransaction,
  projection: BootstrapFoundationRowProjection,
  auditId: string,
): void {
  for (const row of projection.rows) {
    const persisted = readPersistedRow(transaction, row);
    if (persisted === undefined) {
      throw new BootstrapPublicationConflictError(
        `cannot ledger missing ${row.table} row`,
      );
    }
    const primaryKeyJson = ledgerPrimaryKey(row);
    const digest = persistedRowDigest(row.table, persisted);
    const existing = transaction.get(
      `SELECT first_published_audit_id
        FROM bootstrap_publication_rows
        WHERE table_name = ? AND primary_key_json = ?`,
      [row.table, primaryKeyJson],
    );
    if (existing === undefined) {
      const inserted = transaction.run(
        `INSERT INTO bootstrap_publication_rows (
          table_name, primary_key_json, row_digest,
          first_published_audit_id, last_published_audit_id
        ) VALUES (?, ?, ?, ?, ?)`,
        [row.table, primaryKeyJson, digest, auditId, auditId],
      );
      if (inserted.changes !== 1) {
        throw new BootstrapPublicationConflictError(
          "bootstrap publication ledger insert did not affect one row",
        );
      }
      continue;
    }
    if (typeof existing.first_published_audit_id !== "string") {
      throw new BootstrapPublicationConflictError(
        "bootstrap publication ledger contains invalid audit provenance",
      );
    }
    const updated = transaction.run(
      `UPDATE bootstrap_publication_rows
        SET row_digest = ?, last_published_audit_id = ?
        WHERE table_name = ? AND primary_key_json = ?`,
      [digest, auditId, row.table, primaryKeyJson],
    );
    if (updated.changes !== 1) {
      throw new BootstrapPublicationConflictError(
        "bootstrap publication ledger update did not affect one row",
      );
    }
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function requiredText(
  row: SQLiteRow | undefined,
  column: string,
  label: string,
): string {
  const value = row?.[column];
  if (typeof value !== "string") {
    throw new BootstrapPublicationConflictError(
      `cannot read durable ${label}`,
    );
  }
  return value;
}

function durableCore(
  transaction: V2RepositoryTransaction,
  records: BootstrapPublicationRecords,
) {
  const installation = transaction.get(
    "SELECT created_at, updated_at FROM installations WHERE id = ?",
    [records.installation.id],
  );
  const owner = transaction.get(
    "SELECT created_at FROM principals WHERE id = ?",
    [records.owner.id],
  );
  const identityBinding = transaction.get(
    "SELECT created_at FROM identity_bindings WHERE id = ?",
    [records.localIdentityBinding.id],
  );
  const endpoint = transaction.get(
    "SELECT created_at FROM endpoints WHERE id = ?",
    [records.localEndpoint.id],
  );
  const core = structuredClone({
    installation: records.installation,
    owner: records.owner,
    localIdentityBinding: records.localIdentityBinding,
    localEndpoint: records.localEndpoint,
  });
  (core.installation as unknown as Record<string, unknown>).createdAt =
    requiredText(installation, "created_at", "installation creation time");
  (core.installation as unknown as Record<string, unknown>).updatedAt =
    requiredText(installation, "updated_at", "installation update time");
  (core.owner as unknown as Record<string, unknown>).createdAt =
    requiredText(owner, "created_at", "owner creation time");
  (
    core.localIdentityBinding as unknown as Record<string, unknown>
  ).createdAt = requiredText(
    identityBinding,
    "created_at",
    "identity-binding creation time",
  );
  (core.localEndpoint as unknown as Record<string, unknown>).createdAt =
    requiredText(endpoint, "created_at", "endpoint creation time");
  return deepFreeze(core);
}

/**
 * Canonical SQLite implementation of the bootstrap publication unit of work.
 * It inserts the complete foundation and its audit envelope in one immediate
 * transaction. Exact retries return unchanged and append no duplicate audit.
 */
export class SQLiteBootstrapPublicationUnitOfWork
implements BootstrapPublicationUnitOfWork {
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;

  constructor(options: SQLiteBootstrapPublicationOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async publishBootstrap(
    records: BootstrapPublicationRecords,
  ): ReturnType<BootstrapPublicationUnitOfWork["publishBootstrap"]> {
    const projection = projectBootstrapFoundationRows(records);
    return this.#database.transaction((transaction) => {
      const installationCount = tableCount(transaction, "installations");
      if (installationCount > 0) {
        assertEstablishedPublication(transaction, projection);
        const changed = mergeProjection(transaction, projection);
        if (!changed) {
          const core = durableCore(transaction, records);
          return Object.freeze({
            status: "unchanged" as const,
            ...core,
            auditEvents: Object.freeze([] as const),
          });
        }
      } else if (!foundationIsEmpty(transaction)) {
        throw new BootstrapPublicationConflictError(
          "bootstrap foundation is partially populated without an installation",
        );
      } else {
        insertProjection(transaction, projection);
      }

      const audit = insertAuditEnvelope(transaction, {
        id: this.#ids.next("AuditEnvelope"),
        installationId: records.installation.id,
        actor: { kind: "bootstrap" },
        outcome: "succeeded",
        action: "installation-published",
        occurredAt: this.#clock.now(),
      });
      recordProjectionLedger(transaction, projection, audit.id);
      const core = durableCore(transaction, records);
      return Object.freeze({
        status: "published" as const,
        ...core,
        auditEvents: Object.freeze([
          deepFreeze(structuredClone(audit)),
        ] as const),
      });
    });
  }
}

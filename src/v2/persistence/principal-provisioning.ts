import {
  digestCanonicalJson,
  encodeCanonicalJson,
} from "../codecs/json.js";
import type {
  AuditEnvelopeId,
  InstallationId,
  JsonObject,
  JsonValue,
  PrincipalId,
} from "../model/primitives.js";
import type {
  SQLiteBindValue,
  SQLiteRow,
  V2RepositoryTransaction,
} from "./database.js";

const PRINCIPAL_PROVISIONING_SHAPES = Object.freeze({
  principals: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    immutableColumns: Object.freeze([
      "id",
      "installation_id",
      "kind",
      "display_name",
      "created_at",
    ]),
  }),
  principal_reference_bindings: Object.freeze({
    primaryKey: Object.freeze(["principal_id"]),
    immutableColumns: Object.freeze([
      "principal_id",
      "installation_id",
      "reference",
    ]),
  }),
  principal_execution_capacity: Object.freeze({
    primaryKey: Object.freeze(["principal_id"]),
    immutableColumns: Object.freeze(["principal_id"]),
  }),
  access_grants: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    immutableColumns: Object.freeze([
      "id",
      "kind",
      "installation_id",
      "principal_id",
      "role",
      "resource_kind",
      "resource_id",
      "granted_actor_kind",
      "granted_actor_principal_id",
      "granted_actor_system_component",
      "created_at",
    ]),
  }),
  workspaces: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    immutableColumns: Object.freeze([
      "id",
      "installation_id",
      "reference",
      "display_name",
      "created_at",
    ]),
  }),
  principal_workspace_bindings: Object.freeze({
    primaryKey: Object.freeze(["principal_id"]),
    immutableColumns: Object.freeze([
      "principal_id",
      "installation_id",
      "workspace_id",
      "created_actor_kind",
      "created_actor_principal_id",
      "created_actor_system_component",
      "created_at",
    ]),
  }),
  workspace_resources: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    immutableColumns: Object.freeze([
      "id",
      "installation_id",
      "canonical_host_path",
      "sandbox_path",
      "maximum_access",
      "created_at",
    ]),
  }),
  workspace_revisions: Object.freeze({
    primaryKey: Object.freeze(["id"]),
    immutableColumns: Object.freeze([
      "id",
      "workspace_id",
      "revision",
      "display_name",
      "created_at",
    ]),
  }),
  workspace_revision_resources: Object.freeze({
    primaryKey: Object.freeze([
      "workspace_revision_id",
      "workspace_resource_id",
    ]),
    immutableColumns: Object.freeze([
      "workspace_revision_id",
      "workspace_resource_id",
      "ordinal",
      "role",
    ]),
  }),
  workspace_reference_bindings: Object.freeze({
    primaryKey: Object.freeze(["workspace_id"]),
    immutableColumns: Object.freeze([
      "workspace_id",
      "workspace_revision_id",
      "installation_id",
      "binding_reference",
    ]),
  }),
  execution_policy_resource_grants: Object.freeze({
    primaryKey: Object.freeze([
      "execution_policy_snapshot_id",
      "workspace_resource_id",
    ]),
    immutableColumns: Object.freeze([
      "execution_policy_snapshot_id",
      "workspace_resource_id",
      "access",
    ]),
  }),
});

export type PrincipalProvisioningTable =
  keyof typeof PRINCIPAL_PROVISIONING_SHAPES;

export interface PrincipalProvisionedRowRef {
  readonly table: PrincipalProvisioningTable;
  readonly primaryKey: readonly SQLiteBindValue[];
}

export class PrincipalProvisioningIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalProvisioningIntegrityError";
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function jsonValue(value: SQLiteBindValue, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  throw new PrincipalProvisioningIntegrityError(
    `${label} cannot be represented in canonical provisioning provenance`,
  );
}

function canonicalPrimaryKey(
  table: PrincipalProvisioningTable,
  primaryKey: readonly SQLiteBindValue[],
): string {
  const shape = PRINCIPAL_PROVISIONING_SHAPES[table];
  if (primaryKey.length !== shape.primaryKey.length) {
    throw new PrincipalProvisioningIntegrityError(
      `${table} provisioning primary key has the wrong cardinality`,
    );
  }
  return encodeCanonicalJson(
    primaryKey.map((value, index) =>
      jsonValue(value, `${table}.${shape.primaryKey[index]}`),
    ),
  );
}

function readProvisionedRow(
  transaction: V2RepositoryTransaction,
  ref: PrincipalProvisionedRowRef,
): SQLiteRow {
  const shape = PRINCIPAL_PROVISIONING_SHAPES[ref.table];
  const where = shape.primaryKey
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(" AND ");
  const row = transaction.get(
    `SELECT ${shape.immutableColumns.map(quoteIdentifier).join(", ")}
    FROM ${quoteIdentifier(ref.table)} WHERE ${where}`,
    ref.primaryKey,
  );
  if (row === undefined) {
    throw new PrincipalProvisioningIntegrityError(
      `${ref.table} provisioning row is missing`,
    );
  }
  return row;
}

function rowDigest(
  table: PrincipalProvisioningTable,
  row: SQLiteRow,
): string {
  const values: Record<string, JsonValue> = {};
  for (const column of PRINCIPAL_PROVISIONING_SHAPES[table].immutableColumns) {
    if (!(column in row)) {
      throw new PrincipalProvisioningIntegrityError(
        `${table} provisioning row is missing ${column}`,
      );
    }
    values[column] = jsonValue(row[column] as SQLiteBindValue, `${table}.${column}`);
  }
  return digestCanonicalJson([table, values as JsonObject]);
}

export function recordPrincipalProvisionedRows(
  transaction: V2RepositoryTransaction,
  input: {
    readonly installationId: InstallationId;
    readonly principalId: PrincipalId;
    readonly createdAuditId: AuditEnvelopeId;
    readonly rows: readonly PrincipalProvisionedRowRef[];
  },
): void {
  for (const ref of input.rows) {
    const primaryKeyJson = canonicalPrimaryKey(ref.table, ref.primaryKey);
    const digest = rowDigest(ref.table, readProvisionedRow(transaction, ref));
    const inserted = transaction.run(
      `INSERT INTO principal_provisioning_rows (
        installation_id, principal_id, table_name, primary_key_json,
        row_digest, created_audit_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.installationId,
        input.principalId,
        ref.table,
        primaryKeyJson,
        digest,
        input.createdAuditId,
      ],
    );
    if (inserted.changes !== 1) {
      throw new PrincipalProvisioningIntegrityError(
        `${ref.table} provisioning ledger did not append exactly one row`,
      );
    }
  }
}

export function assertPrincipalProvisionedRow(
  transaction: V2RepositoryTransaction,
  input: {
    readonly installationId: InstallationId;
    readonly principalId: PrincipalId;
    readonly row: PrincipalProvisionedRowRef;
  },
): void {
  const primaryKeyJson = canonicalPrimaryKey(
    input.row.table,
    input.row.primaryKey,
  );
  const ledger = transaction.get(
    `SELECT provenance.row_digest
    FROM principal_provisioning_rows AS provenance
    JOIN audit_envelopes AS creation_audit
      ON creation_audit.id = provenance.created_audit_id
      AND creation_audit.installation_id = provenance.installation_id
      AND creation_audit.actor_kind = 'principal'
      AND creation_audit.outcome = 'succeeded'
      AND creation_audit.action = 'principal-created'
      AND creation_audit.subject_principal_id = provenance.principal_id
    WHERE provenance.installation_id = ?
      AND provenance.principal_id = ?
      AND provenance.table_name = ?
      AND provenance.primary_key_json = ?`,
    [
      input.installationId,
      input.principalId,
      input.row.table,
      primaryKeyJson,
    ],
  );
  if (ledger === undefined || typeof ledger.row_digest !== "string") {
    throw new PrincipalProvisioningIntegrityError(
      `${input.row.table} row has no exact principal provisioning provenance`,
    );
  }
  const actual = rowDigest(
    input.row.table,
    readProvisionedRow(transaction, input.row),
  );
  if (actual !== ledger.row_digest) {
    throw new PrincipalProvisioningIntegrityError(
      `${input.row.table} row differs from its principal provisioning provenance`,
    );
  }
}

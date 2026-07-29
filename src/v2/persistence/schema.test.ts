import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import { V2Database } from "./database.js";
import { V2DataRootError } from "./errors.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import { V2_DATABASE_FILENAME } from "./root.js";
import {
  HITCH_V2_SCHEMA_DIGEST,
  HITCH_V2_SCHEMA_MANIFEST,
  HITCH_V2_SERVICE_ALLOCATED_KIND_TABLES,
  HITCH_V2_SQLITE_APPLICATION_ID,
  HITCH_V2_SQLITE_USER_VERSION,
  digestHitchV2SchemaManifest,
} from "./schema.js";

const REQUIRED_DURABLE_TABLES = [
  "schema_metadata", "installations", "private_blobs", "principals", "local_hosts", "identity_bindings", "authentication_requests", "endpoints", "access_grants",
  "installation_reference_bindings", "principal_reference_bindings", "local_host_reference_bindings", "identity_binding_reference_bindings", "authentication_subject_reference_bindings", "endpoint_reference_bindings",
  "workspaces", "workspace_resources", "workspace_revisions", "workspace_revision_resources", "execution_policies", "tool_capabilities", "execution_policy_snapshots", "execution_policy_resource_grants", "execution_policy_tool_capabilities", "turn_policies", "turn_policy_snapshots",
  "providers", "models", "provider_credential_bindings", "provider_connections", "provider_connection_origins", "provider_model_manifests", "provider_model_image_mime_types", "provider_model_reasoning_efforts",
  "agent_drivers", "agent_driver_launch_profiles", "agent_driver_permission_mediations", "agent_profiles", "agent_profile_revisions", "agent_profile_provider_allowances", "agent_profile_allowance_models", "agent_resource_snapshots", "extensions", "extension_revisions", "extension_capabilities", "extension_grant_snapshots", "extension_grant_capabilities", "agent_profile_resource_snapshots", "agent_profile_extension_grants",
  "workspace_reference_bindings", "agent_resource_artifact_bindings", "extension_artifact_bindings", "provider_artifact_bindings",
  "session_specs", "session_spec_resource_snapshots", "session_spec_extension_grants", "session_spec_provider_bindings", "sessions", "session_metadata", "session_lifecycle", "session_runtime_state", "session_endpoint_bindings",
  "attachments", "turn_input_snapshots", "turn_input_blocks", "turns", "turn_inference_resolutions", "turn_queue", "turn_queue_entries", "agent_dispatch_attempts", "turn_runtime_states", "turn_events", "turn_messages", "tool_invocations", "turn_interactions", "turn_interaction_advertised_options", "turn_interaction_options", "interaction_response_dispatches",
  "worker_leases", "credential_leases", "agent_resume_handles", "turn_recovery_records", "turn_inference_usage_ledgers", "inference_request_reservations", "inference_forwarding_attempts", "turn_terminal_responses", "turn_terminal_response_messages", "turn_response_deliveries", "turn_response_delivery_attempts", "audit_envelopes",
] as const;

const FORBIDDEN_DEFERRED_TABLES = [
  "connector_accounts",
  "endpoint_session_selections",
  "identity_invitations",
  "turn_interaction_responses",
] as const;

function scalar(database: V2Database, sql: string): unknown {
  return database.transaction((transaction) => {
    const row = transaction.get(sql);
    return row === undefined ? undefined : Object.values(row)[0];
  });
}

function objectNames(type: "table" | "index" | "trigger" | "view"): readonly string[] {
  return HITCH_V2_SCHEMA_MANIFEST.objects.filter((object) => object.type === type).map((object) => object.name);
}

function rootBytes(dataRoot: string): Readonly<Record<string, Buffer | undefined>> {
  const databasePath = join(dataRoot, V2_DATABASE_FILENAME);
  return Object.freeze(Object.fromEntries(
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
      .map((path) => [path, existsSync(path) ? readFileSync(path) : undefined]),
  ));
}

function assertSameRootBytes(before: Readonly<Record<string, Buffer | undefined>>, after: Readonly<Record<string, Buffer | undefined>>): void {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const path of Object.keys(before)) assert.deepEqual(after[path], before[path], path);
}

function alter(dataRoot: string, sql: string): void {
  const database = new DatabaseSync(join(dataRoot, V2_DATABASE_FILENAME));
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function seedSessionTurnSkeleton(database: DatabaseSync): void {
  // V2-004 does not provide bootstrap repositories yet. Seed only the parent
  // identities outside each test's subject, then re-enable FK enforcement
  // before exercising the child relationship under review.
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec(`
      INSERT INTO sessions (id, owner_principal_id, spec_id, created_at)
        VALUES ('session-a', 'principal-a', 'spec-a', '2026-01-01T00:00:00.000Z');
      INSERT INTO sessions (id, owner_principal_id, spec_id, created_at)
        VALUES ('session-b', 'principal-b', 'spec-b', '2026-01-01T00:00:00.000Z');
      INSERT INTO turns (
        id, session_id, requester_principal_id, requester_identity_binding_id,
        authentication_request_id, endpoint_id, endpoint_binding_id,
        origin_message_id, input_snapshot_id, turn_policy_snapshot_id,
        model_selection_kind, selected_provider_id, selected_model_id,
        reasoning_kind, idempotency_key, created_at
      ) VALUES (
        'turn-b', 'session-b', 'principal-b', 'identity-b', 'authentication-b',
        'endpoint-b', 'endpoint-binding-b', 'message-b', 'input-b', 'turn-policy-b',
        'resolved', 'provider-b', 'model-b', 'agent-default', 'key-b',
        '2026-01-01T00:00:00.000Z'
      );
    `);
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

test("canonical schema manifest is a complete, reproducible durable inventory", () => {
  const tableNames = new Set(objectNames("table"));
  assert.equal(HITCH_V2_SCHEMA_MANIFEST.service, "hitch");
  assert.equal(HITCH_V2_SCHEMA_MANIFEST.generation, "v2");
  assert.equal(HITCH_V2_SCHEMA_MANIFEST.sqliteApplicationId, HITCH_V2_SQLITE_APPLICATION_ID);
  assert.equal(HITCH_V2_SCHEMA_MANIFEST.sqliteUserVersion, HITCH_V2_SQLITE_USER_VERSION);
  assert.equal(digestHitchV2SchemaManifest(), HITCH_V2_SCHEMA_DIGEST);
  assert.equal(digestHitchV2SchemaManifest(HITCH_V2_SCHEMA_MANIFEST), HITCH_V2_SCHEMA_DIGEST);
  assert.deepEqual(objectNames("trigger"), []);
  assert.deepEqual([...tableNames].sort(), [...REQUIRED_DURABLE_TABLES].sort());
  for (const table of FORBIDDEN_DEFERRED_TABLES) {
    assert.equal(tableNames.has(table), false, `${table} is outside the first slice`);
  }
  const objectKeys = HITCH_V2_SCHEMA_MANIFEST.objects.map((object) => `${object.type}\u0000${object.name}`);
  assert.deepEqual(
    objectKeys,
    [...objectKeys].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    "canonical manifest ordering must use locale-independent code units",
  );
  for (const [kind, table] of Object.entries(HITCH_V2_SERVICE_ALLOCATED_KIND_TABLES)) {
    assert.equal(tableNames.has(table), true, `${kind} must own a canonical table`);
  }
  for (const table of HITCH_V2_SCHEMA_MANIFEST.tables) {
    assert.equal(table.columns.length > 0, true, `${table.name} has columns`);
    for (const foreignKey of table.foreignKeys) {
      assert.equal(tableNames.has(foreignKey.table), true, `${table.name}.${foreignKey.from} FK target`);
    }
  }
  const forbidden = /(?:credential_(?:value|secret)|broker_capability|command|environment|headers?|source_path)/u;
  const hostPathColumns = HITCH_V2_SCHEMA_MANIFEST.tables.flatMap((table) => table.columns
    .filter((column) => column.name.includes("host_path"))
    .map((column) => `${table.name}.${column.name}`));
  assert.deepEqual(hostPathColumns, ["workspace_resources.canonical_host_path"]);
  for (const table of HITCH_V2_SCHEMA_MANIFEST.tables) {
    for (const column of table.columns) assert.equal(forbidden.test(column.name), false, `${table.name}.${column.name}`);
  }
  for (const [tableName, componentColumns] of Object.entries({
    principals: ["disabled_actor_system_component"],
    identity_bindings: ["revoked_actor_system_component"],
    access_grants: ["granted_actor_system_component", "revoked_actor_system_component"],
    provider_credential_bindings: ["created_actor_system_component", "revoked_actor_system_component"],
    session_endpoint_bindings: ["suspended_actor_system_component", "revoked_actor_system_component"],
    turn_runtime_states: ["requested_actor_system_component"],
    audit_envelopes: ["system_component"],
  })) {
    const columns = HITCH_V2_SCHEMA_MANIFEST.tables.find((table) => table.name === tableName)?.columns.map((column) => column.name) ?? [];
    for (const column of componentColumns) assert.equal(columns.includes(column), true, `${tableName}.${column}`);
  }
});

test("canonical manifest excludes every explicitly deferred first-slice table and discriminant", () => {
  const schemaSql = HITCH_V2_SCHEMA_MANIFEST.objects.map((object) => object.sql).join("\n");
  for (const value of [
    "agent-native",
    "agent-selected",
    "connector",
    "egress-proxy",
    "host-network",
    "hitch-protocol-adapter",
    "mount",
    "native-wire-gateway",
    "project-snapshot",
    "read-only",
    "service",
    "session-readers",
    "shared",
    "unsupported",
    "workspace-resource-link",
  ]) {
    assert.equal(schemaSql.includes(`'${value}'`), false, `${value} must not be accepted by first-slice DDL`);
  }

  const columns = (tableName: string): readonly string[] =>
    HITCH_V2_SCHEMA_MANIFEST.tables.find((table) => table.name === tableName)?.columns.map((column) => column.name) ?? [];
  assert.deepEqual(columns("endpoints"), [
    "id", "installation_id", "address_kind", "local_host_id", "local_endpoint_id",
    "audience_kind", "audience_principal_id", "created_at",
  ]);
  assert.equal(columns("sessions").includes("parent_session_id"), false);
  assert.equal(columns("turn_input_blocks").includes("workspace_resource_id"), false);
  assert.equal(columns("turn_input_blocks").includes("sandbox_path"), false);
});

test("canonical constraints protect singleton metadata, private references, and resource uniqueness", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    openCanonicalHitchV2Database({ dataRoot }).close();
    const database = new DatabaseSync(join(dataRoot, V2_DATABASE_FILENAME));
    try {
      database.exec("PRAGMA foreign_keys = ON");
      assert.throws(() => database.exec("INSERT INTO schema_metadata VALUES ('not-an-integer', 'hitch', 'v2', 1, 'sha256:x')"));
      assert.throws(() => database.exec("INSERT INTO schema_metadata VALUES (2, 'hitch', 'v2', 1, 'sha256:x')"));
      assert.throws(() => database.exec("INSERT INTO private_blobs (id, installation_id, storage, created_at) VALUES ('blob-unknown', 'missing', 'installation-private', 't')"));
      database.exec("INSERT INTO installations (id, service_schema_digest, hard_ceilings_json, created_at, updated_at) VALUES ('installation-1', 'sha256:x', '{}', 't', 't')");
      assert.throws(() => database.exec("INSERT INTO installations (id, service_schema_digest, hard_ceilings_json, created_at, updated_at) VALUES ('installation-2', 'sha256:x', '{}', 't', 't')"));
      database.exec("INSERT INTO private_blobs (id, installation_id, storage, created_at) VALUES ('blob-1', 'installation-1', 'installation-private', 't')");
      database.exec("INSERT INTO workspace_resources (id, installation_id, canonical_host_path, sandbox_path, maximum_access, created_at) VALUES ('resource-1', 'installation-1', '/workspace', '/workspace', 'read-write', 't')");
      assert.throws(() => database.exec("INSERT INTO workspace_resources (id, installation_id, canonical_host_path, sandbox_path, maximum_access, created_at) VALUES ('resource-2', 'installation-1', '/workspace', '/other', 'read-write', 't')"));
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }
  });
});

test("session aggregates cannot queue or activate a Turn owned by another session", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    openCanonicalHitchV2Database({ dataRoot }).close();
    const database = new DatabaseSync(join(dataRoot, V2_DATABASE_FILENAME));
    try {
      seedSessionTurnSkeleton(database);
      assert.throws(() => database.exec(`
        INSERT INTO turn_queue_entries (session_id, turn_id, queue_position, enqueued_at)
          VALUES ('session-a', 'turn-b', 0, '2026-01-01T00:00:00.000Z')
      `));
      assert.throws(() => database.exec(`
        INSERT INTO turn_queue (session_id, active_turn_id, updated_at)
          VALUES ('session-a', 'turn-b', '2026-01-01T00:00:00.000Z')
      `));

      database.exec(`
        INSERT INTO turn_queue_entries (session_id, turn_id, queue_position, enqueued_at)
          VALUES ('session-b', 'turn-b', 0, '2026-01-01T00:00:00.000Z');
        INSERT INTO turn_queue (session_id, active_turn_id, updated_at)
          VALUES ('session-b', 'turn-b', '2026-01-01T00:00:00.000Z');
      `);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check(turn_queue_entries)").all(), []);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check(turn_queue)").all(), []);
    } finally {
      database.close();
    }
  });
});

test("selectable approval options retain their exact safe advertised or mediated disposition", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    openCanonicalHitchV2Database({ dataRoot }).close();
    const database = new DatabaseSync(join(dataRoot, V2_DATABASE_FILENAME));
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      try {
        database.exec(`
          INSERT INTO turn_interactions (
            id, turn_id, protocol_interaction_id, kind, requested_at, expires_at,
            request_json, state
          ) VALUES (
            'interaction-a', 'turn-a', 'protocol-interaction-a', 'approval',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '{}', 'pending'
          );
          INSERT INTO turn_interactions (
            id, turn_id, protocol_interaction_id, kind, requested_at, expires_at,
            request_json, state
          ) VALUES (
            'interaction-input', 'turn-a', 'protocol-interaction-input', 'input',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '{}', 'pending'
          );
          INSERT INTO turn_interaction_advertised_options (
            turn_interaction_id, interaction_kind, protocol_option_id,
            protocol_kind, sanitized_label, advertised_disposition
          ) VALUES
            ('interaction-a', 'approval', 'allow-always', 'allow_always', 'Always allow', 'allow-persistent'),
            ('interaction-a', 'approval', 'allow-once', 'allow_once', 'Allow once', 'allow-once'),
            ('interaction-a', 'approval', 'deny-once', 'reject_once', 'Deny once', 'deny-once');
          INSERT INTO agent_driver_permission_mediations (
            id, agent_driver_id, normalized_decision, guaranteed_disposition, guarantee
          ) VALUES (
            'mediated-allow', 'driver-a', 'allow-once', 'allow-once',
            'one-tool-invocation'
          );
        `);
      } finally {
        database.exec("PRAGMA foreign_keys = ON");
      }

      assert.throws(() => database.exec(`
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, protocol_option_id,
          protocol_option_disposition
        ) VALUES (
          'option-persistent', 'interaction-a', 'approval', 0, 'Allow once',
          'allow-once', 'select-advertised-option', 'allow-always',
          'allow-persistent'
        )
      `));
      assert.throws(() => database.exec(`
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, protocol_option_id,
          protocol_option_disposition
        ) VALUES (
          'option-missing', 'interaction-a', 'approval', 0, 'Allow once',
          'allow-once', 'select-advertised-option', 'not-advertised', 'allow-once'
        )
      `));
      assert.throws(() => database.exec(`
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, protocol_option_id,
          protocol_option_disposition
        ) VALUES (
          'option-mismatched', 'interaction-a', 'approval', 0, 'Allow once',
          'allow-once', 'select-advertised-option', 'deny-once', 'deny-once'
        )
      `));
      assert.throws(() => database.exec(`
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, mediation_id
        ) VALUES (
          'option-wrong-mediation', 'interaction-a', 'approval', 0, 'Deny',
          'deny', 'driver-mediated', 'mediated-allow'
        )
      `));
      assert.throws(() => database.exec(`
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, mediation_id
        ) VALUES (
          'option-on-input', 'interaction-input', 'approval', 0, 'Allow once',
          'allow-once', 'driver-mediated', 'mediated-allow'
        )
      `));

      database.exec(`
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, protocol_option_id,
          protocol_option_disposition
        ) VALUES (
          'option-allow-once', 'interaction-a', 'approval', 0, 'Allow once',
          'allow-once', 'select-advertised-option', 'allow-once', 'allow-once'
        );
        INSERT INTO turn_interaction_options (
          id, turn_interaction_id, interaction_kind, ordinal, sanitized_label,
          normalized_decision, response_kind, mediation_id
        ) VALUES (
          'option-mediated-allow', 'interaction-a', 'approval', 1, 'Allow once',
          'allow-once', 'driver-mediated', 'mediated-allow'
        );
      `);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check(turn_interaction_options)").all(), []);
    } finally {
      database.close();
    }
  });
});

test("durable lifecycle projections reject partial or contradictory states", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    openCanonicalHitchV2Database({ dataRoot }).close();
    const database = new DatabaseSync(join(dataRoot, V2_DATABASE_FILENAME));
    try {
      seedSessionTurnSkeleton(database);
      database.exec("PRAGMA foreign_keys = OFF");
      try {
        database.exec(`
          INSERT INTO worker_leases (
            id, session_id, fencing_token, state, issued_at, expires_at, updated_at
          ) VALUES (
            'worker-b', 'session-b', 1, 'active', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:05:00.000Z', '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO worker_leases (
            id, session_id, fencing_token, state, issued_at, expires_at, updated_at
          ) VALUES (
            'worker-a', 'session-a', 1, 'active', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:05:00.000Z', '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO turn_interactions (
            id, turn_id, protocol_interaction_id, kind, requested_at, expires_at,
            request_json, state
          ) VALUES (
            'interaction-b', 'turn-b', 'protocol-interaction-b', 'approval',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', '{}', 'pending'
          );
        `);
      } finally {
        database.exec("PRAGMA foreign_keys = ON");
      }

      assert.throws(() => database.exec(`
        INSERT INTO agent_dispatch_attempts (
          id, turn_id, session_id, attempt_number, state, started_at
        ) VALUES (
          'attempt-incomplete', 'turn-b', 'session-b', 1, 'terminal',
          '2026-01-01T00:00:00.000Z'
        )
      `));
      assert.throws(() => database.exec(`
        INSERT INTO agent_dispatch_attempts (
          id, turn_id, session_id, attempt_number, state, worker_lease_id,
          worker_fencing_token, started_at
        ) VALUES (
          'attempt-cross-session-worker', 'turn-b', 'session-b', 1,
          'dispatching', 'worker-a', 1, '2026-01-01T00:00:00.000Z'
        )
      `));
      assert.throws(() => database.exec(`
        INSERT INTO agent_dispatch_attempts (
          id, turn_id, session_id, attempt_number, state, started_at,
          submitted_at, completed_at
        ) VALUES (
          'attempt-contradictory-terminal', 'turn-b', 'session-b', 1,
          'terminal', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'
        )
      `));
      database.exec(`
        INSERT INTO agent_dispatch_attempts (
          id, turn_id, session_id, attempt_number, state, worker_lease_id,
          worker_fencing_token, started_at, armed_at, submitted_at, accepted_at,
          submission_outcome, acceptance_evidence_json
        ) VALUES (
          'attempt-b', 'turn-b', 'session-b', 1, 'waiting-for-approval',
          'worker-b', 1, '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z',
          '2026-01-01T00:00:03.000Z', 'submitted', '{}'
        )
      `);
      assert.throws(() => database.exec(`
        INSERT INTO turn_runtime_states (
          turn_id, session_id, status, attempt_id, interaction_id,
          interaction_kind, updated_at
        ) VALUES (
          'turn-b', 'session-b', 'waiting-for-input', 'attempt-b',
          'interaction-b', 'approval', '2026-01-01T00:00:04.000Z'
        )
      `));
      database.exec(`
        INSERT INTO turn_runtime_states (
          turn_id, session_id, status, attempt_id, interaction_id,
          interaction_kind, updated_at
        ) VALUES (
          'turn-b', 'session-b', 'waiting-for-approval', 'attempt-b',
          'interaction-b', 'approval', '2026-01-01T00:00:04.000Z'
        )
      `);

      assert.throws(() => database.exec(`
        INSERT INTO interaction_response_dispatches (
          id, interaction_id, turn_id, session_id, attempt_id, worker_lease_id,
          worker_fencing_token, state, delivered_at, created_at, updated_at
        ) VALUES (
          'response-incomplete', 'interaction-b', 'turn-b', 'session-b',
          'attempt-b', 'worker-b', 1, 'delivered',
          '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:04.000Z',
          '2026-01-01T00:00:05.000Z'
        )
      `));
      database.exec(`
        INSERT INTO interaction_response_dispatches (
          id, interaction_id, turn_id, session_id, attempt_id, worker_lease_id,
          worker_fencing_token, state, started_at, delivered_at, created_at,
          updated_at
        ) VALUES (
          'response-b', 'interaction-b', 'turn-b', 'session-b', 'attempt-b',
          'worker-b', 1, 'delivered', '2026-01-01T00:00:04.000Z',
          '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:04.000Z',
          '2026-01-01T00:00:05.000Z'
        )
      `);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check(interaction_response_dispatches)").all(), []);

      database.exec("PRAGMA foreign_keys = OFF");
      try {
        database.exec(`
          INSERT INTO principals (
            id, installation_id, kind, display_name, state, created_at
          ) VALUES (
            'principal-b', 'installation-b', 'human', 'Principal B', 'active',
            '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO endpoints (
            id, installation_id, address_kind, local_host_id, local_endpoint_id,
            audience_kind, audience_principal_id, created_at
          ) VALUES (
            'endpoint-b', 'installation-b', 'local-client', 'local-host-b',
            'local-endpoint-b', 'private', 'principal-b',
            '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO session_endpoint_bindings (
            id, kind, session_id, endpoint_id, created_by_principal_id, state,
            created_at, updated_at
          ) VALUES (
            'endpoint-binding-b', 'private', 'session-b', 'endpoint-b',
            'principal-b', 'active', '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          );
          INSERT INTO turn_terminal_responses (
            id, turn_id, result_json, partial_output_available, finalized_at
          ) VALUES (
            'terminal-b', 'turn-b', '{"outcome":"completed"}', 0,
            '2026-01-01T00:00:06.000Z'
          );
        `);
      } finally {
        database.exec("PRAGMA foreign_keys = ON");
      }

      assert.throws(() => database.exec(`
        INSERT INTO turn_response_deliveries (
          id, terminal_response_id, turn_id, session_id, endpoint_id,
          endpoint_binding_id, recipient_principal_id, deadline_at,
          maximum_attempts, attempt_count, state, delivered_at, created_at,
          updated_at
        ) VALUES (
          'delivery-incomplete', 'terminal-b', 'turn-b', 'session-b',
          'endpoint-b', 'endpoint-binding-b', 'principal-b',
          '2026-01-01T00:05:00.000Z', 3, 0, 'pending',
          '2026-01-01T00:00:07.000Z', '2026-01-01T00:00:06.000Z',
          '2026-01-01T00:00:06.000Z'
        )
      `));
      database.exec(`
        INSERT INTO turn_response_deliveries (
          id, terminal_response_id, turn_id, session_id, endpoint_id,
          endpoint_binding_id, recipient_principal_id, deadline_at,
          maximum_attempts, attempt_count, state, created_at, updated_at
        ) VALUES (
          'delivery-b', 'terminal-b', 'turn-b', 'session-b', 'endpoint-b',
          'endpoint-binding-b', 'principal-b', '2026-01-01T00:05:00.000Z',
          3, 0, 'pending', '2026-01-01T00:00:06.000Z',
          '2026-01-01T00:00:06.000Z'
        )
      `);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check(turn_response_deliveries)").all(), []);
    } finally {
      database.close();
    }
  });
});

scenarioCase({
  scenarioId: "V2-S01",
  caseId: "canonical-schema-atomic-open-reopen",
  title: "canonical schema initializes atomically and reopens only through exact validation",
  run: async () => withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const first = openCanonicalHitchV2Database({ dataRoot });
    try {
      assert.equal(scalar(first, "PRAGMA application_id"), HITCH_V2_SQLITE_APPLICATION_ID);
      assert.equal(scalar(first, "PRAGMA user_version"), HITCH_V2_SQLITE_USER_VERSION);
      assert.deepEqual(first.transaction((transaction) => transaction.all("SELECT singleton, service, generation, schema_version, schema_digest FROM schema_metadata")), [{
        singleton: 1,
        service: "hitch",
        generation: "v2",
        schema_version: 1,
        schema_digest: HITCH_V2_SCHEMA_DIGEST,
      }]);
      assert.deepEqual(first.transaction((transaction) => transaction.all("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")), HITCH_V2_SCHEMA_MANIFEST.objects.map((object) => ({ type: object.type, name: object.name })));
      assert.equal(first.transaction((transaction) => transaction.all("SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
        .every((row) => typeof row.sql === "string" && row.sql.endsWith(" STRICT")), true);
    } finally {
      first.close();
    }
    const reopened = openCanonicalHitchV2Database({ dataRoot });
    reopened.close();
  }),
});

test("canonical schema creates every manifest statement and expected operational indexes", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const database = openCanonicalHitchV2Database({ dataRoot: disposable.resolve("state") });
    try {
      const indexes = new Set(objectNames("index"));
      for (const name of [
        "uq_worker_leases_active_session",
        "uq_credential_leases_active_worker_connection",
        "ix_turn_queue_entries_head",
        "ix_inference_reservations_turn_state",
        "ix_turn_response_deliveries_due",
        "uq_workspace_revision_single_root",
        "uq_turn_input_blocks_single_attachment",
        "uq_installations_first_slice_singleton",
      ]) assert.equal(indexes.has(name), true, name);
      const tablesWithForeignKeys = HITCH_V2_SCHEMA_MANIFEST.tables.filter((table) => table.foreignKeys.length > 0);
      assert.equal(tablesWithForeignKeys.length > 0, true);
    } finally {
      database.close();
    }
  });
});

test("a failed pristine schema transaction rolls back and a later canonical open retries safely", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const foundation = V2Database.open({ dataRoot });
    try {
      assert.throws(() => foundation.initializePristineSchema((initializer) => {
        initializer.executeSchemaStatement("CREATE TABLE intentionally_rolled_back (id TEXT PRIMARY KEY)");
        throw new Error("injected schema-owner failure");
      }));
      assert.equal(scalar(foundation, "PRAGMA application_id"), 0);
      assert.equal(scalar(foundation, "PRAGMA user_version"), 0);
      assert.equal(foundation.transaction((transaction) => transaction.all("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").length), 0);
    } finally {
      foundation.close();
    }
    const retried = openCanonicalHitchV2Database({ dataRoot });
    retried.close();
  });
});

test("an injected schema-owner commit failure leaves the foundation pristine for a safe retry", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    let beforeCommitCount = 0;
    assert.throws(() => openCanonicalHitchV2Database({
      dataRoot,
      transactionFaults: {
        hit(boundary) {
          if (boundary === "before-commit" && beforeCommitCount++ === 1) {
            throw new Error("injected schema commit failure");
          }
        },
      },
    }));
    const foundation = V2Database.open({ dataRoot });
    try {
      assert.equal(scalar(foundation, "PRAGMA application_id"), 0);
      assert.equal(scalar(foundation, "PRAGMA user_version"), 0);
      assert.equal(foundation.transaction((transaction) => transaction.all("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").length), 0);
    } finally {
      foundation.close();
    }
    openCanonicalHitchV2Database({ dataRoot }).close();
  });
});

test("existing roots reject all noncanonical mutations before the original database or sidecars change", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const cases: readonly [string, string][] = [
      ["extra-table", "CREATE TABLE unauthorized_table (id INTEGER PRIMARY KEY)"],
      ["extra-index", "CREATE INDEX unauthorized_index ON installations (created_at)"],
      ["extra-trigger", "CREATE TRIGGER unauthorized_trigger AFTER INSERT ON installations BEGIN SELECT 1; END"],
      ["extra-column", "ALTER TABLE installations ADD COLUMN unauthorized_column TEXT"],
      ["older-version", "PRAGMA user_version = 0"],
      ["newer-version", "PRAGMA user_version = 2"],
      ["wrong-application", "PRAGMA application_id = 1"],
      ["wrong-metadata", "UPDATE schema_metadata SET schema_digest = 'sha256:wrong'"],
    ];
    for (const [name, mutation] of cases) {
      const dataRoot = disposable.resolve(name);
      const canonical = openCanonicalHitchV2Database({ dataRoot });
      canonical.close();
      alter(dataRoot, mutation);
      const before = rootBytes(dataRoot);
      assert.throws(() => openCanonicalHitchV2Database({ dataRoot }), V2DataRootError, name);
      assertSameRootBytes(before, rootBytes(dataRoot));
    }
  });
});

test("changed canonical SQL and a legacy pristine-shaped foreign root are rejected without repair", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const changedSqlRoot = disposable.resolve("changed-sql");
    const canonical = openCanonicalHitchV2Database({ dataRoot: changedSqlRoot });
    canonical.close();
    alter(changedSqlRoot, "ALTER TABLE installations RENAME COLUMN created_at TO created_time");
    const changedBefore = rootBytes(changedSqlRoot);
    assert.throws(() => openCanonicalHitchV2Database({ dataRoot: changedSqlRoot }), V2DataRootError);
    assertSameRootBytes(changedBefore, rootBytes(changedSqlRoot));

    const legacyRoot = disposable.resolve("legacy");
    const foundation = V2Database.open({ dataRoot: legacyRoot });
    try {
      foundation.initializePristineSchema((initializer) => {
        initializer.executeSchemaStatement("CREATE TABLE legacy_value (id INTEGER PRIMARY KEY)");
        initializer.stampSchemaIdentity(12_345, 1);
      });
    } finally {
      foundation.close();
    }
    const legacyBefore = rootBytes(legacyRoot);
    assert.throws(() => openCanonicalHitchV2Database({ dataRoot: legacyRoot }), V2DataRootError);
    assertSameRootBytes(legacyBefore, rootBytes(legacyRoot));
  });
});

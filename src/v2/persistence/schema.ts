/**
 * The one and only pre-release multi-user MVP SQLite layout.
 *
 * This file is deliberately data-first: repositories may depend on these
 * names, but they never own DDL.  The manifest is also the acceptance oracle
 * for an already-existing root, so changing any statement here is a schema
 * version change, not a harmless formatting edit.
 */

import { createHash } from "node:crypto";

import type { ServiceAllocatedIdKind } from "../model/application.js";
import type {
  ExistingV2DatabaseValidation,
  SQLiteSchemaObject,
  V2SchemaInitializer,
} from "./database.js";
import { V2DataRootError } from "./errors.js";

export const HITCH_V2_SQLITE_APPLICATION_ID = 0x4849_5432;
export const HITCH_V2_SQLITE_USER_VERSION = 1;
export const HITCH_V2_SCHEMA_VERSION = 1;

export interface CanonicalSchemaColumn {
  readonly name: string;
}

export interface CanonicalSchemaForeignKey {
  readonly from: string;
  readonly table: string;
  readonly to: string;
}

export interface CanonicalSchemaTable {
  readonly name: string;
  readonly sql: string;
  readonly columns: readonly CanonicalSchemaColumn[];
  readonly foreignKeys: readonly CanonicalSchemaForeignKey[];
}

export interface CanonicalSchemaObject {
  readonly type: "index" | "table" | "trigger" | "view";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

export interface HitchV2SchemaManifest {
  readonly service: "hitch";
  readonly generation: "v2";
  readonly schemaVersion: 1;
  readonly sqliteApplicationId: number;
  readonly sqliteUserVersion: number;
  readonly metadata: {
    readonly singleton: 1;
    readonly service: "hitch";
    readonly generation: "v2";
    readonly schemaVersion: 1;
  };
  readonly objects: readonly CanonicalSchemaObject[];
  readonly tables: readonly CanonicalSchemaTable[];
}

/**
 * Every JSON column is a codec-owned canonical JSON projection.  Payloads
 * which need relational identity, uniqueness, lifecycle inspection, or
 * authorization are deliberately represented by ordinary columns/tables.
 */
const HITCH_V2_SCHEMA_DDL_UNQUALIFIED = [
  `CREATE TABLE schema_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    service TEXT NOT NULL CHECK (service = 'hitch'),
    generation TEXT NOT NULL CHECK (generation = 'v2'),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    schema_digest TEXT NOT NULL
  )`,
  `CREATE TABLE installations (
    id TEXT PRIMARY KEY,
    service_schema_digest TEXT NOT NULL,
    hard_ceilings_json TEXT NOT NULL CHECK (json_valid(hard_ceilings_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE private_blobs (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    storage TEXT NOT NULL CHECK (storage = 'installation-private'),
    integrity_digest TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE principals (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    kind TEXT NOT NULL CHECK (kind = 'human'),
    display_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
    disabled_at TEXT,
    disabled_actor_kind TEXT,
    disabled_actor_principal_id TEXT REFERENCES principals(id),
    disabled_actor_system_component TEXT CHECK (disabled_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    created_at TEXT NOT NULL,
    UNIQUE (id, installation_id),
    CHECK ((state = 'active' AND disabled_at IS NULL AND disabled_actor_kind IS NULL AND disabled_actor_principal_id IS NULL AND disabled_actor_system_component IS NULL) OR (state = 'disabled' AND disabled_at IS NOT NULL AND ((disabled_actor_kind = 'bootstrap' AND disabled_actor_principal_id IS NULL AND disabled_actor_system_component IS NULL) OR (disabled_actor_kind = 'principal' AND disabled_actor_principal_id IS NOT NULL AND disabled_actor_system_component IS NULL) OR (disabled_actor_kind = 'system' AND disabled_actor_principal_id IS NULL AND disabled_actor_system_component IS NOT NULL))))
  )`,
  `CREATE TABLE local_hosts (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE identity_bindings (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('local-peer', 'mtls-client')),
    local_host_id TEXT REFERENCES local_hosts(id),
    client_trust_root_id TEXT,
    subject_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    revoked_at TEXT,
    revoked_actor_kind TEXT,
    revoked_actor_principal_id TEXT REFERENCES principals(id),
    revoked_actor_system_component TEXT CHECK (revoked_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    supersedes_binding_id TEXT REFERENCES identity_bindings(id),
    created_at TEXT NOT NULL,
    UNIQUE (id, principal_id),
    UNIQUE (id, installation_id),
    UNIQUE (id, principal_id, source_kind),
    UNIQUE (id, principal_id, source_kind, client_trust_root_id, subject_id),
    CHECK ((source_kind = 'local-peer' AND local_host_id IS NOT NULL AND client_trust_root_id IS NULL) OR (source_kind = 'mtls-client' AND local_host_id IS NULL AND client_trust_root_id IS NOT NULL AND length(client_trust_root_id) BETWEEN 1 AND 128 AND client_trust_root_id NOT LIKE '%..%' AND client_trust_root_id NOT GLOB '*[^A-Za-z0-9._:@-]*' AND substr(client_trust_root_id, 1, 1) GLOB '[A-Za-z0-9]' AND substr(client_trust_root_id, -1, 1) GLOB '[A-Za-z0-9]' AND length(subject_id) = 71 AND substr(subject_id, 1, 7) = 'sha256:' AND substr(subject_id, 8) NOT GLOB '*[^0-9a-f]*')),
    CHECK ((state = 'active' AND revoked_at IS NULL AND revoked_actor_kind IS NULL AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL AND ((revoked_actor_kind = 'bootstrap' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'principal' AND revoked_actor_principal_id IS NOT NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'system' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NOT NULL))))
  )`,
  `CREATE TABLE authentication_requests (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('local-peer-owner-socket', 'mtls-client-certificate')),
    socket_security TEXT CHECK (socket_security = 'service-owned-0700-parent-and-0600-socket'),
    client_trust_root_id TEXT,
    client_certificate_fingerprint TEXT,
    binding_source_kind TEXT CHECK (binding_source_kind IN ('local-peer', 'mtls-client')),
    outcome_status TEXT NOT NULL CHECK (outcome_status IN ('authenticated', 'rejected')),
    principal_id TEXT REFERENCES principals(id),
    identity_binding_id TEXT REFERENCES identity_bindings(id),
    assurance TEXT CHECK (assurance IN ('normal', 'elevated')),
    rejection_reason TEXT CHECK (rejection_reason IN ('unknown-binding', 'binding-revoked', 'principal-disabled')),
    decided_at TEXT NOT NULL,
    UNIQUE (id, principal_id, identity_binding_id),
    FOREIGN KEY (identity_binding_id, principal_id) REFERENCES identity_bindings(id, principal_id),
    FOREIGN KEY (identity_binding_id, principal_id, binding_source_kind) REFERENCES identity_bindings(id, principal_id, source_kind),
    FOREIGN KEY (identity_binding_id, principal_id, binding_source_kind, client_trust_root_id, client_certificate_fingerprint) REFERENCES identity_bindings(id, principal_id, source_kind, client_trust_root_id, subject_id),
    CHECK ((evidence_kind = 'local-peer-owner-socket' AND socket_security IS NOT NULL AND client_trust_root_id IS NULL AND client_certificate_fingerprint IS NULL) OR (evidence_kind = 'mtls-client-certificate' AND socket_security IS NULL AND client_trust_root_id IS NOT NULL AND length(client_trust_root_id) BETWEEN 1 AND 128 AND client_trust_root_id NOT LIKE '%..%' AND client_trust_root_id NOT GLOB '*[^A-Za-z0-9._:@-]*' AND substr(client_trust_root_id, 1, 1) GLOB '[A-Za-z0-9]' AND substr(client_trust_root_id, -1, 1) GLOB '[A-Za-z0-9]' AND client_certificate_fingerprint IS NOT NULL AND length(client_certificate_fingerprint) = 71 AND substr(client_certificate_fingerprint, 1, 7) = 'sha256:' AND substr(client_certificate_fingerprint, 8) NOT GLOB '*[^0-9a-f]*')),
    CHECK ((outcome_status = 'authenticated' AND principal_id IS NOT NULL AND identity_binding_id IS NOT NULL AND assurance IS NOT NULL AND rejection_reason IS NULL AND ((evidence_kind = 'local-peer-owner-socket' AND binding_source_kind = 'local-peer') OR (evidence_kind = 'mtls-client-certificate' AND binding_source_kind = 'mtls-client'))) OR (outcome_status = 'rejected' AND principal_id IS NULL AND identity_binding_id IS NULL AND assurance IS NULL AND rejection_reason IS NOT NULL AND binding_source_kind IS NULL))
  )`,
  `CREATE TABLE endpoints (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    address_kind TEXT NOT NULL CHECK (address_kind IN ('local-client', 'remote-client')),
    local_host_id TEXT REFERENCES local_hosts(id),
    local_endpoint_id TEXT,
    identity_binding_id TEXT,
    identity_binding_source_kind TEXT CHECK (identity_binding_source_kind = 'mtls-client'),
    audience_kind TEXT NOT NULL CHECK (audience_kind = 'private'),
    audience_principal_id TEXT NOT NULL REFERENCES principals(id),
    created_at TEXT NOT NULL,
    UNIQUE (id, audience_principal_id),
    FOREIGN KEY (identity_binding_id, audience_principal_id, identity_binding_source_kind) REFERENCES identity_bindings(id, principal_id, source_kind),
    CHECK ((address_kind = 'local-client' AND local_host_id IS NOT NULL AND local_endpoint_id IS NOT NULL AND identity_binding_id IS NULL AND identity_binding_source_kind IS NULL) OR (address_kind = 'remote-client' AND local_host_id IS NULL AND local_endpoint_id IS NULL AND identity_binding_id IS NOT NULL AND identity_binding_source_kind = 'mtls-client'))
  )`,
  `CREATE TABLE access_grants (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('installation-role', 'session-configuration-use')),
    installation_id TEXT REFERENCES installations(id),
    principal_id TEXT NOT NULL REFERENCES principals(id),
    role TEXT,
    resource_kind TEXT CHECK (resource_kind IN ('agent-profile', 'workspace', 'execution-policy', 'turn-policy', 'extension', 'provider-credential-binding')),
    resource_id TEXT,
    granted_actor_kind TEXT NOT NULL CHECK (granted_actor_kind IN ('bootstrap', 'principal', 'system')),
    granted_actor_principal_id TEXT REFERENCES principals(id),
    granted_actor_system_component TEXT CHECK (granted_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    revoked_at TEXT,
    revoked_actor_kind TEXT,
    revoked_actor_principal_id TEXT REFERENCES principals(id),
    revoked_actor_system_component TEXT CHECK (revoked_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    CHECK ((kind = 'installation-role' AND installation_id IS NOT NULL AND role IN ('admin', 'member') AND resource_kind IS NULL AND resource_id IS NULL) OR (kind = 'session-configuration-use' AND installation_id IS NOT NULL AND role IS NULL AND resource_kind IS NOT NULL AND resource_id IS NOT NULL)),
    CHECK ((granted_actor_kind = 'bootstrap' AND granted_actor_principal_id IS NULL AND granted_actor_system_component IS NULL) OR (granted_actor_kind = 'principal' AND granted_actor_principal_id IS NOT NULL AND granted_actor_system_component IS NULL) OR (granted_actor_kind = 'system' AND granted_actor_principal_id IS NULL AND granted_actor_system_component IS NOT NULL)),
    CHECK ((state = 'active' AND revoked_at IS NULL AND revoked_actor_kind IS NULL AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL AND ((revoked_actor_kind = 'bootstrap' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'principal' AND revoked_actor_principal_id IS NOT NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'system' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NOT NULL))))
  )`,
  `CREATE TABLE installation_reference_bindings (
    installation_id TEXT PRIMARY KEY REFERENCES installations(id),
    reference TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL
  )`,
  `CREATE TABLE principal_reference_bindings (
    principal_id TEXT PRIMARY KEY REFERENCES principals(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE local_host_reference_bindings (
    local_host_id TEXT PRIMARY KEY REFERENCES local_hosts(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE identity_binding_reference_bindings (
    identity_binding_id TEXT PRIMARY KEY REFERENCES identity_bindings(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE authentication_subject_reference_bindings (
    identity_binding_id TEXT PRIMARY KEY REFERENCES identity_bindings(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    resolution TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    UNIQUE (installation_id, reference),
    UNIQUE (installation_id, resolution),
    UNIQUE (installation_id, subject_id)
  )`,
  `CREATE TABLE endpoint_reference_bindings (
    endpoint_id TEXT PRIMARY KEY REFERENCES endpoints(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    local_endpoint_id TEXT NOT NULL,
    UNIQUE (installation_id, reference),
    UNIQUE (installation_id, local_endpoint_id)
  )`,
  `CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, reference),
    UNIQUE (id, installation_id)
  )`,
  `CREATE TABLE principal_workspace_bindings (
    principal_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    workspace_id TEXT NOT NULL UNIQUE,
    created_actor_kind TEXT NOT NULL CHECK (created_actor_kind IN ('bootstrap', 'principal', 'system')),
    created_actor_principal_id TEXT REFERENCES principals(id),
    created_actor_system_component TEXT CHECK (created_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (principal_id, installation_id) REFERENCES principals(id, installation_id),
    FOREIGN KEY (workspace_id, installation_id) REFERENCES workspaces(id, installation_id),
    CHECK ((created_actor_kind = 'bootstrap' AND created_actor_principal_id IS NULL AND created_actor_system_component IS NULL) OR (created_actor_kind = 'principal' AND created_actor_principal_id IS NOT NULL AND created_actor_system_component IS NULL) OR (created_actor_kind = 'system' AND created_actor_principal_id IS NULL AND created_actor_system_component IS NOT NULL))
  )`,
  `CREATE TABLE workspace_resources (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    canonical_host_path TEXT NOT NULL,
    sandbox_path TEXT NOT NULL,
    maximum_access TEXT NOT NULL CHECK (maximum_access = 'read-write'),
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, canonical_host_path)
  )`,
  `CREATE TABLE workspace_revisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, revision)
  )`,
  `CREATE TABLE workspace_revision_resources (
    workspace_revision_id TEXT NOT NULL REFERENCES workspace_revisions(id),
    workspace_resource_id TEXT NOT NULL REFERENCES workspace_resources(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    role TEXT NOT NULL CHECK (role = 'root'),
    PRIMARY KEY (workspace_revision_id, workspace_resource_id),
    UNIQUE (workspace_revision_id, ordinal)
  )`,
  `CREATE TABLE execution_policies (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE tool_capabilities (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id)
  )`,
  `CREATE TABLE execution_policy_snapshots (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES execution_policies(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    sandbox TEXT NOT NULL CHECK (sandbox = 'required'),
    workspace_filesystem TEXT NOT NULL CHECK (workspace_filesystem = 'read-write'),
    process TEXT NOT NULL CHECK (process = 'deny'),
    network TEXT NOT NULL CHECK (network = 'deny'),
    memory_bytes INTEGER,
    max_processes INTEGER,
    temporary_storage_bytes INTEGER,
    output_bytes INTEGER,
    created_at TEXT NOT NULL,
    CHECK ((memory_bytes IS NULL OR memory_bytes > 0) AND (max_processes IS NULL OR max_processes > 0) AND (temporary_storage_bytes IS NULL OR temporary_storage_bytes > 0) AND (output_bytes IS NULL OR output_bytes > 0)),
    UNIQUE (policy_id, revision)
  )`,
  `CREATE TABLE execution_policy_resource_grants (
    execution_policy_snapshot_id TEXT NOT NULL REFERENCES execution_policy_snapshots(id),
    workspace_resource_id TEXT NOT NULL REFERENCES workspace_resources(id),
    access TEXT NOT NULL CHECK (access = 'read-write'),
    PRIMARY KEY (execution_policy_snapshot_id, workspace_resource_id)
  )`,
  `CREATE TABLE execution_policy_tool_capabilities (
    execution_policy_snapshot_id TEXT NOT NULL REFERENCES execution_policy_snapshots(id),
    tool_capability_id TEXT NOT NULL REFERENCES tool_capabilities(id),
    PRIMARY KEY (execution_policy_snapshot_id, tool_capability_id)
  )`,
  `CREATE TABLE turn_policies (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE turn_policy_snapshots (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL REFERENCES turn_policies(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    when_busy TEXT NOT NULL CHECK (when_busy = 'bounded-fifo'),
    max_queued_turns INTEGER NOT NULL CHECK (max_queued_turns = 3),
    initial_active_work_ms INTEGER NOT NULL CHECK (initial_active_work_ms > 0),
    tool_extension_ms INTEGER NOT NULL CHECK (tool_extension_ms >= 0),
    maximum_active_work_ms INTEGER NOT NULL CHECK (maximum_active_work_ms > 0),
    interaction_wait_ms INTEGER NOT NULL CHECK (interaction_wait_ms > 0),
    approval TEXT NOT NULL CHECK (approval = 'ask-authorized-approver'),
    on_approval_timeout TEXT NOT NULL CHECK (on_approval_timeout = 'deny'),
    input_requests TEXT NOT NULL CHECK (input_requests = 'deny'),
    on_input_timeout TEXT NOT NULL CHECK (on_input_timeout = 'no-input'),
    maximum_before_acceptance_attempts INTEGER NOT NULL CHECK (maximum_before_acceptance_attempts > 0),
    after_possible_acceptance TEXT NOT NULL CHECK (after_possible_acceptance = 'never'),
    maximum_provider_requests INTEGER NOT NULL CHECK (maximum_provider_requests > 0),
    maximum_total_tokens INTEGER NOT NULL CHECK (maximum_total_tokens > 0),
    maximum_output_tokens_per_request INTEGER NOT NULL CHECK (maximum_output_tokens_per_request > 0),
    progress_delivery TEXT NOT NULL CHECK (progress_delivery = 'checkpoints'),
    checkpoint_interval_ms INTEGER NOT NULL CHECK (checkpoint_interval_ms > 0),
    maximum_checkpoint_characters INTEGER NOT NULL CHECK (maximum_checkpoint_characters > 0),
    persist_final_messages INTEGER NOT NULL CHECK (persist_final_messages = 1),
    persist_raw_reasoning INTEGER NOT NULL CHECK (persist_raw_reasoning = 0),
    persist_raw_tool_input_output INTEGER NOT NULL CHECK (persist_raw_tool_input_output = 0),
    created_at TEXT NOT NULL,
    CHECK (maximum_active_work_ms >= initial_active_work_ms),
    UNIQUE (policy_id, revision)
  )`,
  `CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id)
  )`,
  `CREATE TABLE models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    UNIQUE (id, provider_id)
  )`,
  `CREATE TABLE provider_credential_bindings (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    provider_id TEXT NOT NULL REFERENCES providers(id),
    custody TEXT NOT NULL CHECK (custody = 'hitch-control-plane'),
    display_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    revoked_at TEXT,
    revoked_actor_kind TEXT,
    revoked_actor_principal_id TEXT REFERENCES principals(id),
    revoked_actor_system_component TEXT CHECK (revoked_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    created_actor_kind TEXT NOT NULL CHECK (created_actor_kind IN ('bootstrap', 'principal', 'system')),
    created_actor_principal_id TEXT REFERENCES principals(id),
    created_actor_system_component TEXT CHECK (created_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, provider_id),
    CHECK ((created_actor_kind = 'bootstrap' AND created_actor_principal_id IS NULL AND created_actor_system_component IS NULL) OR (created_actor_kind = 'principal' AND created_actor_principal_id IS NOT NULL AND created_actor_system_component IS NULL) OR (created_actor_kind = 'system' AND created_actor_principal_id IS NULL AND created_actor_system_component IS NOT NULL)),
    CHECK ((state = 'active' AND revoked_at IS NULL AND revoked_actor_kind IS NULL AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL AND ((revoked_actor_kind = 'bootstrap' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'principal' AND revoked_actor_principal_id IS NOT NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'system' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NOT NULL))))
  )`,
  `CREATE TABLE provider_connections (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    provider_id TEXT NOT NULL REFERENCES providers(id),
    display_name TEXT NOT NULL,
    transport_mode TEXT NOT NULL CHECK (transport_mode = 'native-library-sidecar'),
    credential_custody TEXT NOT NULL CHECK (credential_custody = 'hitch-control-plane'),
    bridge_id TEXT NOT NULL,
    native_stack TEXT NOT NULL CHECK (native_stack = 'pi-ai'),
    native_stack_version TEXT NOT NULL,
    bridge_protocol_version INTEGER NOT NULL CHECK (bridge_protocol_version > 0),
    native_catalog_digest TEXT NOT NULL,
    credential_resolver_id TEXT NOT NULL,
    native_retries TEXT NOT NULL CHECK (native_retries = 'disabled'),
    invocation TEXT NOT NULL CHECK (invocation = 'structured-native-request'),
    transport_metadata_json TEXT NOT NULL CHECK (json_valid(transport_metadata_json)),
    integrity_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, provider_id)
  )`,
  `CREATE TABLE provider_connection_origins (
    provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id),
    origin TEXT NOT NULL,
    PRIMARY KEY (provider_connection_id, origin)
  )`,
  `CREATE TABLE provider_model_manifests (
    provider_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    model_id TEXT NOT NULL,
    api_protocol_id TEXT NOT NULL,
    context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
    maximum_output_tokens INTEGER NOT NULL CHECK (maximum_output_tokens > 0),
    token_estimator_id TEXT NOT NULL,
    image_input_kind TEXT NOT NULL CHECK (image_input_kind = 'supported'),
    maximum_images_per_request INTEGER NOT NULL CHECK (maximum_images_per_request = 1),
    maximum_image_bytes_each INTEGER NOT NULL CHECK (maximum_image_bytes_each > 0),
    maximum_total_image_bytes_per_request INTEGER NOT NULL,
    tools TEXT NOT NULL CHECK (tools = 'supported'),
    reasoning_kind TEXT NOT NULL CHECK (reasoning_kind = 'portable-efforts'),
    agent_default_supported INTEGER NOT NULL CHECK (agent_default_supported = 1),
    native_model_metadata_json TEXT NOT NULL CHECK (json_valid(native_model_metadata_json)),
    integrity_digest TEXT NOT NULL,
    PRIMARY KEY (provider_connection_id, model_id),
    UNIQUE (provider_connection_id),
    FOREIGN KEY (provider_connection_id, provider_id) REFERENCES provider_connections(id, provider_id),
    FOREIGN KEY (model_id, provider_id) REFERENCES models(id, provider_id),
    CHECK (maximum_output_tokens <= context_window_tokens),
    CHECK (maximum_total_image_bytes_per_request = maximum_image_bytes_each)
  )`,
  `CREATE TABLE provider_model_image_mime_types (
    provider_connection_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
    PRIMARY KEY (provider_connection_id, model_id, mime_type),
    FOREIGN KEY (provider_connection_id, model_id) REFERENCES provider_model_manifests(provider_connection_id, model_id)
  )`,
  `CREATE TABLE provider_model_reasoning_efforts (
    provider_connection_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    effort TEXT NOT NULL CHECK (effort IN ('none', 'low', 'medium', 'high')),
    PRIMARY KEY (provider_connection_id, model_id, effort),
    FOREIGN KEY (provider_connection_id, model_id) REFERENCES provider_model_manifests(provider_connection_id, model_id)
  )`,
  `CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE agent_drivers (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id)
  )`,
  `CREATE TABLE agent_driver_launch_profiles (
    id TEXT PRIMARY KEY,
    agent_driver_id TEXT NOT NULL REFERENCES agent_drivers(id)
  )`,
  `CREATE TABLE agent_driver_permission_mediations (
    id TEXT PRIMARY KEY,
    agent_driver_id TEXT NOT NULL REFERENCES agent_drivers(id),
    normalized_decision TEXT NOT NULL CHECK (normalized_decision IN ('allow-once', 'deny')),
    guaranteed_disposition TEXT NOT NULL CHECK (guaranteed_disposition IN ('allow-once', 'deny-once')),
    guarantee TEXT NOT NULL CHECK (guarantee = 'one-tool-invocation'),
    UNIQUE (id, normalized_decision),
    CHECK ((normalized_decision = 'allow-once' AND guaranteed_disposition = 'allow-once') OR (normalized_decision = 'deny' AND guaranteed_disposition = 'deny-once'))
  )`,
  `CREATE TABLE agent_profile_revisions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    driver_id TEXT NOT NULL REFERENCES agent_drivers(id),
    display_name TEXT NOT NULL,
    default_provider_id TEXT NOT NULL REFERENCES providers(id),
    default_model_id TEXT NOT NULL REFERENCES models(id),
    default_reasoning_kind TEXT NOT NULL CHECK (default_reasoning_kind = 'agent-default'),
    default_reasoning_effort TEXT CHECK (default_reasoning_effort IS NULL),
    skills_mode TEXT NOT NULL CHECK (skills_mode = 'pinned'),
    prompt_templates_mode TEXT NOT NULL CHECK (prompt_templates_mode = 'pinned'),
    themes_mode TEXT NOT NULL CHECK (themes_mode = 'pinned'),
    project_resources_mode TEXT NOT NULL CHECK (project_resources_mode = 'disabled'),
    extensions_mode TEXT NOT NULL CHECK (extensions_mode = 'granted-only'),
    extension_discovery TEXT NOT NULL CHECK (extension_discovery = 'explicit-only'),
    extension_hot_reload INTEGER NOT NULL CHECK (extension_hot_reload = 0),
    extension_prompt_lifecycle TEXT NOT NULL CHECK (extension_prompt_lifecycle = 'agent-loop-preserving'),
    configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
    created_at TEXT NOT NULL,
    UNIQUE (profile_id, revision)
  )`,
  `CREATE TABLE agent_profile_provider_allowances (
    agent_profile_revision_id TEXT NOT NULL REFERENCES agent_profile_revisions(id),
    provider_id TEXT NOT NULL REFERENCES providers(id),
    provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id),
    models_kind TEXT NOT NULL CHECK (models_kind = 'allowlist'),
    PRIMARY KEY (agent_profile_revision_id, provider_id),
    UNIQUE (agent_profile_revision_id, provider_connection_id),
    UNIQUE (agent_profile_revision_id),
    FOREIGN KEY (provider_connection_id, provider_id) REFERENCES provider_connections(id, provider_id)
  )`,
  `CREATE TABLE agent_profile_allowance_models (
    agent_profile_revision_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    PRIMARY KEY (agent_profile_revision_id, provider_id, model_id),
    UNIQUE (agent_profile_revision_id, provider_id),
    FOREIGN KEY (agent_profile_revision_id, provider_id) REFERENCES agent_profile_provider_allowances(agent_profile_revision_id, provider_id),
    FOREIGN KEY (model_id, provider_id) REFERENCES models(id, provider_id)
  )`,
  `CREATE TABLE agent_resource_snapshots (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('skill', 'prompt-template', 'theme')),
    source_kind TEXT NOT NULL CHECK (source_kind = 'profile'),
    display_name TEXT NOT NULL,
    integrity_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    reference TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, reference)
  )`,
  `CREATE TABLE extension_revisions (
    id TEXT PRIMARY KEY,
    extension_id TEXT NOT NULL REFERENCES extensions(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    display_name TEXT NOT NULL,
    integrity_digest TEXT NOT NULL,
    configuration_schema_json TEXT NOT NULL CHECK (json_valid(configuration_schema_json)),
    created_at TEXT NOT NULL,
    UNIQUE (extension_id, revision)
  )`,
  `CREATE TABLE extension_grant_snapshots (
    id TEXT PRIMARY KEY,
    extension_id TEXT NOT NULL REFERENCES extensions(id),
    extension_revision_id TEXT NOT NULL REFERENCES extension_revisions(id),
    integrity_digest TEXT NOT NULL,
    loading TEXT NOT NULL CHECK (loading = 'explicit-pinned'),
    configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
    prompt_lifecycle TEXT NOT NULL CHECK (prompt_lifecycle = 'agent-loop-preserving'),
    created_at TEXT NOT NULL,
    UNIQUE (extension_revision_id)
  )`,
  `CREATE TABLE extension_capabilities (
    id TEXT PRIMARY KEY
  )`,
  `CREATE TABLE extension_grant_capabilities (
    extension_grant_snapshot_id TEXT NOT NULL REFERENCES extension_grant_snapshots(id),
    extension_capability_id TEXT NOT NULL REFERENCES extension_capabilities(id),
    PRIMARY KEY (extension_grant_snapshot_id, extension_capability_id)
  )`,
  `CREATE TABLE agent_profile_resource_snapshots (
    agent_profile_revision_id TEXT NOT NULL REFERENCES agent_profile_revisions(id),
    agent_resource_snapshot_id TEXT NOT NULL REFERENCES agent_resource_snapshots(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (agent_profile_revision_id, agent_resource_snapshot_id),
    UNIQUE (agent_profile_revision_id, ordinal)
  )`,
  `CREATE TABLE agent_profile_extension_grants (
    agent_profile_revision_id TEXT NOT NULL REFERENCES agent_profile_revisions(id),
    extension_grant_snapshot_id TEXT NOT NULL REFERENCES extension_grant_snapshots(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (agent_profile_revision_id, extension_grant_snapshot_id),
    UNIQUE (agent_profile_revision_id, ordinal)
  )`,
  `CREATE TABLE workspace_reference_bindings (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
    workspace_revision_id TEXT NOT NULL REFERENCES workspace_revisions(id),
    installation_id TEXT NOT NULL REFERENCES installations(id),
    binding_reference TEXT NOT NULL,
    UNIQUE (installation_id, binding_reference)
  )`,
  `CREATE TABLE agent_resource_artifact_bindings (
    agent_resource_snapshot_id TEXT PRIMARY KEY REFERENCES agent_resource_snapshots(id),
    artifact_reference TEXT NOT NULL UNIQUE,
    integrity_digest TEXT NOT NULL
  )`,
  `CREATE TABLE extension_artifact_bindings (
    extension_revision_id TEXT PRIMARY KEY REFERENCES extension_revisions(id),
    artifact_reference TEXT NOT NULL UNIQUE,
    integrity_digest TEXT NOT NULL
  )`,
  `CREATE TABLE provider_artifact_bindings (
    provider_connection_id TEXT PRIMARY KEY REFERENCES provider_connections(id),
    bridge_id TEXT NOT NULL,
    bridge_artifact_digest TEXT NOT NULL,
    native_stack TEXT NOT NULL,
    native_stack_version TEXT NOT NULL,
    native_stack_digest TEXT NOT NULL,
    native_catalog_digest TEXT NOT NULL
  )`,
  `CREATE TABLE session_specs (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    agent_profile_revision_id TEXT NOT NULL REFERENCES agent_profile_revisions(id),
    workspace_revision_id TEXT NOT NULL REFERENCES workspace_revisions(id),
    execution_policy_snapshot_id TEXT NOT NULL REFERENCES execution_policy_snapshots(id),
    turn_policy_snapshot_id TEXT NOT NULL REFERENCES turn_policy_snapshots(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE session_spec_resource_snapshots (
    session_spec_id TEXT NOT NULL REFERENCES session_specs(id),
    agent_resource_snapshot_id TEXT NOT NULL REFERENCES agent_resource_snapshots(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (session_spec_id, agent_resource_snapshot_id),
    UNIQUE (session_spec_id, ordinal)
  )`,
  `CREATE TABLE session_spec_extension_grants (
    session_spec_id TEXT NOT NULL REFERENCES session_specs(id),
    extension_grant_snapshot_id TEXT NOT NULL REFERENCES extension_grant_snapshots(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (session_spec_id, extension_grant_snapshot_id),
    UNIQUE (session_spec_id, ordinal)
  )`,
  `CREATE TABLE session_spec_provider_bindings (
    session_spec_id TEXT NOT NULL REFERENCES session_specs(id),
    provider_id TEXT NOT NULL REFERENCES providers(id),
    provider_connection_id TEXT NOT NULL,
    credential_binding_id TEXT NOT NULL,
    PRIMARY KEY (session_spec_id, provider_id),
    UNIQUE (session_spec_id, provider_connection_id),
    UNIQUE (session_spec_id),
    FOREIGN KEY (provider_connection_id, provider_id) REFERENCES provider_connections(id, provider_id),
    FOREIGN KEY (credential_binding_id, provider_id) REFERENCES provider_credential_bindings(id, provider_id)
  )`,
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    owner_principal_id TEXT NOT NULL REFERENCES principals(id),
    spec_id TEXT NOT NULL REFERENCES session_specs(id),
    created_at TEXT NOT NULL,
    UNIQUE (id, owner_principal_id)
  )`,
  `CREATE TABLE session_metadata (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    display_name TEXT,
    labels_json TEXT NOT NULL CHECK (json_valid(labels_json)),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE session_lifecycle (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'archived')),
    blocked_reason TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((status = 'blocked' AND blocked_reason IS NOT NULL) OR (status <> 'blocked' AND blocked_reason IS NULL))
  )`,
  `CREATE TABLE session_runtime_state (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id),
    status TEXT NOT NULL CHECK (status IN ('idle', 'starting', 'running', 'waiting', 'stopping', 'error')),
    active_turn_id TEXT,
    worker_lease_id TEXT,
    agent_resume_handle_id TEXT,
    last_activity_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (active_turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (worker_lease_id, session_id) REFERENCES worker_leases(id, session_id),
    FOREIGN KEY (agent_resume_handle_id, session_id) REFERENCES agent_resume_handles(id, session_id)
  )`,
  `CREATE TABLE session_endpoint_bindings (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'private'),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
    state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
    suspended_at TEXT,
    suspended_actor_kind TEXT,
    suspended_actor_principal_id TEXT REFERENCES principals(id),
    suspended_actor_system_component TEXT CHECK (suspended_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    suspended_reason TEXT,
    revoked_at TEXT,
    revoked_actor_kind TEXT,
    revoked_actor_principal_id TEXT REFERENCES principals(id),
    revoked_actor_system_component TEXT CHECK (revoked_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((state = 'active' AND suspended_at IS NULL AND suspended_actor_kind IS NULL AND suspended_actor_principal_id IS NULL AND suspended_actor_system_component IS NULL AND suspended_reason IS NULL AND revoked_at IS NULL AND revoked_actor_kind IS NULL AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (state = 'suspended' AND suspended_at IS NOT NULL AND suspended_reason IS NOT NULL AND ((suspended_actor_kind = 'bootstrap' AND suspended_actor_principal_id IS NULL AND suspended_actor_system_component IS NULL) OR (suspended_actor_kind = 'principal' AND suspended_actor_principal_id IS NOT NULL AND suspended_actor_system_component IS NULL) OR (suspended_actor_kind = 'system' AND suspended_actor_principal_id IS NULL AND suspended_actor_system_component IS NOT NULL)) AND revoked_at IS NULL AND revoked_actor_kind IS NULL AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (state = 'revoked' AND suspended_at IS NULL AND suspended_actor_kind IS NULL AND suspended_actor_principal_id IS NULL AND suspended_actor_system_component IS NULL AND suspended_reason IS NULL AND revoked_at IS NOT NULL AND ((revoked_actor_kind = 'bootstrap' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'principal' AND revoked_actor_principal_id IS NOT NULL AND revoked_actor_system_component IS NULL) OR (revoked_actor_kind = 'system' AND revoked_actor_principal_id IS NULL AND revoked_actor_system_component IS NOT NULL)))),
    UNIQUE (session_id, endpoint_id),
    UNIQUE (id, session_id, endpoint_id),
    FOREIGN KEY (session_id, created_by_principal_id) REFERENCES sessions(id, owner_principal_id),
    FOREIGN KEY (endpoint_id, created_by_principal_id) REFERENCES endpoints(id, audience_principal_id)
  )`,
  `CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    media_type TEXT NOT NULL CHECK (media_type = 'image'),
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0),
    integrity_digest TEXT NOT NULL,
    blob_id TEXT NOT NULL UNIQUE REFERENCES private_blobs(id),
    admitted_from_kind TEXT NOT NULL CHECK (admitted_from_kind = 'local-cli'),
    authentication_request_id TEXT NOT NULL REFERENCES authentication_requests(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE turn_input_snapshots (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE turn_input_blocks (
    turn_input_snapshot_id TEXT NOT NULL REFERENCES turn_input_snapshots(id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'attachment')),
    text_content TEXT,
    attachment_id TEXT REFERENCES attachments(id),
    media_type TEXT CHECK (media_type = 'image'),
    mime_type TEXT,
    display_name TEXT,
    PRIMARY KEY (turn_input_snapshot_id, ordinal),
    CHECK ((kind = 'text' AND text_content IS NOT NULL AND attachment_id IS NULL AND media_type IS NULL AND mime_type IS NULL AND display_name IS NULL) OR (kind = 'attachment' AND text_content IS NULL AND attachment_id IS NOT NULL AND media_type = 'image' AND mime_type IS NOT NULL))
  )`,
  `CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    requester_principal_id TEXT NOT NULL REFERENCES principals(id),
    requester_identity_binding_id TEXT NOT NULL,
    authentication_request_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
    endpoint_binding_id TEXT NOT NULL,
    origin_message_id TEXT NOT NULL,
    input_snapshot_id TEXT NOT NULL UNIQUE REFERENCES turn_input_snapshots(id),
    turn_policy_snapshot_id TEXT NOT NULL REFERENCES turn_policy_snapshots(id),
    model_selection_kind TEXT NOT NULL CHECK (model_selection_kind = 'resolved'),
    selected_provider_id TEXT NOT NULL REFERENCES providers(id),
    selected_model_id TEXT NOT NULL,
    reasoning_kind TEXT NOT NULL CHECK (reasoning_kind = 'agent-default'),
    reasoning_effort TEXT CHECK (reasoning_effort IS NULL),
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (id, session_id),
    UNIQUE (id, requester_principal_id),
    UNIQUE (endpoint_id, idempotency_key),
    UNIQUE (endpoint_id, origin_message_id),
    FOREIGN KEY (session_id, requester_principal_id) REFERENCES sessions(id, owner_principal_id),
    FOREIGN KEY (requester_identity_binding_id, requester_principal_id) REFERENCES identity_bindings(id, principal_id),
    FOREIGN KEY (authentication_request_id, requester_principal_id, requester_identity_binding_id) REFERENCES authentication_requests(id, principal_id, identity_binding_id),
    FOREIGN KEY (endpoint_id, requester_principal_id) REFERENCES endpoints(id, audience_principal_id),
    FOREIGN KEY (endpoint_binding_id, session_id, endpoint_id) REFERENCES session_endpoint_bindings(id, session_id, endpoint_id),
    FOREIGN KEY (selected_model_id, selected_provider_id) REFERENCES models(id, provider_id)
  )`,
  `CREATE TABLE turn_inference_resolutions (
    turn_id TEXT PRIMARY KEY REFERENCES turns(id),
    provider_id TEXT NOT NULL REFERENCES providers(id),
    model_id TEXT NOT NULL,
    reasoning_kind TEXT NOT NULL CHECK (reasoning_kind = 'agent-default'),
    reasoning_effort TEXT CHECK (reasoning_effort IS NULL),
    resolved_by TEXT NOT NULL CHECK (resolved_by = 'hitch'),
    resolved_at TEXT NOT NULL,
    FOREIGN KEY (model_id, provider_id) REFERENCES models(id, provider_id)
  )`,
  `CREATE TABLE principal_execution_capacity (
    principal_id TEXT PRIMARY KEY REFERENCES principals(id),
    next_admission_ordinal INTEGER NOT NULL CHECK (next_admission_ordinal >= 0),
    active_turn_id TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (active_turn_id),
    FOREIGN KEY (active_turn_id, principal_id) REFERENCES turns(id, requester_principal_id)
  )`,
  `CREATE TABLE turn_queue_entries (
    principal_id TEXT NOT NULL REFERENCES principals(id),
    turn_id TEXT NOT NULL UNIQUE,
    admission_ordinal INTEGER NOT NULL CHECK (admission_ordinal >= 0),
    enqueued_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, admission_ordinal),
    FOREIGN KEY (turn_id, principal_id) REFERENCES turns(id, requester_principal_id)
  )`,
  `CREATE TABLE agent_dispatch_attempts (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    state TEXT NOT NULL CHECK (state IN ('dispatching', 'submission-armed', 'submitted-unconfirmed', 'accepted', 'running', 'waiting-for-approval', 'waiting-for-input', 'cancelling', 'terminal')),
    worker_lease_id TEXT REFERENCES worker_leases(id),
    worker_fencing_token INTEGER,
    started_at TEXT NOT NULL,
    armed_at TEXT,
    submitted_at TEXT,
    accepted_at TEXT,
    completed_at TEXT,
    submission_outcome TEXT CHECK (submission_outcome IN ('submitted', 'definitely-not-submitted', 'unknown')),
    acceptance_evidence_json TEXT CHECK (acceptance_evidence_json IS NULL OR json_valid(acceptance_evidence_json)),
    UNIQUE (turn_id, attempt_number),
    UNIQUE (id, turn_id, session_id),
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token),
    CHECK ((worker_lease_id IS NULL AND worker_fencing_token IS NULL) OR (worker_lease_id IS NOT NULL AND worker_fencing_token > 0)),
    CHECK ((state = 'dispatching' AND armed_at IS NULL AND submitted_at IS NULL AND accepted_at IS NULL AND completed_at IS NULL AND submission_outcome IS NULL AND acceptance_evidence_json IS NULL) OR (state = 'submission-armed' AND armed_at IS NOT NULL AND submitted_at IS NULL AND accepted_at IS NULL AND completed_at IS NULL AND submission_outcome IS NULL AND acceptance_evidence_json IS NULL) OR (state = 'submitted-unconfirmed' AND armed_at IS NOT NULL AND submitted_at IS NOT NULL AND accepted_at IS NULL AND completed_at IS NULL AND submission_outcome IN ('submitted', 'unknown') AND acceptance_evidence_json IS NULL) OR (state IN ('accepted', 'running', 'waiting-for-approval', 'waiting-for-input', 'cancelling') AND armed_at IS NOT NULL AND submitted_at IS NOT NULL AND accepted_at IS NOT NULL AND completed_at IS NULL AND submission_outcome = 'submitted' AND acceptance_evidence_json IS NOT NULL) OR (state = 'terminal' AND completed_at IS NOT NULL)),
    CHECK ((armed_at IS NULL AND submitted_at IS NULL AND accepted_at IS NULL AND submission_outcome IS NULL AND acceptance_evidence_json IS NULL) OR (armed_at IS NOT NULL AND submitted_at IS NULL AND accepted_at IS NULL AND (submission_outcome IS NULL OR submission_outcome = 'definitely-not-submitted') AND acceptance_evidence_json IS NULL) OR (armed_at IS NOT NULL AND submitted_at IS NOT NULL AND accepted_at IS NULL AND submission_outcome IN ('submitted', 'unknown') AND acceptance_evidence_json IS NULL) OR (armed_at IS NOT NULL AND submitted_at IS NOT NULL AND accepted_at IS NOT NULL AND submission_outcome = 'submitted' AND acceptance_evidence_json IS NOT NULL)),
    CHECK ((accepted_at IS NULL AND acceptance_evidence_json IS NULL) OR (accepted_at IS NOT NULL AND acceptance_evidence_json IS NOT NULL))
  )`,
  `CREATE TABLE turn_runtime_states (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'dispatching', 'submission-armed', 'submitted-unconfirmed', 'accepted', 'running', 'waiting-for-approval', 'waiting-for-input', 'cancelling', 'terminal')),
    attempt_id TEXT,
    interaction_id TEXT,
    interaction_kind TEXT CHECK (interaction_kind IN ('approval', 'input')),
    requested_at TEXT,
    requested_actor_kind TEXT,
    requested_actor_principal_id TEXT REFERENCES principals(id),
    requested_actor_system_component TEXT CHECK (requested_actor_system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    cancellation_reason TEXT CHECK (cancellation_reason IN ('withdrawn-by-requester', 'cancelled-by-controller', 'authority-revoked', 'configuration-authority-revoked', 'credential-revoked', 'binding-revoked', 'unsafe-agent-permission-options', 'session-stopped', 'shutdown')),
    completed_at TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    partial_output_available INTEGER,
    updated_at TEXT NOT NULL,
    UNIQUE (turn_id, session_id),
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (attempt_id, turn_id, session_id) REFERENCES agent_dispatch_attempts(id, turn_id, session_id),
    FOREIGN KEY (interaction_id, turn_id, interaction_kind) REFERENCES turn_interactions(id, turn_id, kind),
    CHECK ((status = 'queued' AND attempt_id IS NULL AND interaction_id IS NULL AND interaction_kind IS NULL AND requested_at IS NULL AND requested_actor_kind IS NULL AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL AND cancellation_reason IS NULL) OR (status IN ('dispatching', 'submission-armed', 'submitted-unconfirmed', 'accepted', 'running') AND attempt_id IS NOT NULL AND interaction_id IS NULL AND interaction_kind IS NULL AND requested_at IS NULL AND requested_actor_kind IS NULL AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL AND cancellation_reason IS NULL) OR (status = 'waiting-for-approval' AND attempt_id IS NOT NULL AND interaction_id IS NOT NULL AND interaction_kind = 'approval' AND requested_at IS NULL AND requested_actor_kind IS NULL AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL AND cancellation_reason IS NULL) OR (status = 'waiting-for-input' AND attempt_id IS NOT NULL AND interaction_id IS NOT NULL AND interaction_kind = 'input' AND requested_at IS NULL AND requested_actor_kind IS NULL AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL AND cancellation_reason IS NULL) OR (status = 'cancelling' AND attempt_id IS NOT NULL AND interaction_id IS NULL AND interaction_kind IS NULL AND requested_at IS NOT NULL AND requested_actor_kind IS NOT NULL AND cancellation_reason IS NOT NULL) OR (status = 'terminal' AND interaction_id IS NULL AND interaction_kind IS NULL AND requested_at IS NULL AND requested_actor_kind IS NULL AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL AND cancellation_reason IS NULL)),
    CHECK ((requested_actor_kind IS NULL AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL) OR (requested_actor_kind = 'bootstrap' AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NULL) OR (requested_actor_kind = 'principal' AND requested_actor_principal_id IS NOT NULL AND requested_actor_system_component IS NULL) OR (requested_actor_kind = 'system' AND requested_actor_principal_id IS NULL AND requested_actor_system_component IS NOT NULL)),
    CHECK ((status = 'terminal' AND completed_at IS NOT NULL AND result_json IS NOT NULL AND partial_output_available IN (0, 1)) OR (status <> 'terminal' AND completed_at IS NULL AND result_json IS NULL AND partial_output_available IS NULL))
  )`,
  `CREATE TABLE turn_events (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    visibility TEXT NOT NULL CHECK (visibility IN ('internal', 'requester')),
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('state-transition', 'prompt-accepted', 'inference-resolved', 'user-message-recorded', 'agent-message-finalized', 'tool-invocation-finalized', 'interaction-requested', 'interaction-resolved', 'usage-finalized', 'terminal')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    UNIQUE (turn_id, sequence)
  )`,
  `CREATE TABLE turn_messages (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    protocol_message_id TEXT,
    state TEXT NOT NULL CHECK (state = 'finalized'),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    finalized_at TEXT NOT NULL,
    UNIQUE (id, turn_id),
    UNIQUE (turn_id, sequence),
    UNIQUE (turn_id, protocol_message_id)
  )`,
  `CREATE TABLE tool_invocations (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    protocol_tool_call_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in-progress', 'completed', 'failed', 'cancelled')),
    sanitized_summary TEXT,
    updated_at TEXT NOT NULL,
    finalized_at TEXT,
    CHECK ((status IN ('pending', 'in-progress') AND finalized_at IS NULL) OR (status IN ('completed', 'failed', 'cancelled') AND finalized_at IS NOT NULL)),
    UNIQUE (turn_id, protocol_tool_call_id)
  )`,
  `CREATE TABLE turn_interactions (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    protocol_interaction_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('approval', 'input')),
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved')),
    resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
    resolved_at TEXT,
    UNIQUE (turn_id, protocol_interaction_id),
    UNIQUE (id, turn_id),
    UNIQUE (id, kind),
    UNIQUE (id, turn_id, kind),
    CHECK ((state = 'pending' AND resolution_json IS NULL AND resolved_at IS NULL) OR (state = 'resolved' AND resolution_json IS NOT NULL AND resolved_at IS NOT NULL))
  )`,
  `CREATE TABLE turn_interaction_advertised_options (
    turn_interaction_id TEXT NOT NULL,
    interaction_kind TEXT NOT NULL CHECK (interaction_kind = 'approval'),
    protocol_option_id TEXT NOT NULL,
    protocol_kind TEXT NOT NULL,
    sanitized_label TEXT NOT NULL,
    advertised_disposition TEXT NOT NULL CHECK (advertised_disposition IN ('allow-once', 'allow-persistent', 'deny-once', 'deny-persistent', 'unknown')),
    PRIMARY KEY (turn_interaction_id, protocol_option_id),
    UNIQUE (turn_interaction_id, protocol_option_id, advertised_disposition),
    UNIQUE (turn_interaction_id, interaction_kind, protocol_option_id, advertised_disposition),
    FOREIGN KEY (turn_interaction_id, interaction_kind) REFERENCES turn_interactions(id, kind)
  )`,
  `CREATE TABLE turn_interaction_options (
    id TEXT PRIMARY KEY,
    turn_interaction_id TEXT NOT NULL,
    interaction_kind TEXT NOT NULL CHECK (interaction_kind = 'approval'),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    sanitized_label TEXT NOT NULL,
    normalized_decision TEXT NOT NULL CHECK (normalized_decision IN ('allow-once', 'deny')),
    response_kind TEXT NOT NULL CHECK (response_kind IN ('select-advertised-option', 'driver-mediated')),
    protocol_option_id TEXT,
    protocol_option_disposition TEXT CHECK (protocol_option_disposition IN ('allow-once', 'deny-once')),
    mediation_id TEXT REFERENCES agent_driver_permission_mediations(id),
    UNIQUE (turn_interaction_id, ordinal),
    FOREIGN KEY (turn_interaction_id, interaction_kind) REFERENCES turn_interactions(id, kind),
    FOREIGN KEY (turn_interaction_id, interaction_kind, protocol_option_id, protocol_option_disposition) REFERENCES turn_interaction_advertised_options(turn_interaction_id, interaction_kind, protocol_option_id, advertised_disposition),
    FOREIGN KEY (mediation_id, normalized_decision) REFERENCES agent_driver_permission_mediations(id, normalized_decision),
    CHECK ((response_kind = 'select-advertised-option' AND protocol_option_id IS NOT NULL AND protocol_option_disposition IS NOT NULL AND mediation_id IS NULL) OR (response_kind = 'driver-mediated' AND protocol_option_id IS NULL AND protocol_option_disposition IS NULL AND mediation_id IS NOT NULL)),
    CHECK ((normalized_decision = 'allow-once' AND (protocol_option_disposition IS NULL OR protocol_option_disposition = 'allow-once')) OR (normalized_decision = 'deny' AND (protocol_option_disposition IS NULL OR protocol_option_disposition = 'deny-once')))
  )`,
  `CREATE TABLE interaction_response_dispatches (
    id TEXT PRIMARY KEY,
    interaction_id TEXT NOT NULL UNIQUE,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    worker_fencing_token INTEGER NOT NULL CHECK (worker_fencing_token > 0),
    state TEXT NOT NULL CHECK (state IN ('ready', 'send-started', 'delivered', 'outcome-unknown')),
    started_at TEXT,
    delivered_at TEXT,
    observed_at TEXT,
    unknown_reason TEXT CHECK (unknown_reason IN ('driver-disconnected', 'worker-lost')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (interaction_id, turn_id) REFERENCES turn_interactions(id, turn_id),
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (attempt_id, turn_id, session_id) REFERENCES agent_dispatch_attempts(id, turn_id, session_id),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token),
    CHECK ((state = 'ready' AND started_at IS NULL AND delivered_at IS NULL AND observed_at IS NULL AND unknown_reason IS NULL) OR (state = 'send-started' AND started_at IS NOT NULL AND delivered_at IS NULL AND observed_at IS NULL AND unknown_reason IS NULL) OR (state = 'delivered' AND started_at IS NOT NULL AND delivered_at IS NOT NULL AND observed_at IS NULL AND unknown_reason IS NULL) OR (state = 'outcome-unknown' AND started_at IS NOT NULL AND delivered_at IS NULL AND observed_at IS NOT NULL AND unknown_reason IS NOT NULL))
  )`,
  `CREATE TABLE worker_leases (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired', 'revoked')),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, fencing_token),
    UNIQUE (id, session_id),
    UNIQUE (id, session_id, fencing_token),
    CHECK ((state = 'active' AND ended_at IS NULL AND end_reason IS NULL) OR (state <> 'active' AND ended_at IS NOT NULL AND end_reason IS NOT NULL))
  )`,
  `CREATE TABLE credential_leases (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    worker_lease_id TEXT NOT NULL,
    worker_fencing_token INTEGER NOT NULL CHECK (worker_fencing_token > 0),
    credential_binding_id TEXT NOT NULL,
    provider_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    transport_mode TEXT NOT NULL CHECK (transport_mode = 'native-library-sidecar'),
    allowed_models_json TEXT NOT NULL CHECK (json_valid(allowed_models_json)),
    state TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired', 'revoked')),
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (id, session_id, worker_lease_id, worker_fencing_token, provider_connection_id, provider_id),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token),
    FOREIGN KEY (credential_binding_id, provider_id) REFERENCES provider_credential_bindings(id, provider_id),
    FOREIGN KEY (provider_connection_id, provider_id) REFERENCES provider_connections(id, provider_id),
    CHECK ((state = 'active' AND ended_at IS NULL AND end_reason IS NULL) OR (state <> 'active' AND ended_at IS NOT NULL AND end_reason IS NOT NULL))
  )`,
  `CREATE TABLE agent_resume_handles (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    worker_fencing_token INTEGER NOT NULL CHECK (worker_fencing_token > 0),
    driver_id TEXT NOT NULL REFERENCES agent_drivers(id),
    protected_blob_id TEXT NOT NULL UNIQUE REFERENCES private_blobs(id),
    integrity_digest TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
    retired_at TEXT,
    retired_reason TEXT CHECK (retired_reason IN ('consumed', 'expired', 'lease-ended', 'replaced', 'recovery-terminal')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (id, session_id),
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (attempt_id, turn_id, session_id) REFERENCES agent_dispatch_attempts(id, turn_id, session_id),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token),
    CHECK ((state = 'active' AND retired_at IS NULL AND retired_reason IS NULL) OR (state = 'retired' AND retired_at IS NOT NULL AND retired_reason IS NOT NULL))
  )`,
  `CREATE TABLE turn_recovery_records (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    worker_fencing_token INTEGER NOT NULL CHECK (worker_fencing_token > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('retry-authorized', 'resumed', 'reconciled-live', 'reconciled-terminal', 'terminal-unknown')),
    previous_lifecycle_status TEXT NOT NULL CHECK (previous_lifecycle_status IN ('dispatching', 'submission-armed', 'submitted-unconfirmed', 'accepted', 'running', 'waiting-for-approval', 'waiting-for-input', 'cancelling')),
    recovery_json TEXT NOT NULL CHECK (json_valid(recovery_json)),
    recovered_at TEXT NOT NULL,
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (attempt_id, turn_id, session_id) REFERENCES agent_dispatch_attempts(id, turn_id, session_id),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token)
  )`,
  `CREATE TABLE turn_inference_usage_ledgers (
    turn_id TEXT PRIMARY KEY REFERENCES turns(id),
    held_requests INTEGER NOT NULL CHECK (held_requests >= 0),
    consumed_requests INTEGER NOT NULL CHECK (consumed_requests >= 0),
    held_tokens INTEGER NOT NULL CHECK (held_tokens >= 0),
    charged_tokens INTEGER NOT NULL CHECK (charged_tokens >= 0),
    in_flight_requests INTEGER NOT NULL CHECK (in_flight_requests >= 0),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE inference_request_reservations (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    worker_fencing_token INTEGER NOT NULL CHECK (worker_fencing_token > 0),
    credential_lease_id TEXT NOT NULL,
    provider_connection_id TEXT NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers(id),
    model_id TEXT NOT NULL,
    reasoning_kind TEXT NOT NULL CHECK (reasoning_kind = 'agent-default'),
    reasoning_effort TEXT CHECK (reasoning_effort IS NULL),
    request_fingerprint TEXT NOT NULL,
    reserved_input_tokens INTEGER NOT NULL CHECK (reserved_input_tokens >= 0),
    reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens > 0),
    reserved_total_tokens INTEGER NOT NULL CHECK (reserved_total_tokens > 0),
    authorized_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('authorized', 'forwarding', 'settled', 'charged-reservation', 'released')),
    forwarding_attempt_id TEXT REFERENCES inference_forwarding_attempts(id),
    forwarding_at TEXT,
    settled_at TEXT,
    usage_input_tokens INTEGER,
    usage_output_tokens INTEGER,
    usage_total_tokens INTEGER,
    ended_at TEXT,
    end_reason TEXT CHECK (end_reason IN ('usage-unavailable', 'broker-recovery', 'cancelled-after-forward', 'not-forwarded')),
    updated_at TEXT NOT NULL,
    UNIQUE (id, session_id, worker_lease_id, worker_fencing_token),
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token),
    FOREIGN KEY (credential_lease_id, session_id, worker_lease_id, worker_fencing_token, provider_connection_id, provider_id) REFERENCES credential_leases(id, session_id, worker_lease_id, worker_fencing_token, provider_connection_id, provider_id),
    FOREIGN KEY (provider_connection_id, provider_id) REFERENCES provider_connections(id, provider_id),
    FOREIGN KEY (model_id, provider_id) REFERENCES models(id, provider_id),
    FOREIGN KEY (forwarding_attempt_id, id) REFERENCES inference_forwarding_attempts(id, reservation_id),
    CHECK (reserved_total_tokens = reserved_input_tokens + reserved_output_tokens),
    CHECK ((usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_total_tokens IS NULL) OR (usage_input_tokens >= 0 AND usage_output_tokens >= 0 AND usage_total_tokens = usage_input_tokens + usage_output_tokens)),
    CHECK ((state = 'authorized' AND forwarding_attempt_id IS NULL AND forwarding_at IS NULL AND settled_at IS NULL AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_total_tokens IS NULL AND ended_at IS NULL AND end_reason IS NULL) OR (state = 'forwarding' AND forwarding_attempt_id IS NOT NULL AND forwarding_at IS NOT NULL AND settled_at IS NULL AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_total_tokens IS NULL AND ended_at IS NULL AND end_reason IS NULL) OR (state = 'settled' AND forwarding_attempt_id IS NOT NULL AND forwarding_at IS NOT NULL AND settled_at IS NOT NULL AND usage_input_tokens IS NOT NULL AND usage_output_tokens IS NOT NULL AND usage_total_tokens IS NOT NULL AND ended_at IS NULL AND end_reason IS NULL) OR (state = 'charged-reservation' AND forwarding_attempt_id IS NOT NULL AND forwarding_at IS NOT NULL AND settled_at IS NULL AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_total_tokens IS NULL AND ended_at IS NOT NULL AND end_reason IN ('usage-unavailable', 'broker-recovery', 'cancelled-after-forward')) OR (state = 'released' AND forwarding_attempt_id IS NULL AND forwarding_at IS NULL AND settled_at IS NULL AND usage_input_tokens IS NULL AND usage_output_tokens IS NULL AND usage_total_tokens IS NULL AND ended_at IS NOT NULL AND end_reason = 'not-forwarded')),
    UNIQUE (turn_id, provider_connection_id, request_fingerprint)
  )`,
  `CREATE TABLE inference_forwarding_attempts (
    id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL UNIQUE REFERENCES inference_request_reservations(id),
    session_id TEXT NOT NULL,
    worker_lease_id TEXT NOT NULL,
    worker_fencing_token INTEGER NOT NULL CHECK (worker_fencing_token > 0),
    created_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready-for-one-send', 'send-started', 'send-completed', 'outcome-unknown')),
    started_at TEXT,
    completed_at TEXT,
    observed_at TEXT,
    unknown_reason TEXT CHECK (unknown_reason IN ('broker-recovery', 'sidecar-disconnected')),
    updated_at TEXT NOT NULL,
    UNIQUE (id, reservation_id),
    FOREIGN KEY (reservation_id, session_id, worker_lease_id, worker_fencing_token) REFERENCES inference_request_reservations(id, session_id, worker_lease_id, worker_fencing_token),
    FOREIGN KEY (worker_lease_id, session_id, worker_fencing_token) REFERENCES worker_leases(id, session_id, fencing_token),
    CHECK ((state = 'ready-for-one-send' AND started_at IS NULL AND completed_at IS NULL AND observed_at IS NULL AND unknown_reason IS NULL) OR (state = 'send-started' AND started_at IS NOT NULL AND completed_at IS NULL AND observed_at IS NULL AND unknown_reason IS NULL) OR (state = 'send-completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND observed_at IS NULL AND unknown_reason IS NULL) OR (state = 'outcome-unknown' AND started_at IS NOT NULL AND observed_at IS NOT NULL AND unknown_reason IS NOT NULL))
  )`,
  `CREATE TABLE turn_terminal_responses (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    partial_output_available INTEGER NOT NULL CHECK (partial_output_available IN (0, 1)),
    finalized_at TEXT NOT NULL,
    UNIQUE (id, turn_id)
  )`,
  `CREATE TABLE turn_terminal_response_messages (
    terminal_response_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    turn_message_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    PRIMARY KEY (terminal_response_id, turn_message_id),
    UNIQUE (terminal_response_id, sequence),
    FOREIGN KEY (terminal_response_id, turn_id) REFERENCES turn_terminal_responses(id, turn_id),
    FOREIGN KEY (turn_message_id, turn_id) REFERENCES turn_messages(id, turn_id)
  )`,
  `CREATE TABLE turn_response_deliveries (
    id TEXT PRIMARY KEY,
    terminal_response_id TEXT NOT NULL UNIQUE,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    endpoint_binding_id TEXT NOT NULL,
    recipient_principal_id TEXT NOT NULL REFERENCES principals(id),
    deadline_at TEXT NOT NULL,
    maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts > 0),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'retryable-failure', 'failed', 'suppressed', 'expired')),
    current_attempt_id TEXT,
    started_at TEXT,
    delivered_at TEXT,
    failed_at TEXT,
    suppressed_at TEXT,
    expired_at TEXT,
    next_attempt_at TEXT,
    reason TEXT CHECK (reason IN ('client-disconnected', 'transport-unavailable', 'send-failed', 'maximum-attempts-reached', 'delivery-deadline-elapsed', 'binding-inactive', 'recipient-no-longer-authorized')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (terminal_response_id, turn_id) REFERENCES turn_terminal_responses(id, turn_id),
    FOREIGN KEY (turn_id, session_id) REFERENCES turns(id, session_id),
    FOREIGN KEY (endpoint_binding_id, session_id, endpoint_id) REFERENCES session_endpoint_bindings(id, session_id, endpoint_id),
    FOREIGN KEY (endpoint_id, recipient_principal_id) REFERENCES endpoints(id, audience_principal_id),
    FOREIGN KEY (current_attempt_id, id) REFERENCES turn_response_delivery_attempts(id, delivery_id),
    CHECK (attempt_count <= maximum_attempts),
    CHECK ((state = 'pending' AND current_attempt_id IS NULL AND started_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL AND suppressed_at IS NULL AND expired_at IS NULL AND next_attempt_at IS NULL AND reason IS NULL) OR (state = 'delivering' AND current_attempt_id IS NOT NULL AND started_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NULL AND suppressed_at IS NULL AND expired_at IS NULL AND next_attempt_at IS NULL AND reason IS NULL) OR (state = 'delivered' AND current_attempt_id IS NOT NULL AND started_at IS NOT NULL AND delivered_at IS NOT NULL AND failed_at IS NULL AND suppressed_at IS NULL AND expired_at IS NULL AND next_attempt_at IS NULL AND reason IS NULL) OR (state = 'retryable-failure' AND current_attempt_id IS NOT NULL AND started_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NOT NULL AND suppressed_at IS NULL AND expired_at IS NULL AND next_attempt_at IS NOT NULL AND reason IN ('client-disconnected', 'transport-unavailable', 'send-failed')) OR (state = 'failed' AND current_attempt_id IS NOT NULL AND started_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NOT NULL AND suppressed_at IS NULL AND expired_at IS NULL AND next_attempt_at IS NULL AND reason IN ('maximum-attempts-reached', 'delivery-deadline-elapsed')) OR (state = 'suppressed' AND current_attempt_id IS NOT NULL AND started_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NULL AND suppressed_at IS NOT NULL AND expired_at IS NULL AND next_attempt_at IS NULL AND reason IN ('binding-inactive', 'recipient-no-longer-authorized')) OR (state = 'expired' AND current_attempt_id IS NULL AND started_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL AND suppressed_at IS NULL AND expired_at IS NOT NULL AND next_attempt_at IS NULL AND reason = 'delivery-deadline-elapsed'))
  )`,
  `CREATE TABLE turn_response_delivery_attempts (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES turn_response_deliveries(id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    started_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in-progress', 'delivered', 'retryable-failure', 'failed', 'suppressed')),
    ended_at TEXT,
    reason TEXT CHECK (reason IN ('client-disconnected', 'transport-unavailable', 'send-failed', 'maximum-attempts-reached', 'delivery-deadline-elapsed', 'binding-inactive', 'recipient-no-longer-authorized')),
    next_attempt_at TEXT,
    UNIQUE (delivery_id, attempt_number),
    UNIQUE (id, delivery_id),
    CHECK ((state = 'in-progress' AND ended_at IS NULL AND reason IS NULL AND next_attempt_at IS NULL) OR (state = 'delivered' AND ended_at IS NOT NULL AND reason IS NULL AND next_attempt_at IS NULL) OR (state = 'retryable-failure' AND ended_at IS NOT NULL AND reason IN ('client-disconnected', 'transport-unavailable', 'send-failed') AND next_attempt_at IS NOT NULL) OR (state = 'failed' AND ended_at IS NOT NULL AND reason IN ('maximum-attempts-reached', 'delivery-deadline-elapsed') AND next_attempt_at IS NULL) OR (state = 'suppressed' AND ended_at IS NOT NULL AND reason IN ('binding-inactive', 'recipient-no-longer-authorized') AND next_attempt_at IS NULL))
  )`,
  `CREATE TABLE audit_envelopes (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES installations(id),
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('bootstrap', 'principal', 'system')),
    actor_principal_id TEXT REFERENCES principals(id),
    system_component TEXT CHECK (system_component IN ('application', 'authorization', 'bootstrap', 'broker', 'delivery', 'local-connector', 'remote-ingress', 'recovery', 'sidecar', 'supervisor', 'turn-coordinator')),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
    action TEXT NOT NULL CHECK (action IN ('installation-published', 'authentication-recorded', 'principal-created', 'principal-state-changed', 'identity-binding-state-changed', 'configuration-grant-state-changed', 'session-created', 'session-creation-denied', 'session-runtime-stop-recorded', 'session-lifecycle-state-changed', 'attachment-admitted', 'turn-admitted', 'turn-state-transitioned', 'turn-queue-handoff-recorded', 'turn-dispatched', 'turn-recovery-recorded', 'turn-message-finalized', 'interaction-recorded', 'interaction-resolved', 'interaction-response-dispatch-recorded', 'worker-lease-state-changed', 'credential-lease-state-changed', 'resume-handle-state-changed', 'inference-reserved', 'inference-reservation-denied', 'inference-forwarding-recorded', 'inference-forwarding-denied', 'inference-send-started', 'inference-send-completed', 'inference-send-outcome-unknown', 'inference-settled', 'inference-charged-reservation', 'inference-released', 'inference-release-denied', 'turn-terminalized', 'response-delivery-created', 'response-delivery-attempt-recorded', 'response-delivery-expired')),
    authentication_request_id TEXT REFERENCES authentication_requests(id),
    identity_binding_id TEXT REFERENCES identity_bindings(id),
    subject_principal_id TEXT REFERENCES principals(id),
    access_grant_id TEXT REFERENCES access_grants(id),
    session_id TEXT REFERENCES sessions(id),
    session_spec_id TEXT REFERENCES session_specs(id),
    endpoint_binding_id TEXT REFERENCES session_endpoint_bindings(id),
    attachment_id TEXT REFERENCES attachments(id),
    turn_id TEXT REFERENCES turns(id),
    attempt_id TEXT REFERENCES agent_dispatch_attempts(id),
    turn_message_id TEXT REFERENCES turn_messages(id),
    interaction_id TEXT REFERENCES turn_interactions(id),
    interaction_response_id TEXT REFERENCES interaction_response_dispatches(id),
    worker_lease_id TEXT REFERENCES worker_leases(id),
    credential_lease_id TEXT REFERENCES credential_leases(id),
    resume_handle_id TEXT REFERENCES agent_resume_handles(id),
    reservation_id TEXT REFERENCES inference_request_reservations(id),
    forwarding_attempt_id TEXT REFERENCES inference_forwarding_attempts(id),
    delivery_id TEXT REFERENCES turn_response_deliveries(id),
    delivery_attempt_id TEXT REFERENCES turn_response_delivery_attempts(id),
    occurred_at TEXT NOT NULL,
    CHECK ((actor_kind = 'bootstrap' AND actor_principal_id IS NULL AND system_component IS NULL) OR (actor_kind = 'principal' AND actor_principal_id IS NOT NULL AND system_component IS NULL) OR (actor_kind = 'system' AND actor_principal_id IS NULL AND system_component IS NOT NULL))
  )`,
  `CREATE TABLE bootstrap_publication_rows (
    table_name TEXT NOT NULL,
    primary_key_json TEXT NOT NULL CHECK (json_valid(primary_key_json)),
    row_digest TEXT NOT NULL CHECK (length(row_digest) = 71 AND substr(row_digest, 1, 7) = 'sha256:'),
    first_published_audit_id TEXT NOT NULL REFERENCES audit_envelopes(id),
    last_published_audit_id TEXT NOT NULL REFERENCES audit_envelopes(id),
    PRIMARY KEY (table_name, primary_key_json)
  )`,
  `CREATE UNIQUE INDEX uq_installations_first_slice_singleton ON installations ((1))`,
  `CREATE UNIQUE INDEX uq_identity_bindings_active_local_subject ON identity_bindings (installation_id, local_host_id, subject_id) WHERE source_kind = 'local-peer' AND state = 'active'`,
  `CREATE UNIQUE INDEX uq_identity_bindings_active_mtls_fingerprint ON identity_bindings (installation_id, subject_id) WHERE source_kind = 'mtls-client' AND state = 'active'`,
  `CREATE UNIQUE INDEX uq_endpoints_local_address ON endpoints (installation_id, local_host_id, local_endpoint_id) WHERE address_kind = 'local-client'`,
  `CREATE UNIQUE INDEX uq_endpoints_remote_binding ON endpoints (installation_id, identity_binding_id) WHERE address_kind = 'remote-client'`,
  `CREATE UNIQUE INDEX uq_access_grants_active_installation_role ON access_grants (installation_id, principal_id) WHERE kind = 'installation-role' AND state = 'active'`,
  `CREATE UNIQUE INDEX uq_access_grants_active_resource_use ON access_grants (installation_id, principal_id, resource_kind, resource_id) WHERE kind = 'session-configuration-use' AND state = 'active'`,
  `CREATE UNIQUE INDEX uq_workspace_revision_single_root ON workspace_revision_resources (workspace_revision_id) WHERE role = 'root'`,
  `CREATE INDEX ix_workspace_revisions_workspace_latest ON workspace_revisions (workspace_id, revision DESC)`,
  `CREATE INDEX ix_execution_policy_snapshots_policy_latest ON execution_policy_snapshots (policy_id, revision DESC)`,
  `CREATE INDEX ix_turn_policy_snapshots_policy_latest ON turn_policy_snapshots (policy_id, revision DESC)`,
  `CREATE INDEX ix_provider_connections_provider ON provider_connections (installation_id, provider_id)`,
  `CREATE INDEX ix_provider_model_manifests_provider ON provider_model_manifests (provider_id, model_id)`,
  `CREATE INDEX ix_agent_profile_revisions_profile_latest ON agent_profile_revisions (profile_id, revision DESC)`,
  `CREATE INDEX ix_extension_revisions_extension_latest ON extension_revisions (extension_id, revision DESC)`,
  `CREATE INDEX ix_sessions_owner_created ON sessions (owner_principal_id, created_at DESC)`,
  `CREATE INDEX ix_session_endpoint_bindings_active_endpoint ON session_endpoint_bindings (endpoint_id, session_id) WHERE state = 'active'`,
  `CREATE INDEX ix_turns_session_created ON turns (session_id, created_at)`,
  `CREATE UNIQUE INDEX uq_turn_input_blocks_single_attachment ON turn_input_blocks (turn_input_snapshot_id) WHERE kind = 'attachment'`,
  `CREATE INDEX ix_turn_queue_entries_head ON turn_queue_entries (principal_id, admission_ordinal)`,
  `CREATE INDEX ix_turn_runtime_states_recovery ON turn_runtime_states (status, updated_at) WHERE status IN ('dispatching', 'submission-armed', 'submitted-unconfirmed', 'accepted', 'running', 'waiting-for-approval', 'waiting-for-input', 'cancelling')`,
  `CREATE INDEX ix_agent_dispatch_attempts_turn_state ON agent_dispatch_attempts (turn_id, state)`,
  `CREATE INDEX ix_turn_events_turn_sequence ON turn_events (turn_id, sequence)`,
  `CREATE INDEX ix_turn_interactions_pending_expiry ON turn_interactions (state, expires_at) WHERE state = 'pending'`,
  `CREATE UNIQUE INDEX uq_worker_leases_active_session ON worker_leases (session_id) WHERE state = 'active'`,
  `CREATE INDEX ix_worker_leases_recovery ON worker_leases (state, expires_at) WHERE state = 'active'`,
  `CREATE UNIQUE INDEX uq_credential_leases_active_worker_connection ON credential_leases (worker_lease_id, provider_connection_id) WHERE state = 'active'`,
  `CREATE INDEX ix_credential_leases_recovery ON credential_leases (state, expires_at) WHERE state = 'active'`,
  `CREATE INDEX ix_resume_handles_recovery ON agent_resume_handles (state, expires_at) WHERE state = 'active'`,
  `CREATE INDEX ix_inference_reservations_turn_state ON inference_request_reservations (turn_id, state)`,
  `CREATE INDEX ix_inference_reservations_lease_state ON inference_request_reservations (worker_lease_id, state)`,
  `CREATE INDEX ix_forwarding_attempts_recovery ON inference_forwarding_attempts (state, updated_at) WHERE state IN ('ready-for-one-send', 'send-started', 'outcome-unknown')`,
  `CREATE INDEX ix_turn_response_deliveries_due ON turn_response_deliveries (state, next_attempt_at, deadline_at) WHERE state IN ('pending', 'retryable-failure')`,
  `CREATE INDEX ix_audit_envelopes_installation_time ON audit_envelopes (installation_id, occurred_at)`,
  `CREATE INDEX ix_audit_envelopes_turn_time ON audit_envelopes (turn_id, occurred_at) WHERE turn_id IS NOT NULL`,
] as const;

/** SQLite's strict tables prevent affinity-based repository-data corruption. */
export const HITCH_V2_SCHEMA_DDL: readonly string[] = Object.freeze(
  HITCH_V2_SCHEMA_DDL_UNQUALIFIED.map((statement) =>
    statement.startsWith("CREATE TABLE ") ? `${statement} STRICT` : statement,
  ),
);

function objectFromStatement(statement: string): CanonicalSchemaObject {
  const match = /^(CREATE\s+(?:UNIQUE\s+)?)(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/iu.exec(statement.trim());
  if (match === null) throw new TypeError(`invalid canonical schema statement: ${statement}`);
  const kind = match[2]!.toLowerCase();
  const name = match[3]!;
  const type = kind === "table" || kind === "index" || kind === "trigger" || kind === "view"
    ? kind
    : (() => { throw new TypeError(`unsupported schema object: ${kind}`); })();
  const tableName = type === "index"
    ? (/\sON\s+([a-z_][a-z0-9_]*)\s*\(/iu.exec(statement)?.[1] ?? "")
    : name;
  if (tableName === "") throw new TypeError(`schema index ${name} has no table`);
  return Object.freeze({ type, name, tableName, sql: statement.trim() });
}

function topLevelTerms(sql: string): readonly string[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close <= open) return [];
  const terms: string[] = [];
  let start = open + 1;
  let depth = 0;
  let quoted: string | undefined;
  for (let index = open + 1; index < close; index += 1) {
    const character = sql[index]!;
    if (quoted !== undefined) {
      if (character === quoted) {
        if (quoted !== "]" && sql[index + 1] === quoted) index += 1;
        else quoted = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quoted = character; continue; }
    if (character === "[") { quoted = "]"; continue; }
    if (character === "(") { depth += 1; continue; }
    if (character === ")") { depth -= 1; continue; }
    if (character === "," && depth === 0) {
      terms.push(sql.slice(start, index).trim());
      start = index + 1;
    }
  }
  terms.push(sql.slice(start, close).trim());
  return terms;
}

function tableFromObject(object: CanonicalSchemaObject): CanonicalSchemaTable {
  const columns: CanonicalSchemaColumn[] = [];
  const foreignKeys: CanonicalSchemaForeignKey[] = [];
  for (const term of topLevelTerms(object.sql)) {
    const tableReference = /^FOREIGN\s+KEY\s*\(\s*([^)]*?)\s*\)\s*REFERENCES\s+([a-z_][a-z0-9_]*)\s*\(\s*([^)]*?)\s*\)/iu.exec(term);
    if (tableReference !== null) {
      const fromColumns = tableReference[1]!.split(",").map((column) => column.trim());
      const toColumns = tableReference[3]!.split(",").map((column) => column.trim());
      if (fromColumns.length !== toColumns.length || fromColumns.some((column) => !/^[a-z_][a-z0-9_]*$/iu.test(column)) || toColumns.some((column) => !/^[a-z_][a-z0-9_]*$/iu.test(column))) {
        throw new TypeError(`invalid canonical table foreign key in ${object.name}`);
      }
      for (let index = 0; index < fromColumns.length; index += 1) {
        foreignKeys.push(Object.freeze({ from: fromColumns[index]!, table: tableReference[2]!, to: toColumns[index]! }));
      }
      continue;
    }
    const column = /^([a-z_][a-z0-9_]*)\s/iu.exec(term)?.[1];
    if (column === undefined || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/iu.test(term)) continue;
    columns.push(Object.freeze({ name: column }));
    const reference = /\bREFERENCES\s+([a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/iu.exec(term);
    if (reference !== null) foreignKeys.push(Object.freeze({ from: column, table: reference[1]!, to: reference[2]! }));
  }
  return Object.freeze({ name: object.name, sql: object.sql, columns: Object.freeze(columns), foreignKeys: Object.freeze(foreignKeys) });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const schemaObjects = HITCH_V2_SCHEMA_DDL.map(objectFromStatement).sort((left, right) =>
  left.type === right.type ? compareCodeUnits(left.name, right.name) : compareCodeUnits(left.type, right.type),
);
const schemaTables = schemaObjects.filter((object) => object.type === "table").map(tableFromObject);

export const HITCH_V2_SCHEMA_MANIFEST: HitchV2SchemaManifest = Object.freeze({
  service: "hitch",
  generation: "v2",
  schemaVersion: HITCH_V2_SCHEMA_VERSION,
  sqliteApplicationId: HITCH_V2_SQLITE_APPLICATION_ID,
  sqliteUserVersion: HITCH_V2_SQLITE_USER_VERSION,
  metadata: Object.freeze({ singleton: 1, service: "hitch", generation: "v2", schemaVersion: 1 }),
  objects: Object.freeze(schemaObjects),
  tables: Object.freeze(schemaTables),
});

function canonicalManifestJson(manifest: HitchV2SchemaManifest): string {
  return JSON.stringify({
    generation: manifest.generation,
    metadata: manifest.metadata,
    objects: manifest.objects,
    schemaVersion: manifest.schemaVersion,
    service: manifest.service,
    sqliteApplicationId: manifest.sqliteApplicationId,
    sqliteUserVersion: manifest.sqliteUserVersion,
    tables: manifest.tables,
  });
}

/** The stable SHA-256 identity returned in Installation.serviceSchema. */
export function digestHitchV2SchemaManifest(manifest: HitchV2SchemaManifest = HITCH_V2_SCHEMA_MANIFEST): string {
  return `sha256:${createHash("sha256").update(canonicalManifestJson(manifest), "utf8").digest("hex")}`;
}

export const HITCH_V2_SCHEMA_DIGEST = digestHitchV2SchemaManifest();

/**
 * Explicit reconciliation of every currently service-allocated durable ID to
 * its canonical owner table.  This is intentionally exported for the frozen
 * schema inventory test; adding an ID kind without a table is a DDL decision.
 */
export const HITCH_V2_SERVICE_ALLOCATED_KIND_TABLES: Readonly<Record<ServiceAllocatedIdKind, string>> = Object.freeze({
  Installation: "installations",
  Principal: "principals",
  IdentityBinding: "identity_bindings",
  AuthenticationRequest: "authentication_requests",
  LocalHost: "local_hosts",
  AccessGrant: "access_grants",
  Session: "sessions",
  SessionSpec: "session_specs",
  SessionEndpointBinding: "session_endpoint_bindings",
  Endpoint: "endpoints",
  Turn: "turns",
  TurnPolicy: "turn_policies",
  TurnPolicySnapshot: "turn_policy_snapshots",
  TurnInputSnapshot: "turn_input_snapshots",
  TurnEvent: "turn_events",
  TurnMessage: "turn_messages",
  TurnInteraction: "turn_interactions",
  TurnInteractionOption: "turn_interaction_options",
  TurnInteractionResponse: "interaction_response_dispatches",
  ToolInvocation: "tool_invocations",
  AgentDispatchAttempt: "agent_dispatch_attempts",
  Attachment: "attachments",
  PrivateBlob: "private_blobs",
  WorkerLease: "worker_leases",
  CredentialLease: "credential_leases",
  AgentResumeHandle: "agent_resume_handles",
  InferenceRequestReservation: "inference_request_reservations",
  InferenceForwardingAttempt: "inference_forwarding_attempts",
  TurnTerminalResponse: "turn_terminal_responses",
  TurnResponseDelivery: "turn_response_deliveries",
  TurnResponseDeliveryAttempt: "turn_response_delivery_attempts",
  AuditEnvelope: "audit_envelopes",
  AgentDriver: "agent_drivers",
  AgentDriverLaunchProfile: "agent_driver_launch_profiles",
  AgentDriverPermissionMediation: "agent_driver_permission_mediations",
  AgentProfile: "agent_profiles",
  AgentProfileRevision: "agent_profile_revisions",
  AgentResourceSnapshot: "agent_resource_snapshots",
  Provider: "providers",
  ProviderConnection: "provider_connections",
  Model: "models",
  ProviderCredentialBinding: "provider_credential_bindings",
  Workspace: "workspaces",
  WorkspaceRevision: "workspace_revisions",
  WorkspaceResource: "workspace_resources",
  ExecutionPolicy: "execution_policies",
  ExecutionPolicySnapshot: "execution_policy_snapshots",
  ToolCapability: "tool_capabilities",
  Extension: "extensions",
  ExtensionRevision: "extension_revisions",
  ExtensionGrantSnapshot: "extension_grant_snapshots",
  ExtensionCapability: "extension_capabilities",
});

export function initializeCanonicalHitchV2Schema(initializer: V2SchemaInitializer): void {
  for (const statement of HITCH_V2_SCHEMA_DDL) initializer.executeSchemaStatement(statement);
  initializer.executeSchemaStatement(
    `INSERT INTO schema_metadata (singleton, service, generation, schema_version, schema_digest) VALUES (1, 'hitch', 'v2', 1, '${HITCH_V2_SCHEMA_DIGEST}')`,
  );
  initializer.stampSchemaIdentity(HITCH_V2_SQLITE_APPLICATION_ID, HITCH_V2_SQLITE_USER_VERSION);
}

function readString(row: Readonly<Record<string, unknown>>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new V2DataRootError(`canonical schema validation received invalid ${name}`);
  return value;
}

function assertExactObjects(actual: readonly SQLiteSchemaObject[]): void {
  const expected = HITCH_V2_SCHEMA_MANIFEST.objects;
  if (actual.length !== expected.length) {
    throw new V2DataRootError("existing SQLite schema object inventory does not equal Hitch v2");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedObject = expected[index]!;
    const actualObject = actual[index];
    if (
      actualObject === undefined ||
      actualObject.type !== expectedObject.type ||
      actualObject.name !== expectedObject.name ||
      actualObject.tableName !== expectedObject.tableName ||
      actualObject.sql !== expectedObject.sql
    ) {
      throw new V2DataRootError(`existing SQLite schema object differs from canonical Hitch v2 object ${expectedObject.name}`);
    }
  }
}

function assertTableShape(validation: ExistingV2DatabaseValidation, expected: CanonicalSchemaTable): void {
  const columns = validation.queryRows(`SELECT name FROM pragma_table_info('${expected.name}') ORDER BY cid`)
    .map((row) => readString(row, "name"));
  const expectedColumns = expected.columns.map((column) => column.name);
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new V2DataRootError(`existing SQLite columns differ for canonical table ${expected.name}`);
  }
  const orderForeignKeys = (foreignKeys: readonly CanonicalSchemaForeignKey[]): readonly CanonicalSchemaForeignKey[] =>
    [...foreignKeys].sort((left, right) => compareCodeUnits(`${left.from}\u0000${left.table}\u0000${left.to}`, `${right.from}\u0000${right.table}\u0000${right.to}`));
  const foreignKeys = orderForeignKeys(validation.queryRows(`SELECT "from", "table", "to" FROM pragma_foreign_key_list('${expected.name}')`)
    .map((row) => Object.freeze({ from: readString(row, "from"), table: readString(row, "table"), to: readString(row, "to") })));
  if (JSON.stringify(foreignKeys) !== JSON.stringify(orderForeignKeys(expected.foreignKeys))) {
    throw new V2DataRootError(`existing SQLite foreign keys differ for canonical table ${expected.name}`);
  }
}

/**
 * Validates an isolated inspection snapshot before V2Database configures the
 * real connection.  It intentionally accepts neither an empty foundation DB
 * nor any “close enough” version: migrations, resets, and repair are outside
 * the first slice.
 */
export function validateCanonicalHitchV2Schema(validation: ExistingV2DatabaseValidation): void {
  if (validation.applicationId !== HITCH_V2_SQLITE_APPLICATION_ID) {
    throw new V2DataRootError("SQLite application_id is not the exact Hitch v2 identity");
  }
  if (validation.userVersion !== HITCH_V2_SQLITE_USER_VERSION) {
    throw new V2DataRootError("SQLite user_version is not the exact Hitch v2 version");
  }
  assertExactObjects(validation.schemaObjects);
  for (const table of HITCH_V2_SCHEMA_MANIFEST.tables) assertTableShape(validation, table);
  const metadata = validation.queryRows(
    "SELECT singleton, service, generation, schema_version, schema_digest FROM schema_metadata ORDER BY singleton",
  );
  if (metadata.length !== 1) throw new V2DataRootError("Hitch v2 schema metadata must contain exactly one row");
  const row = metadata[0]!;
  if (
    row.singleton !== 1 ||
    readString(row, "service") !== "hitch" ||
    readString(row, "generation") !== "v2" ||
    row.schema_version !== HITCH_V2_SCHEMA_VERSION ||
    readString(row, "schema_digest") !== HITCH_V2_SCHEMA_DIGEST
  ) {
    throw new V2DataRootError("Hitch v2 schema metadata does not exactly match the canonical manifest");
  }
}

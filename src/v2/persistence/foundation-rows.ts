/**
 * Pure mapping from the validated first-slice bootstrap graph to canonical
 * SQLite rows. This module performs no I/O and owns no transaction.
 */

import {
  decodeAgentProfileRevision,
  decodeAgentResourceSnapshot,
  decodeConfigurationIdentity,
  decodeExecutionPolicySnapshot,
  decodeExtensionGrantSnapshot,
  decodeExtensionRevision,
  decodeInstallationHardCeilings,
  decodeProviderConnectionSpec,
  decodeProviderCredentialBinding,
  decodeTurnPolicySnapshot,
  decodeWorkspaceRevision,
  validateBootstrapGraph,
  type ConfigurationIdentity,
} from "../bootstrap/records.js";
import {
  digestCanonicalJson,
  encodeCanonicalJson,
} from "../codecs/json.js";
import {
  decodeBoundedArray,
  decodeBoundedString,
  decodeIntegrityDigest,
  decodeIsoTimestamp,
  decodeServiceId,
} from "../codecs/primitives.js";
import { decodeSecretFreeJsonValue } from "../codecs/projections.js";
import type {
  BootstrapPublicationRecords,
} from "../model/application.js";
import type { AuditActorRef } from "../model/identity-access.js";
import type { IntegrityDigest, JsonValue } from "../model/primitives.js";
import type { SQLiteBindValue } from "./database.js";
import {
  HITCH_V2_SCHEMA_DIGEST,
  HITCH_V2_SCHEMA_MANIFEST,
  HITCH_V2_SCHEMA_VERSION,
  HITCH_V2_SQLITE_APPLICATION_ID,
} from "./schema.js";

export const BOOTSTRAP_FOUNDATION_TABLES = Object.freeze([
  "installations",
  "principals",
  "local_hosts",
  "identity_bindings",
  "endpoints",
  "access_grants",
  "installation_reference_bindings",
  "principal_reference_bindings",
  "local_host_reference_bindings",
  "identity_binding_reference_bindings",
  "authentication_subject_reference_bindings",
  "endpoint_reference_bindings",
  "workspaces",
  "workspace_resources",
  "workspace_revisions",
  "workspace_revision_resources",
  "execution_policies",
  "tool_capabilities",
  "execution_policy_snapshots",
  "execution_policy_resource_grants",
  "execution_policy_tool_capabilities",
  "turn_policies",
  "turn_policy_snapshots",
  "providers",
  "models",
  "provider_credential_bindings",
  "provider_connections",
  "provider_connection_origins",
  "provider_model_manifests",
  "provider_model_image_mime_types",
  "provider_model_reasoning_efforts",
  "agent_profiles",
  "agent_drivers",
  "agent_profile_revisions",
  "agent_profile_provider_allowances",
  "agent_profile_allowance_models",
  "agent_resource_snapshots",
  "extensions",
  "extension_revisions",
  "extension_grant_snapshots",
  "extension_capabilities",
  "extension_grant_capabilities",
  "agent_profile_resource_snapshots",
  "agent_profile_extension_grants",
  "workspace_reference_bindings",
  "agent_resource_artifact_bindings",
  "extension_artifact_bindings",
  "provider_artifact_bindings",
] as const);

export type BootstrapFoundationTable =
  (typeof BOOTSTRAP_FOUNDATION_TABLES)[number];

/**
 * Canonical primary-key shapes for every table owned by bootstrap publication.
 * The publisher also uses this reviewed map to validate durable ledger entries
 * without ever treating database content as a source of SQL identifiers.
 */
function freezePrimaryKeyMap<
  Map extends Readonly<
    Record<BootstrapFoundationTable, readonly string[]>
  >,
>(map: Map): Map {
  for (const columns of Object.values(map)) Object.freeze(columns);
  return Object.freeze(map);
}

export const BOOTSTRAP_FOUNDATION_PRIMARY_KEYS = freezePrimaryKeyMap({
  installations: ["id"],
  principals: ["id"],
  local_hosts: ["id"],
  identity_bindings: ["id"],
  endpoints: ["id"],
  access_grants: ["id"],
  installation_reference_bindings: ["installation_id"],
  principal_reference_bindings: ["principal_id"],
  local_host_reference_bindings: ["local_host_id"],
  identity_binding_reference_bindings: ["identity_binding_id"],
  authentication_subject_reference_bindings: ["identity_binding_id"],
  endpoint_reference_bindings: ["endpoint_id"],
  workspaces: ["id"],
  workspace_resources: ["id"],
  workspace_revisions: ["id"],
  workspace_revision_resources: [
    "workspace_revision_id",
    "workspace_resource_id",
  ],
  execution_policies: ["id"],
  tool_capabilities: ["id"],
  execution_policy_snapshots: ["id"],
  execution_policy_resource_grants: [
    "execution_policy_snapshot_id",
    "workspace_resource_id",
  ],
  execution_policy_tool_capabilities: [
    "execution_policy_snapshot_id",
    "tool_capability_id",
  ],
  turn_policies: ["id"],
  turn_policy_snapshots: ["id"],
  providers: ["id"],
  models: ["id"],
  provider_credential_bindings: ["id"],
  provider_connections: ["id"],
  provider_connection_origins: ["provider_connection_id", "origin"],
  provider_model_manifests: ["provider_connection_id", "model_id"],
  provider_model_image_mime_types: [
    "provider_connection_id",
    "model_id",
    "mime_type",
  ],
  provider_model_reasoning_efforts: [
    "provider_connection_id",
    "model_id",
    "effort",
  ],
  agent_profiles: ["id"],
  agent_drivers: ["id"],
  agent_profile_revisions: ["id"],
  agent_profile_provider_allowances: [
    "agent_profile_revision_id",
    "provider_id",
  ],
  agent_profile_allowance_models: [
    "agent_profile_revision_id",
    "provider_id",
    "model_id",
  ],
  agent_resource_snapshots: ["id"],
  extensions: ["id"],
  extension_revisions: ["id"],
  extension_grant_snapshots: ["id"],
  extension_capabilities: ["id"],
  extension_grant_capabilities: [
    "extension_grant_snapshot_id",
    "extension_capability_id",
  ],
  agent_profile_resource_snapshots: [
    "agent_profile_revision_id",
    "agent_resource_snapshot_id",
  ],
  agent_profile_extension_grants: [
    "agent_profile_revision_id",
    "extension_grant_snapshot_id",
  ],
  workspace_reference_bindings: ["workspace_id"],
  agent_resource_artifact_bindings: ["agent_resource_snapshot_id"],
  extension_artifact_bindings: ["extension_revision_id"],
  provider_artifact_bindings: ["provider_connection_id"],
} satisfies Readonly<
  Record<BootstrapFoundationTable, readonly string[]>
>);

export interface BootstrapFoundationRow {
  readonly table: BootstrapFoundationTable;
  readonly primaryKey: readonly string[];
  readonly columns: readonly string[];
  readonly values: readonly SQLiteBindValue[];
}

export interface BootstrapFoundationRowProjection {
  readonly schemaDigest: IntegrityDigest;
  readonly semanticDigest: IntegrityDigest;
  readonly rows: readonly BootstrapFoundationRow[];
}

export class BootstrapFoundationRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapFoundationRowError";
  }
}

const REFERENCE = /^[a-z][a-z0-9-]{0,127}$/u;
const OPAQUE_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;
const tableColumns = new Map(
  HITCH_V2_SCHEMA_MANIFEST.tables.map((table) => [
    table.name,
    new Set(table.columns.map((column) => column.name)),
  ]),
);

function fail(message: string): never {
  throw new BootstrapFoundationRowError(message);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set(fields);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !expected.has(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return fail(`${label} has an unknown or unsafe field`);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      return fail(`${label} is missing ${field}`);
    }
  }
  return value as Record<string, unknown>;
}

function safeObjectField(
  value: unknown,
  field: string,
  label: string,
): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return fail(`${label} must be a plain object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    return fail(`${label} has an unsafe ${field} field`);
  }
  return descriptor.value;
}

function reference(value: unknown, label: string): string {
  return decodeBoundedString(
    value,
    {
      minimumLength: 1,
      maximumLength: 128,
      pattern: REFERENCE,
      label,
    },
  );
}

function opaqueId(value: unknown, label: string): string {
  const decoded = decodeBoundedString(value, {
    minimumLength: 1,
    maximumLength: 128,
    pattern: OPAQUE_ID,
    label,
  });
  if (decoded.includes("..")) {
    fail(`${label} cannot contain adjacent dots`);
  }
  return decoded;
}

function displayName(value: unknown, label: string): string {
  const decoded = decodeBoundedString(value, {
    minimumLength: 1,
    maximumLength: 128,
    label,
  });
  decodeSecretFreeJsonValue(decoded, { forbiddenPaths: "all" });
  return decoded;
}

function row(
  table: BootstrapFoundationTable,
  primaryKey: readonly string[],
  entries: Readonly<Record<string, SQLiteBindValue>>,
): BootstrapFoundationRow {
  const allowed = tableColumns.get(table);
  if (allowed === undefined) return fail(`unknown canonical table ${table}`);
  const canonicalPrimaryKey = BOOTSTRAP_FOUNDATION_PRIMARY_KEYS[table];
  if (
    primaryKey.length !== canonicalPrimaryKey.length ||
    primaryKey.some(
      (column, index) => column !== canonicalPrimaryKey[index],
    )
  ) {
    return fail(`${table} row has a noncanonical primary key`);
  }
  const columns = Object.keys(entries);
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    return fail(`${table} row has no columns or duplicate columns`);
  }
  for (const column of columns) {
    if (!allowed.has(column)) {
      return fail(`${table} row names unknown column ${column}`);
    }
  }
  for (const column of primaryKey) {
    if (!columns.includes(column) || entries[column] === null) {
      return fail(`${table} row has an invalid primary key`);
    }
  }
  return Object.freeze({
    table,
    primaryKey: Object.freeze([...primaryKey]),
    columns: Object.freeze(columns),
    values: Object.freeze(columns.map((column) => entries[column]!)),
  });
}

function canonicalJson(value: JsonValue): string {
  return encodeCanonicalJson(value);
}

function actorColumns(
  actor: AuditActorRef,
): {
  readonly kind: "bootstrap" | "principal" | "system";
  readonly principalId: string | null;
  readonly systemComponent: string | null;
} {
  if (actor.kind === "bootstrap") {
    return { kind: "bootstrap", principalId: null, systemComponent: null };
  }
  if (actor.kind === "principal") {
    return {
      kind: "principal",
      principalId: actor.principalId,
      systemComponent: null,
    };
  }
  return {
    kind: "system",
    principalId: null,
    systemComponent: actor.component,
  };
}

function assertCurrentServiceSchema(
  installation: BootstrapPublicationRecords["installation"],
): void {
  const object = exactObject(
    installation,
    ["id", "serviceSchema", "hardCeilings", "createdAt", "updatedAt"],
    "installation",
  );
  decodeServiceId("Installation", object.id);
  decodeIsoTimestamp(object.createdAt);
  decodeIsoTimestamp(object.updatedAt);
  const identity = exactObject(
    object.serviceSchema,
    [
      "service",
      "generation",
      "schemaVersion",
      "sqliteApplicationId",
      "schemaDigest",
    ],
    "installation service schema",
  );
  if (
    identity.service !== "hitch" ||
    identity.generation !== "v2" ||
    identity.schemaVersion !== HITCH_V2_SCHEMA_VERSION ||
    identity.sqliteApplicationId !== HITCH_V2_SQLITE_APPLICATION_ID ||
    identity.schemaDigest !== HITCH_V2_SCHEMA_DIGEST
  ) {
    fail("bootstrap installation does not target the current canonical schema");
  }
  decodeInstallationHardCeilings(object.hardCeilings);
}

function assertBasicBootstrapRecords(
  records: BootstrapPublicationRecords,
): void {
  exactObject(
    records,
    [
      "installation",
      "owner",
      "localIdentityBinding",
      "localEndpoint",
      "accessGrants",
      "workspace",
      "workspaceRevision",
      "agentProfile",
      "agentProfileRevision",
      "executionPolicy",
      "executionPolicySnapshot",
      "turnPolicy",
      "turnPolicySnapshot",
      "agentResourceSnapshots",
      "extensions",
      "extensionRevisions",
      "extensionGrantSnapshots",
      "providerConnection",
      "providerCredentialBinding",
      "referenceBindings",
      "artifactBindings",
    ],
    "bootstrap publication records",
  );
  assertCurrentServiceSchema(records.installation);

  const owner = exactObject(
    records.owner,
    ["id", "installationId", "kind", "displayName", "state", "createdAt"],
    "bootstrap owner",
  );
  const ownerState = exactObject(owner.state, ["status"], "bootstrap owner state");
  if (owner.kind !== "human" || ownerState.status !== "active") {
    fail("bootstrap owner must be one active human principal");
  }
  decodeServiceId("Principal", owner.id);
  decodeServiceId("Installation", owner.installationId);
  displayName(owner.displayName, "bootstrap owner display name");
  decodeIsoTimestamp(owner.createdAt);

  const binding = exactObject(
    records.localIdentityBinding,
    [
      "id",
      "installationId",
      "principalId",
      "source",
      "subjectId",
      "state",
      "createdAt",
    ],
    "local identity binding",
  );
  const source = exactObject(
    binding.source,
    ["kind", "localHostId"],
    "local identity source",
  );
  const bindingState = exactObject(
    binding.state,
    ["status"],
    "local identity state",
  );
  if (source.kind !== "local-peer" || bindingState.status !== "active") {
    fail("bootstrap identity binding must be one active local peer");
  }
  decodeServiceId("IdentityBinding", binding.id);
  decodeServiceId("Installation", binding.installationId);
  decodeServiceId("Principal", binding.principalId);
  decodeServiceId("LocalHost", source.localHostId);
  opaqueId(binding.subjectId, "local authentication subject ID");
  decodeIsoTimestamp(binding.createdAt);

  const endpoint = exactObject(
    records.localEndpoint,
    ["id", "installationId", "address", "audience", "createdAt"],
    "local endpoint",
  );
  const address = exactObject(
    endpoint.address,
    ["kind", "localHostId", "localEndpointId"],
    "local endpoint address",
  );
  const audience = exactObject(
    endpoint.audience,
    ["kind", "principalId"],
    "local endpoint audience",
  );
  if (address.kind !== "local-client" || audience.kind !== "private") {
    fail("bootstrap endpoint must be one private local client");
  }
  decodeServiceId("Endpoint", endpoint.id);
  decodeServiceId("Installation", endpoint.installationId);
  decodeServiceId("LocalHost", address.localHostId);
  opaqueId(address.localEndpointId, "local endpoint ID");
  decodeServiceId("Principal", audience.principalId);
  decodeIsoTimestamp(endpoint.createdAt);

  decodeBoundedArray(
    records.accessGrants,
    (grant) => {
      const kind = safeObjectField(
        grant,
        "kind",
        "bootstrap access grant",
      );
      const base = exactObject(
        grant,
        kind === "installation-role"
          ? [
              "id",
              "kind",
              "installationId",
              "principalId",
              "role",
              "grantedBy",
              "createdAt",
              "state",
            ]
          : [
              "id",
              "kind",
              "installationId",
              "principalId",
              "resource",
              "grantedBy",
              "createdAt",
              "state",
            ],
        "bootstrap access grant",
      );
      if (
        base.kind !== "installation-role" &&
        base.kind !== "session-configuration-use"
      ) {
        fail("bootstrap access grant has an unsupported kind");
      }
      if (
        exactObject(base.grantedBy, ["kind"], "grant actor").kind !==
          "bootstrap" ||
        exactObject(base.state, ["status"], "grant state").status !==
          "active"
      ) {
        fail("bootstrap access grants must be active and bootstrap-authored");
      }
      decodeServiceId("AccessGrant", base.id);
      decodeServiceId("Installation", base.installationId);
      decodeServiceId("Principal", base.principalId);
      decodeIsoTimestamp(base.createdAt);
      if (base.kind === "installation-role") {
        if (base.role !== "admin") {
          fail("bootstrap installation role must be admin");
        }
      } else {
        const resource = exactObject(
          base.resource,
          ["kind", "id"],
          "configuration-use resource",
        );
        switch (resource.kind) {
          case "workspace":
            decodeServiceId("Workspace", resource.id);
            break;
          case "agent-profile":
            decodeServiceId("AgentProfile", resource.id);
            break;
          case "execution-policy":
            decodeServiceId("ExecutionPolicy", resource.id);
            break;
          case "turn-policy":
            decodeServiceId("TurnPolicy", resource.id);
            break;
          case "extension":
            decodeServiceId("Extension", resource.id);
            break;
          case "provider-credential-binding":
            decodeServiceId("ProviderCredentialBinding", resource.id);
            break;
          default:
            fail("configuration-use grant names an unsupported resource");
        }
      }
      return true;
    },
    { minimumItems: 1, maximumItems: 64 },
  );
  assertReferenceBindingShapes(records.referenceBindings);
  assertArtifactBindingShapes(records.artifactBindings);
}

function assertReferenceBindingShapes(
  bindings: BootstrapPublicationRecords["referenceBindings"],
): void {
  const root = exactObject(
    bindings,
    [
      "installation",
      "owner",
      "localHost",
      "identityBinding",
      "subject",
      "endpoint",
      "workspace",
    ],
    "bootstrap reference bindings",
  );
  const installation = exactObject(
    root.installation,
    ["reference", "installationId", "displayName"],
    "installation reference binding",
  );
  reference(installation.reference, "installation reference");
  decodeServiceId("Installation", installation.installationId);
  displayName(installation.displayName, "installation display name");

  const owner = exactObject(
    root.owner,
    ["reference", "principalId"],
    "owner reference binding",
  );
  reference(owner.reference, "owner reference");
  decodeServiceId("Principal", owner.principalId);

  const localHost = exactObject(
    root.localHost,
    ["reference", "localHostId"],
    "local host reference binding",
  );
  reference(localHost.reference, "local host reference");
  decodeServiceId("LocalHost", localHost.localHostId);

  const identity = exactObject(
    root.identityBinding,
    ["reference", "identityBindingId"],
    "identity reference binding",
  );
  reference(identity.reference, "identity binding reference");
  decodeServiceId("IdentityBinding", identity.identityBindingId);

  const subject = exactObject(
    root.subject,
    ["reference", "resolution", "authenticationSubjectId"],
    "subject reference binding",
  );
  reference(subject.reference, "subject reference");
  reference(subject.resolution, "subject resolution");
  opaqueId(
    subject.authenticationSubjectId,
    "referenced authentication subject ID",
  );

  const endpoint = exactObject(
    root.endpoint,
    ["reference", "endpointId", "localEndpointId"],
    "endpoint reference binding",
  );
  reference(endpoint.reference, "endpoint reference");
  decodeServiceId("Endpoint", endpoint.endpointId);
  opaqueId(endpoint.localEndpointId, "referenced local endpoint ID");

  const workspace = exactObject(
    root.workspace,
    ["bindingReference", "workspaceId", "workspaceRevisionId"],
    "workspace reference binding",
  );
  reference(workspace.bindingReference, "workspace binding reference");
  decodeServiceId("Workspace", workspace.workspaceId);
  decodeServiceId("WorkspaceRevision", workspace.workspaceRevisionId);
}

function assertArtifactBindingShapes(
  bindings: BootstrapPublicationRecords["artifactBindings"],
): void {
  const root = exactObject(
    bindings,
    ["declarative", "extensions", "provider"],
    "bootstrap artifact bindings",
  );
  decodeBoundedArray(
    root.declarative,
    (value) => {
      const binding = exactObject(
        value,
        [
          "agentResourceSnapshotId",
          "artifactReference",
          "integrityDigest",
          "kind",
        ],
        "declarative artifact binding",
      );
      decodeServiceId(
        "AgentResourceSnapshot",
        binding.agentResourceSnapshotId,
      );
      reference(binding.artifactReference, "declarative artifact reference");
      decodeIntegrityDigest(binding.integrityDigest);
      if (
        binding.kind !== "skill" &&
        binding.kind !== "prompt-template" &&
        binding.kind !== "theme"
      ) {
        fail("declarative artifact binding has an unsupported kind");
      }
      return true;
    },
    { maximumItems: 32 },
  );
  decodeBoundedArray(
    root.extensions,
    (value) => {
      const binding = exactObject(
        value,
        ["extensionRevisionId", "artifactReference", "integrityDigest"],
        "extension artifact binding",
      );
      decodeServiceId("ExtensionRevision", binding.extensionRevisionId);
      reference(binding.artifactReference, "extension artifact reference");
      decodeIntegrityDigest(binding.integrityDigest);
      return true;
    },
    { maximumItems: 32 },
  );
  const provider = exactObject(
    root.provider,
    [
      "providerConnectionId",
      "bridgeId",
      "bridgeArtifactDigest",
      "nativeStack",
      "nativeStackVersion",
      "nativeStackDigest",
      "nativeCatalogDigest",
    ],
    "provider artifact binding",
  );
  decodeServiceId("ProviderConnection", provider.providerConnectionId);
  reference(provider.bridgeId, "provider bridge ID");
  decodeIntegrityDigest(provider.bridgeArtifactDigest);
  if (provider.nativeStack !== "pi-ai") {
    fail("provider artifact binding has an unsupported native stack");
  }
  decodeBoundedString(provider.nativeStackVersion, {
    minimumLength: 1,
    maximumLength: 64,
    label: "native stack version",
  });
  decodeIntegrityDigest(provider.nativeStackDigest);
  decodeIntegrityDigest(provider.nativeCatalogDigest);
}

function validateAndDecodeGraph(records: BootstrapPublicationRecords) {
  assertBasicBootstrapRecords(records);
  const workspace = decodeConfigurationIdentity(
    records.workspace,
    "workspace",
  ) as BootstrapPublicationRecords["workspace"];
  const workspaceRevision = decodeWorkspaceRevision(records.workspaceRevision);
  const agentProfile = decodeConfigurationIdentity(
    records.agentProfile,
    "agent-profile",
  ) as BootstrapPublicationRecords["agentProfile"];
  const agentProfileRevision = decodeAgentProfileRevision(
    records.agentProfileRevision,
  );
  const executionPolicy = decodeConfigurationIdentity(
    records.executionPolicy,
    "execution-policy",
  ) as BootstrapPublicationRecords["executionPolicy"];
  const executionPolicySnapshot = decodeExecutionPolicySnapshot(
    records.executionPolicySnapshot,
  );
  const turnPolicy = decodeConfigurationIdentity(
    records.turnPolicy,
    "turn-policy",
  ) as BootstrapPublicationRecords["turnPolicy"];
  const turnPolicySnapshot = decodeTurnPolicySnapshot(
    records.turnPolicySnapshot,
  );
  const agentResourceSnapshots = decodeBoundedArray(
    records.agentResourceSnapshots,
    (item) => decodeAgentResourceSnapshot(item),
    { maximumItems: 32, uniqueBy: (item) => item.id },
  );
  const extensions = decodeBoundedArray(
    records.extensions,
    (item) =>
      decodeConfigurationIdentity(
        item,
        "extension",
      ) as BootstrapPublicationRecords["extensions"][number],
    { maximumItems: 32, uniqueBy: (item) => item.id },
  );
  const extensionRevisions = decodeBoundedArray(
    records.extensionRevisions,
    (item) => decodeExtensionRevision(item),
    { maximumItems: 32, uniqueBy: (item) => item.id },
  );
  const extensionGrantSnapshots = decodeBoundedArray(
    records.extensionGrantSnapshots,
    (item) => decodeExtensionGrantSnapshot(item),
    { maximumItems: 32, uniqueBy: (item) => item.id },
  );
  const providerConnection = decodeProviderConnectionSpec(
    records.providerConnection,
  );
  const providerCredentialBinding = decodeProviderCredentialBinding(
    records.providerCredentialBinding,
  );
  const hardCeilings = decodeInstallationHardCeilings(
    records.installation.hardCeilings,
  );
  validateBootstrapGraph({
    workspace,
    workspaceRevision,
    agentProfile,
    agentProfileRevision,
    executionPolicy,
    executionPolicySnapshot,
    turnPolicy,
    turnPolicySnapshot,
    agentResourceSnapshots,
    extensions,
    extensionRevisions,
    extensionGrantSnapshots,
    providerConnection,
    providerCredentialBinding,
    installationId: records.installation.id,
    hardCeilings,
  });
  return {
    workspace,
    workspaceRevision,
    agentProfile,
    agentProfileRevision,
    executionPolicy,
    executionPolicySnapshot,
    turnPolicy,
    turnPolicySnapshot,
    agentResourceSnapshots,
    extensions,
    extensionRevisions,
    extensionGrantSnapshots,
    providerConnection,
    providerCredentialBinding,
    hardCeilings,
  };
}

function mapIdentityRow(
  table:
    | "workspaces"
    | "execution_policies"
    | "turn_policies"
    | "agent_profiles"
    | "extensions",
  identity: ConfigurationIdentity,
): BootstrapFoundationRow {
  return row(table, ["id"], {
    id: identity.id,
    installation_id: identity.installationId,
    reference: identity.reference,
    display_name: identity.displayName,
    created_at: identity.createdAt,
  });
}

function assertFirstSliceRelationalShape(
  graph: ReturnType<typeof validateAndDecodeGraph>,
): void {
  if (
    graph.workspaceRevision.mounts.length !== 0 ||
    graph.workspaceRevision.root.maximumAccess !== "read-write" ||
    graph.executionPolicySnapshot.workspaceFilesystem !== "read-write" ||
    graph.executionPolicySnapshot.resourceGrants.some(
      (grant) => grant.access !== "read-write",
    )
  ) {
    fail("bootstrap graph is wider than the first-slice relational schema");
  }
  if (
    graph.providerConnection.transport.mode !== "native-library-sidecar" ||
    graph.providerConnection.transport.nativeStack !== "pi-ai" ||
    graph.providerConnection.models.length !== 1 ||
    graph.agentProfileRevision.providers.length !== 1
  ) {
    fail("bootstrap provider/profile graph exceeds the one-provider first slice");
  }
  if (
    graph.turnPolicySnapshot.admission.maxQueuedTurns !== 3 ||
    graph.turnPolicySnapshot.interaction.approval !==
      "ask-authorized-approver" ||
    graph.turnPolicySnapshot.interaction.inputRequests !== "deny"
  ) {
    fail("bootstrap turn policy exceeds the fixed first-slice interaction");
  }
  const model = graph.providerConnection.models[0]!;
  if (
    model.imageInput.kind !== "supported" ||
    model.imageInput.maximumImagesPerRequest !== 1 ||
    model.imageInput.maximumTotalImageBytesPerRequest !==
      model.imageInput.maximumImageBytesEach
  ) {
    fail("bootstrap model exceeds the fixed first-slice image policy");
  }
  const allowance = graph.agentProfileRevision.providers[0]!;
  if (
    allowance.models.kind !== "allowlist" ||
    allowance.models.modelIds.length !== 1
  ) {
    fail("bootstrap profile must allowlist exactly one model");
  }
  const policies = graph.agentProfileRevision.resourcePolicy;
  if (
    policies.skills.mode !== "pinned" ||
    policies.promptTemplates.mode !== "pinned" ||
    policies.themes.mode !== "pinned" ||
    policies.extensions.mode !== "granted-only" ||
    policies.skills.projectResources !== "disabled" ||
    policies.promptTemplates.projectResources !== "disabled" ||
    policies.themes.projectResources !== "disabled"
  ) {
    fail("bootstrap profile enables deferred project resource discovery");
  }
}

function assertBootstrapBindingAlignment(
  records: BootstrapPublicationRecords,
  graph: ReturnType<typeof validateAndDecodeGraph>,
): void {
  const installationId = records.installation.id;
  const localSource = records.localIdentityBinding.source;
  if (localSource.kind !== "local-peer") {
    fail("bootstrap identity binding is not a local peer");
  }
  if (
    records.owner.installationId !== installationId ||
    records.localIdentityBinding.installationId !== installationId ||
    records.localIdentityBinding.principalId !== records.owner.id ||
    records.localEndpoint.installationId !== installationId ||
    records.localEndpoint.address.kind !== "local-client" ||
    records.localEndpoint.address.localHostId !==
      localSource.localHostId ||
    records.localEndpoint.audience.kind !== "private" ||
    records.localEndpoint.audience.principalId !== records.owner.id
  ) {
    fail("bootstrap identity, endpoint, and installation bindings drift");
  }

  const references = records.referenceBindings;
  if (
    references.installation.installationId !== installationId ||
    references.owner.principalId !== records.owner.id ||
    references.localHost.localHostId !==
      localSource.localHostId ||
    references.identityBinding.identityBindingId !==
      records.localIdentityBinding.id ||
    references.subject.authenticationSubjectId !==
      records.localIdentityBinding.subjectId ||
    references.endpoint.endpointId !== records.localEndpoint.id ||
    references.endpoint.localEndpointId !==
      records.localEndpoint.address.localEndpointId ||
    references.workspace.workspaceId !== graph.workspace.id ||
    references.workspace.workspaceRevisionId !== graph.workspaceRevision.id
  ) {
    fail("bootstrap reference binding targets drift from their records");
  }

  const expectedGrantResources = new Set([
    `workspace:${graph.workspace.id}`,
    `agent-profile:${graph.agentProfile.id}`,
    `execution-policy:${graph.executionPolicy.id}`,
    `turn-policy:${graph.turnPolicy.id}`,
    `provider-credential-binding:${graph.providerCredentialBinding.id}`,
    ...graph.extensions.map((extension) => `extension:${extension.id}`),
  ]);
  const grantIds = new Set<string>();
  let roleGrants = 0;
  const actualGrantResources = new Set<string>();
  for (const grant of records.accessGrants) {
    if (
      grant.installationId !== installationId ||
      grant.principalId !== records.owner.id ||
      grantIds.has(grant.id)
    ) {
      fail("bootstrap access grant identity drift");
    }
    grantIds.add(grant.id);
    if (grant.kind === "installation-role") {
      if (grant.role !== "admin") {
        fail("bootstrap owner must receive exactly the admin role");
      }
      roleGrants += 1;
    } else {
      const resource = `${grant.resource.kind}:${grant.resource.id}`;
      if (actualGrantResources.has(resource)) {
        fail("bootstrap configuration-use authority is duplicated");
      }
      actualGrantResources.add(resource);
    }
  }
  if (
    roleGrants !== 1 ||
    records.accessGrants.length !== expectedGrantResources.size + 1 ||
    actualGrantResources.size !== expectedGrantResources.size ||
    [...expectedGrantResources].some(
      (resource) => !actualGrantResources.has(resource),
    )
  ) {
    fail("bootstrap access grants do not exactly cover the published graph");
  }

  if (
    graph.providerCredentialBinding.installationId !== installationId ||
    graph.providerCredentialBinding.providerId !==
      graph.providerConnection.providerId
  ) {
    fail("bootstrap provider credential binding drift");
  }

  const declarativeArtifacts = records.artifactBindings.declarative;
  if (
    declarativeArtifacts.length !== graph.agentResourceSnapshots.length ||
    new Set(
      declarativeArtifacts.map(
        (binding) => binding.agentResourceSnapshotId,
      ),
    ).size !== declarativeArtifacts.length ||
    new Set(
      declarativeArtifacts.map((binding) => binding.artifactReference),
    ).size !== declarativeArtifacts.length ||
    declarativeArtifacts.some((binding) => {
      const resource = graph.agentResourceSnapshots.find(
        (candidate) => candidate.id === binding.agentResourceSnapshotId,
      );
      return (
        resource === undefined ||
        resource.kind !== binding.kind ||
        resource.integrityDigest !== binding.integrityDigest
      );
    })
  ) {
    fail("bootstrap declarative artifact bindings drift");
  }
  const extensionArtifacts = records.artifactBindings.extensions;
  if (
    extensionArtifacts.length !== graph.extensionRevisions.length ||
    new Set(
      extensionArtifacts.map((binding) => binding.extensionRevisionId),
    ).size !== extensionArtifacts.length ||
    new Set(
      extensionArtifacts.map((binding) => binding.artifactReference),
    ).size !== extensionArtifacts.length ||
    extensionArtifacts.some((binding) => {
      const revision = graph.extensionRevisions.find(
        (candidate) => candidate.id === binding.extensionRevisionId,
      );
      return (
        revision === undefined ||
        revision.integrityDigest !== binding.integrityDigest
      );
    })
  ) {
    fail("bootstrap extension artifact bindings drift");
  }
  const providerArtifact = records.artifactBindings.provider;
  if (
    graph.providerConnection.transport.mode !== "native-library-sidecar" ||
    providerArtifact.providerConnectionId !== graph.providerConnection.id ||
    providerArtifact.bridgeId !== graph.providerConnection.transport.bridgeId ||
    providerArtifact.nativeStack !==
      graph.providerConnection.transport.nativeStack ||
    providerArtifact.nativeStackVersion !==
      graph.providerConnection.transport.nativeStackVersion ||
    providerArtifact.nativeCatalogDigest !==
      graph.providerConnection.transport.nativeCatalogDigest
  ) {
    fail("bootstrap provider artifact binding drift");
  }
}

/**
 * Revalidates and projects one complete first-slice bootstrap graph. The
 * returned table/column names come only from this reviewed mapper; record data
 * can populate values but can never select SQL identifiers.
 */
export function projectBootstrapFoundationRows(
  records: BootstrapPublicationRecords,
): BootstrapFoundationRowProjection {
  const graph = validateAndDecodeGraph(records);
  assertFirstSliceRelationalShape(graph);
  assertBootstrapBindingAlignment(records, graph);
  const rows: BootstrapFoundationRow[] = [];
  const add = (value: BootstrapFoundationRow): void => {
    rows.push(value);
  };
  const installationId = records.installation.id;

  add(row("installations", ["id"], {
    id: installationId,
    service_schema_digest: records.installation.serviceSchema.schemaDigest,
    hard_ceilings_json: canonicalJson(
      graph.hardCeilings as unknown as JsonValue,
    ),
    created_at: records.installation.createdAt,
    updated_at: records.installation.updatedAt,
  }));

  add(row("principals", ["id"], {
    id: records.owner.id,
    installation_id: installationId,
    kind: "human",
    display_name: records.owner.displayName,
    state: "active",
    disabled_at: null,
    disabled_actor_kind: null,
    disabled_actor_principal_id: null,
    disabled_actor_system_component: null,
    created_at: records.owner.createdAt,
  }));

  const localHostId =
    graph.workspace.installationId === installationId &&
    records.localIdentityBinding.source.kind === "local-peer"
      ? records.localIdentityBinding.source.localHostId
      : fail("local host installation mismatch");
  add(row("local_hosts", ["id"], {
    id: localHostId,
    installation_id: installationId,
    created_at: records.localIdentityBinding.createdAt,
  }));
  add(row("identity_bindings", ["id"], {
    id: records.localIdentityBinding.id,
    installation_id: installationId,
    principal_id: records.owner.id,
    source_kind: "local-peer",
    local_host_id: localHostId,
    subject_id: records.localIdentityBinding.subjectId,
    state: "active",
    revoked_at: null,
    revoked_actor_kind: null,
    revoked_actor_principal_id: null,
    revoked_actor_system_component: null,
    supersedes_binding_id: null,
    created_at: records.localIdentityBinding.createdAt,
  }));
  if (
    records.localEndpoint.address.kind !== "local-client" ||
    records.localEndpoint.audience.kind !== "private"
  ) {
    fail("local endpoint shape changed after validation");
  }
  add(row("endpoints", ["id"], {
    id: records.localEndpoint.id,
    installation_id: installationId,
    address_kind: "local-client",
    local_host_id: records.localEndpoint.address.localHostId,
    local_endpoint_id: records.localEndpoint.address.localEndpointId,
    audience_kind: "private",
    audience_principal_id: records.localEndpoint.audience.principalId,
    created_at: records.localEndpoint.createdAt,
  }));

  for (const grant of records.accessGrants) {
    const granted = actorColumns(grant.grantedBy);
    const resource =
      grant.kind === "session-configuration-use" ? grant.resource : undefined;
    add(row("access_grants", ["id"], {
      id: grant.id,
      kind: grant.kind,
      installation_id: grant.installationId,
      principal_id: grant.principalId,
      role: grant.kind === "installation-role" ? grant.role : null,
      resource_kind: resource?.kind ?? null,
      resource_id: resource?.id ?? null,
      granted_actor_kind: granted.kind,
      granted_actor_principal_id: granted.principalId,
      granted_actor_system_component: granted.systemComponent,
      created_at: grant.createdAt,
      state: "active",
      revoked_at: null,
      revoked_actor_kind: null,
      revoked_actor_principal_id: null,
      revoked_actor_system_component: null,
    }));
  }

  const refs = records.referenceBindings;
  reference(refs.installation.reference, "installation reference");
  add(row("installation_reference_bindings", ["installation_id"], {
    installation_id: installationId,
    reference: refs.installation.reference,
    display_name: refs.installation.displayName,
  }));
  add(row("principal_reference_bindings", ["principal_id"], {
    principal_id: records.owner.id,
    installation_id: installationId,
    reference: reference(refs.owner.reference, "owner reference"),
  }));
  add(row("local_host_reference_bindings", ["local_host_id"], {
    local_host_id: localHostId,
    installation_id: installationId,
    reference: reference(refs.localHost.reference, "local host reference"),
  }));
  add(row("identity_binding_reference_bindings", ["identity_binding_id"], {
    identity_binding_id: records.localIdentityBinding.id,
    installation_id: installationId,
    reference: reference(
      refs.identityBinding.reference,
      "identity binding reference",
    ),
  }));
  add(row(
    "authentication_subject_reference_bindings",
    ["identity_binding_id"],
    {
      identity_binding_id: records.localIdentityBinding.id,
      installation_id: installationId,
      reference: reference(refs.subject.reference, "subject reference"),
      resolution: reference(refs.subject.resolution, "subject resolution"),
      subject_id: refs.subject.authenticationSubjectId,
    },
  ));
  add(row("endpoint_reference_bindings", ["endpoint_id"], {
    endpoint_id: records.localEndpoint.id,
    installation_id: installationId,
    reference: reference(refs.endpoint.reference, "endpoint reference"),
    local_endpoint_id: refs.endpoint.localEndpointId,
  }));

  add(mapIdentityRow("workspaces", graph.workspace));
  add(row("workspace_resources", ["id"], {
    id: graph.workspaceRevision.root.id,
    installation_id: installationId,
    canonical_host_path: graph.workspaceRevision.root.canonicalHostPath,
    sandbox_path: graph.workspaceRevision.root.sandboxPath,
    maximum_access: "read-write",
    created_at: graph.workspace.createdAt,
  }));
  add(row("workspace_revisions", ["id"], {
    id: graph.workspaceRevision.id,
    workspace_id: graph.workspaceRevision.workspaceId,
    revision: graph.workspaceRevision.revision,
    display_name: graph.workspaceRevision.displayName,
    created_at: graph.workspaceRevision.createdAt,
  }));
  add(row(
    "workspace_revision_resources",
    ["workspace_revision_id", "workspace_resource_id"],
    {
      workspace_revision_id: graph.workspaceRevision.id,
      workspace_resource_id: graph.workspaceRevision.root.id,
      ordinal: 0,
      role: "root",
    },
  ));
  add(row("workspace_reference_bindings", ["workspace_id"], {
    workspace_id: graph.workspace.id,
    workspace_revision_id: graph.workspaceRevision.id,
    installation_id: installationId,
    binding_reference: reference(
      refs.workspace.bindingReference,
      "workspace binding reference",
    ),
  }));

  add(mapIdentityRow("execution_policies", graph.executionPolicy));
  for (const capabilityId of graph.executionPolicySnapshot.tools) {
    add(row("tool_capabilities", ["id"], {
      id: capabilityId,
      installation_id: installationId,
    }));
  }
  const execution = graph.executionPolicySnapshot;
  add(row("execution_policy_snapshots", ["id"], {
    id: execution.id,
    policy_id: execution.policyId,
    revision: execution.revision,
    sandbox: execution.sandbox,
    workspace_filesystem: execution.workspaceFilesystem,
    process: execution.process,
    network: execution.network,
    memory_bytes: execution.limits.memoryBytes ?? null,
    max_processes: execution.limits.maxProcesses ?? null,
    temporary_storage_bytes: execution.limits.temporaryStorageBytes ?? null,
    output_bytes: execution.limits.outputBytes ?? null,
    created_at: execution.createdAt,
  }));
  for (const grant of execution.resourceGrants) {
    add(row(
      "execution_policy_resource_grants",
      ["execution_policy_snapshot_id", "workspace_resource_id"],
      {
        execution_policy_snapshot_id: execution.id,
        workspace_resource_id: grant.resourceId,
        access: grant.access,
      },
    ));
  }
  for (const capabilityId of execution.tools) {
    add(row(
      "execution_policy_tool_capabilities",
      ["execution_policy_snapshot_id", "tool_capability_id"],
      {
        execution_policy_snapshot_id: execution.id,
        tool_capability_id: capabilityId,
      },
    ));
  }

  add(mapIdentityRow("turn_policies", graph.turnPolicy));
  const turn = graph.turnPolicySnapshot;
  add(row("turn_policy_snapshots", ["id"], {
    id: turn.id,
    policy_id: turn.policyId,
    revision: turn.revision,
    when_busy: turn.admission.whenBusy,
    max_queued_turns: turn.admission.maxQueuedTurns,
    initial_active_work_ms: turn.timing.initialActiveWorkMs,
    tool_extension_ms: turn.timing.toolExtensionMs,
    maximum_active_work_ms: turn.timing.maximumActiveWorkMs,
    interaction_wait_ms: turn.timing.interactionWaitMs,
    approval: turn.interaction.approval,
    on_approval_timeout: turn.interaction.onApprovalTimeout,
    input_requests: turn.interaction.inputRequests,
    on_input_timeout: turn.interaction.onInputTimeout,
    maximum_before_acceptance_attempts:
      turn.retry.maximumBeforeAcceptanceAttempts,
    after_possible_acceptance: turn.retry.afterPossibleAcceptance,
    maximum_provider_requests: turn.inference.maximumProviderRequests,
    maximum_total_tokens: turn.inference.maximumTotalTokens,
    maximum_output_tokens_per_request:
      turn.inference.maximumOutputTokensPerRequest,
    progress_delivery: turn.output.progressDelivery,
    checkpoint_interval_ms: turn.output.checkpointIntervalMs,
    maximum_checkpoint_characters: turn.output.maximumCheckpointCharacters,
    persist_final_messages: turn.output.persistFinalMessages ? 1 : 0,
    persist_raw_reasoning: turn.output.persistRawReasoning ? 1 : 0,
    persist_raw_tool_input_output: turn.output.persistRawToolInputOutput ? 1 : 0,
    created_at: turn.createdAt,
  }));

  const connection = graph.providerConnection;
  if (connection.transport.mode !== "native-library-sidecar") {
    fail("provider transport changed after validation");
  }
  add(row("providers", ["id"], {
    id: connection.providerId,
    installation_id: installationId,
  }));
  for (const model of connection.models) {
    add(row("models", ["id"], {
      id: model.modelId,
      provider_id: model.providerId,
    }));
  }
  const credential = graph.providerCredentialBinding;
  const created = actorColumns(credential.createdBy);
  add(row("provider_credential_bindings", ["id"], {
    id: credential.id,
    installation_id: credential.installationId,
    provider_id: credential.providerId,
    custody: credential.custody,
    display_name: credential.displayName,
    state: "active",
    revoked_at: null,
    revoked_actor_kind: null,
    revoked_actor_principal_id: null,
    revoked_actor_system_component: null,
    created_actor_kind: created.kind,
    created_actor_principal_id: created.principalId,
    created_actor_system_component: created.systemComponent,
    created_at: credential.createdAt,
    updated_at: credential.updatedAt,
  }));
  add(row("provider_connections", ["id"], {
    id: connection.id,
    installation_id: connection.installationId,
    provider_id: connection.providerId,
    display_name: connection.displayName,
    transport_mode: connection.transport.mode,
    credential_custody: connection.transport.credentialCustody,
    bridge_id: connection.transport.bridgeId,
    native_stack: connection.transport.nativeStack,
    native_stack_version: connection.transport.nativeStackVersion,
    bridge_protocol_version: connection.transport.bridgeProtocolVersion,
    native_catalog_digest: connection.transport.nativeCatalogDigest,
    credential_resolver_id: connection.transport.credentialResolverId,
    native_retries: connection.transport.nativeRetries,
    invocation: connection.transport.invocation,
    transport_metadata_json: canonicalJson({}),
    integrity_digest: connection.integrityDigest,
    created_at: connection.createdAt,
  }));
  for (const origin of connection.allowedUpstreamOrigins) {
    add(row(
      "provider_connection_origins",
      ["provider_connection_id", "origin"],
      { provider_connection_id: connection.id, origin },
    ));
  }
  for (const model of connection.models) {
    if (
      model.imageInput.kind !== "supported" ||
      model.reasoning.kind !== "portable-efforts"
    ) {
      fail("provider model changed after validation");
    }
    add(row(
      "provider_model_manifests",
      ["provider_connection_id", "model_id"],
      {
        provider_connection_id: connection.id,
        provider_id: model.providerId,
        model_id: model.modelId,
        api_protocol_id: model.apiProtocolId,
        context_window_tokens: model.contextWindowTokens,
        maximum_output_tokens: model.maximumOutputTokens,
        token_estimator_id: model.tokenEstimatorId,
        image_input_kind: model.imageInput.kind,
        maximum_images_per_request:
          model.imageInput.maximumImagesPerRequest,
        maximum_image_bytes_each: model.imageInput.maximumImageBytesEach,
        maximum_total_image_bytes_per_request:
          model.imageInput.maximumTotalImageBytesPerRequest,
        tools: model.tools,
        reasoning_kind: model.reasoning.kind,
        agent_default_supported: model.reasoning.agentDefaultSupported ? 1 : 0,
        native_model_metadata_json: canonicalJson(model.nativeModelMetadata),
        integrity_digest: model.integrityDigest,
      },
    ));
    for (const mimeType of model.imageInput.acceptedMimeTypes) {
      add(row(
        "provider_model_image_mime_types",
        ["provider_connection_id", "model_id", "mime_type"],
        {
          provider_connection_id: connection.id,
          model_id: model.modelId,
          mime_type: mimeType,
        },
      ));
    }
    for (const effort of model.reasoning.supportedEfforts) {
      add(row(
        "provider_model_reasoning_efforts",
        ["provider_connection_id", "model_id", "effort"],
        {
          provider_connection_id: connection.id,
          model_id: model.modelId,
          effort,
        },
      ));
    }
  }

  add(mapIdentityRow("agent_profiles", graph.agentProfile));
  add(row("agent_drivers", ["id"], {
    id: graph.agentProfileRevision.driverId,
    installation_id: installationId,
  }));
  const profile = graph.agentProfileRevision;
  const defaultModel =
    profile.defaultModel ??
    fail("first-slice profile must define one default model");
  const skills =
    profile.resourcePolicy.skills.mode === "pinned"
      ? profile.resourcePolicy.skills
      : fail("first-slice skills policy must be pinned");
  const extensionsPolicy =
    profile.resourcePolicy.extensions.mode === "granted-only"
      ? profile.resourcePolicy.extensions
      : fail("first-slice extension policy must be granted-only");
  add(row("agent_profile_revisions", ["id"], {
    id: profile.id,
    profile_id: profile.profileId,
    revision: profile.revision,
    driver_id: profile.driverId,
    display_name: profile.displayName,
    default_provider_id: defaultModel.providerId,
    default_model_id: defaultModel.modelId,
    default_reasoning_kind: profile.defaultReasoning.kind,
    default_reasoning_effort: null,
    skills_mode: profile.resourcePolicy.skills.mode,
    prompt_templates_mode: profile.resourcePolicy.promptTemplates.mode,
    themes_mode: profile.resourcePolicy.themes.mode,
    project_resources_mode: skills.projectResources,
    extensions_mode: profile.resourcePolicy.extensions.mode,
    extension_discovery: extensionsPolicy.discovery,
    extension_hot_reload: extensionsPolicy.hotReload ? 1 : 0,
    extension_prompt_lifecycle: extensionsPolicy.promptLifecycle,
    configuration_json: canonicalJson(profile.configuration),
    created_at: profile.createdAt,
  }));
  for (const allowance of profile.providers) {
    if (allowance.models.kind !== "allowlist") {
      fail("first-slice provider allowance must be an allowlist");
    }
    add(row(
      "agent_profile_provider_allowances",
      ["agent_profile_revision_id", "provider_id"],
      {
        agent_profile_revision_id: profile.id,
        provider_id: allowance.providerId,
        provider_connection_id: allowance.providerConnectionId,
        models_kind: allowance.models.kind,
      },
    ));
    for (const modelId of allowance.models.modelIds) {
      add(row(
        "agent_profile_allowance_models",
        ["agent_profile_revision_id", "provider_id", "model_id"],
        {
          agent_profile_revision_id: profile.id,
          provider_id: allowance.providerId,
          model_id: modelId,
        },
      ));
    }
  }

  for (const resource of graph.agentResourceSnapshots) {
    add(row("agent_resource_snapshots", ["id"], {
      id: resource.id,
      kind: resource.kind,
      source_kind: resource.source.kind,
      display_name: resource.displayName,
      integrity_digest: resource.integrityDigest,
      created_at: resource.createdAt,
    }));
  }
  graph.extensions.forEach((extension) =>
    add(mapIdentityRow("extensions", extension)),
  );
  for (const revision of graph.extensionRevisions) {
    add(row("extension_revisions", ["id"], {
      id: revision.id,
      extension_id: revision.extensionId,
      revision: revision.revision,
      display_name: revision.displayName,
      integrity_digest: revision.integrityDigest,
      configuration_schema_json: canonicalJson(revision.configurationSchema),
      created_at: revision.createdAt,
    }));
  }
  const extensionCapabilities = new Set<string>();
  for (const grant of graph.extensionGrantSnapshots) {
    add(row("extension_grant_snapshots", ["id"], {
      id: grant.id,
      extension_id: grant.extensionId,
      extension_revision_id: grant.extensionRevisionId,
      integrity_digest: grant.integrityDigest,
      loading: grant.loading,
      configuration_json: canonicalJson(grant.configuration),
      prompt_lifecycle: grant.promptLifecycle,
      created_at: grant.createdAt,
    }));
    for (const capabilityId of grant.capabilities) {
      if (!extensionCapabilities.has(capabilityId)) {
        extensionCapabilities.add(capabilityId);
        add(row("extension_capabilities", ["id"], { id: capabilityId }));
      }
      add(row(
        "extension_grant_capabilities",
        ["extension_grant_snapshot_id", "extension_capability_id"],
        {
          extension_grant_snapshot_id: grant.id,
          extension_capability_id: capabilityId,
        },
      ));
    }
  }
  profile.agentResourceSnapshotIds.forEach((resourceId, ordinal) =>
    add(row(
      "agent_profile_resource_snapshots",
      ["agent_profile_revision_id", "agent_resource_snapshot_id"],
      {
        agent_profile_revision_id: profile.id,
        agent_resource_snapshot_id: resourceId,
        ordinal,
      },
    )),
  );
  profile.extensionGrantSnapshotIds.forEach((grantId, ordinal) =>
    add(row(
      "agent_profile_extension_grants",
      ["agent_profile_revision_id", "extension_grant_snapshot_id"],
      {
        agent_profile_revision_id: profile.id,
        extension_grant_snapshot_id: grantId,
        ordinal,
      },
    )),
  );

  for (const binding of records.artifactBindings.declarative) {
    decodeIntegrityDigest(binding.integrityDigest);
    add(row(
      "agent_resource_artifact_bindings",
      ["agent_resource_snapshot_id"],
      {
        agent_resource_snapshot_id: binding.agentResourceSnapshotId,
        artifact_reference: reference(
          binding.artifactReference,
          "agent resource artifact reference",
        ),
        integrity_digest: binding.integrityDigest,
      },
    ));
  }
  for (const binding of records.artifactBindings.extensions) {
    decodeIntegrityDigest(binding.integrityDigest);
    add(row("extension_artifact_bindings", ["extension_revision_id"], {
      extension_revision_id: binding.extensionRevisionId,
      artifact_reference: reference(
        binding.artifactReference,
        "extension artifact reference",
      ),
      integrity_digest: binding.integrityDigest,
    }));
  }
  const providerArtifact = records.artifactBindings.provider;
  decodeIntegrityDigest(providerArtifact.bridgeArtifactDigest);
  decodeIntegrityDigest(providerArtifact.nativeStackDigest);
  decodeIntegrityDigest(providerArtifact.nativeCatalogDigest);
  add(row("provider_artifact_bindings", ["provider_connection_id"], {
    provider_connection_id: providerArtifact.providerConnectionId,
    bridge_id: providerArtifact.bridgeId,
    bridge_artifact_digest: providerArtifact.bridgeArtifactDigest,
    native_stack: providerArtifact.nativeStack,
    native_stack_version: providerArtifact.nativeStackVersion,
    native_stack_digest: providerArtifact.nativeStackDigest,
    native_catalog_digest: providerArtifact.nativeCatalogDigest,
  }));

  const rowIdentities = new Set<string>();
  for (const item of rows) {
    const keyValues = item.primaryKey.map((column) => {
      const index = item.columns.indexOf(column);
      return item.values[index]!;
    });
    const identity = canonicalJson([
      item.table,
      ...keyValues,
    ] as JsonValue);
    if (rowIdentities.has(identity)) {
      fail(`duplicate primary key projected for ${item.table}`);
    }
    rowIdentities.add(identity);
  }
  const immutableRows = Object.freeze(rows);
  const semanticRows = immutableRows
    .map((item) => [
      item.table,
      item.primaryKey,
      item.columns,
      item.values,
    ] as JsonValue)
    .sort((left, right) => {
      const encodedLeft = canonicalJson(left);
      const encodedRight = canonicalJson(right);
      return encodedLeft < encodedRight
        ? -1
        : encodedLeft > encodedRight
          ? 1
          : 0;
    });
  const semanticDigest = digestCanonicalJson(
    semanticRows,
  );
  return Object.freeze({
    schemaDigest: HITCH_V2_SCHEMA_DIGEST as IntegrityDigest,
    semanticDigest,
    rows: immutableRows,
  });
}

import { encodeCanonicalJson } from "../codecs/json.js";
import { decodeIsoTimestamp, decodeServiceId } from "../codecs/primitives.js";
import type {
  AcceptedLocalConnectorConnection,
  AuthenticatedConnectorContext,
  Clock,
  ConnectorAuthenticationResult,
  IdSource,
  LocalConnectorAuthenticationPort,
} from "../model/application.js";
import type { AuthenticatedPrincipal } from "../model/identity-access.js";
import type {
  AuditEnvelopeId,
  AuthenticationRequestId,
  EndpointId,
  IdentityBindingId,
  InstallationId,
  LocalHostId,
  PrincipalId,
} from "../model/primitives.js";
import { insertAuditEnvelope } from "../persistence/audit-repository.js";
import type {
  SQLiteBindValue,
  SQLiteRow,
  V2Database,
  V2RepositoryTransaction,
} from "../persistence/database.js";

export interface LocalConnectorAuthenticationOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/**
 * Narrow capability passed only to the verified Unix-socket listener. Merely
 * having a structural object cannot create an accepted connection.
 */
export interface LocalConnectorConnectionIssuer {
  issueAcceptedConnection(): AcceptedLocalConnectorConnection;
}

/**
 * Narrow capability used by application services at their trusted boundary.
 * Authentication contexts remain authoritative only by exact object identity.
 */
export interface AuthenticatedConnectorContextVerifier {
  isAuthentic(context: AuthenticatedConnectorContext): boolean;
}

export interface LocalConnectorAuthenticationBundle {
  readonly connectionIssuer: LocalConnectorConnectionIssuer;
  readonly authentication: LocalConnectorAuthenticationPort;
  readonly contextVerifier: AuthenticatedConnectorContextVerifier;
}

export class LocalConnectorTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConnectorTrustError";
  }
}

export class LocalAuthenticationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAuthenticationStateError";
  }
}

interface AuthenticationCandidate {
  readonly installationId: InstallationId;
  readonly bindingId: IdentityBindingId;
  readonly principalId: PrincipalId;
  readonly localHostId: LocalHostId;
  readonly bindingState: "active" | "revoked";
  readonly principalState: "active" | "disabled";
}

interface AuthenticationDecision {
  readonly requestId: AuthenticationRequestId;
  readonly installationId: InstallationId;
  readonly decidedAt: ReturnType<typeof decodeIsoTimestamp>;
  readonly outcome:
    | {
        readonly status: "authenticated";
        readonly principalId: PrincipalId;
        readonly identityBindingId: IdentityBindingId;
        readonly endpointId: EndpointId;
      }
    | {
        readonly status: "rejected";
        readonly reason:
          | "unknown-binding"
          | "binding-revoked"
          | "principal-disabled";
      };
}

function requiredText(
  row: SQLiteRow,
  column: string,
  label: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new LocalAuthenticationStateError(
      `durable ${label} is invalid`,
    );
  }
  return value;
}

function requiredCount(
  transaction: V2RepositoryTransaction,
  sql: string,
  parameters: readonly SQLiteBindValue[] = [],
): number {
  const row = transaction.get(sql, parameters);
  if (
    row === undefined ||
    typeof row.count !== "number" ||
    !Number.isSafeInteger(row.count) ||
    row.count < 0
  ) {
    throw new LocalAuthenticationStateError(
      "cannot determine durable authentication baseline",
    );
  }
  return row.count;
}

function readPublishedInstallation(
  transaction: V2RepositoryTransaction,
): InstallationId {
  const installations = transaction.all("SELECT id FROM installations");
  if (installations.length !== 1) {
    throw new LocalAuthenticationStateError(
      "local authentication requires exactly one installation",
    );
  }
  const installationId = decodeServiceId(
    "Installation",
    requiredText(installations[0]!, "id", "installation identifier"),
  );
  assertPublishedRow(
    transaction,
    installationId,
    "installations",
    [installationId],
    "installation",
  );
  return installationId;
}

type AuthenticationFoundationTable =
  | "installations"
  | "principals"
  | "local_hosts"
  | "identity_bindings"
  | "endpoints";

function assertPublishedRow(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  table: AuthenticationFoundationTable,
  primaryKey: readonly string[],
  label: string,
): void {
  const count = requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM bootstrap_publication_rows AS publication
      JOIN audit_envelopes AS first_audit
        ON first_audit.id = publication.first_published_audit_id
      WHERE publication.table_name = ?
        AND publication.primary_key_json = ?
        AND first_audit.installation_id = ?
        AND first_audit.actor_kind = 'bootstrap'
        AND first_audit.outcome = 'succeeded'
        AND first_audit.action = 'installation-published'`,
    [table, encodeCanonicalJson(primaryKey), installationId],
  );
  if (count !== 1) {
    throw new LocalAuthenticationStateError(
      `durable ${label} has no exact bootstrap publication provenance`,
    );
  }
}

function decodeCandidate(
  installationId: InstallationId,
  row: SQLiteRow,
): AuthenticationCandidate {
  const bindingState = requiredText(
    row,
    "binding_state",
    "identity-binding state",
  );
  const principalState = requiredText(
    row,
    "principal_state",
    "principal state",
  );
  if (bindingState !== "active" && bindingState !== "revoked") {
    throw new LocalAuthenticationStateError(
      "durable identity-binding state is unsupported",
    );
  }
  if (principalState !== "active" && principalState !== "disabled") {
    throw new LocalAuthenticationStateError(
      "durable principal state is unsupported",
    );
  }
  if (requiredText(row, "source_kind", "authentication source") !== "local-peer") {
    throw new LocalAuthenticationStateError(
      "first-slice authentication source is unsupported",
    );
  }
  return Object.freeze({
    installationId,
    bindingId: decodeServiceId(
      "IdentityBinding",
      requiredText(row, "binding_id", "identity-binding identifier"),
    ),
    principalId: decodeServiceId(
      "Principal",
      requiredText(row, "principal_id", "principal identifier"),
    ),
    localHostId: decodeServiceId(
      "LocalHost",
      requiredText(
        row,
        "local_host_id",
        "local-host identifier",
      ),
    ),
    bindingState,
    principalState,
  });
}

function readUniqueCandidate(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
): AuthenticationCandidate | undefined {
  const bindingCount = requiredCount(
    transaction,
    `SELECT COUNT(*) AS count
      FROM identity_bindings
      WHERE installation_id = ?`,
    [installationId],
  );
  if (bindingCount === 0) return undefined;
  if (bindingCount !== 1) {
    throw new LocalAuthenticationStateError(
      "local authentication identity binding is ambiguous",
    );
  }
  const rows = transaction.all(
    `SELECT
      identity_bindings.id AS binding_id,
      identity_bindings.principal_id AS principal_id,
      identity_bindings.local_host_id AS local_host_id,
      identity_bindings.source_kind AS source_kind,
      identity_bindings.state AS binding_state,
      principals.state AS principal_state
    FROM identity_bindings
    JOIN principals
      ON principals.id = identity_bindings.principal_id
      AND principals.installation_id = identity_bindings.installation_id
    JOIN local_hosts
      ON local_hosts.id = identity_bindings.local_host_id
      AND local_hosts.installation_id = identity_bindings.installation_id
    WHERE identity_bindings.installation_id = ?`,
    [installationId],
  );
  if (rows.length !== 1) {
    throw new LocalAuthenticationStateError(
      "local authentication identity graph is incomplete",
    );
  }
  const candidate = decodeCandidate(installationId, rows[0]!);
  assertPublishedRow(
    transaction,
    installationId,
    "principals",
    [candidate.principalId],
    "principal",
  );
  assertPublishedRow(
    transaction,
    installationId,
    "local_hosts",
    [candidate.localHostId],
    "local host",
  );
  assertPublishedRow(
    transaction,
    installationId,
    "identity_bindings",
    [candidate.bindingId],
    "identity binding",
  );
  return candidate;
}

function readUniqueEndpoint(
  transaction: V2RepositoryTransaction,
  candidate: AuthenticationCandidate,
): EndpointId {
  const rows = transaction.all(
    `SELECT id
    FROM endpoints
    WHERE installation_id = ?
      AND address_kind = 'local-client'
      AND local_host_id = ?
      AND audience_kind = 'private'
      AND audience_principal_id = ?`,
    [
      candidate.installationId,
      candidate.localHostId,
      candidate.principalId,
    ],
  );
  if (rows.length !== 1) {
    throw new LocalAuthenticationStateError(
      "local authentication endpoint mapping is missing or ambiguous",
    );
  }
  const endpointId = decodeServiceId(
    "Endpoint",
    requiredText(rows[0]!, "id", "endpoint identifier"),
  );
  assertPublishedRow(
    transaction,
    candidate.installationId,
    "endpoints",
    [endpointId],
    "local endpoint",
  );
  return endpointId;
}

function insertAuthenticationRequest(
  transaction: V2RepositoryTransaction,
  decision: AuthenticationDecision,
): void {
  const authenticated =
    decision.outcome.status === "authenticated"
      ? decision.outcome
      : undefined;
  const rejected =
    decision.outcome.status === "rejected"
      ? decision.outcome
      : undefined;
  const result = transaction.run(
    `INSERT INTO authentication_requests (
      id, installation_id, evidence_kind, socket_security,
      binding_source_kind, outcome_status, principal_id, identity_binding_id, assurance,
      rejection_reason, decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.requestId,
      decision.installationId,
      "local-peer-owner-socket",
      "service-owned-0700-parent-and-0600-socket",
      authenticated === undefined ? null : "local-peer",
      decision.outcome.status,
      authenticated?.principalId ?? null,
      authenticated?.identityBindingId ?? null,
      authenticated === undefined ? null : "normal",
      rejected?.reason ?? null,
      decision.decidedAt,
    ],
  );
  if (result.changes !== 1) {
    throw new LocalAuthenticationStateError(
      "authentication request insert did not affect exactly one row",
    );
  }
}

function decideAuthentication(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  requestId: AuthenticationRequestId,
  decidedAt: ReturnType<typeof decodeIsoTimestamp>,
): AuthenticationDecision {
  const candidate = readUniqueCandidate(transaction, installationId);
  if (candidate === undefined) {
    return Object.freeze({
      requestId,
      installationId,
      decidedAt,
      outcome: Object.freeze({
        status: "rejected" as const,
        reason: "unknown-binding" as const,
      }),
    });
  }
  if (candidate.bindingState === "revoked") {
    return Object.freeze({
      requestId,
      installationId,
      decidedAt,
      outcome: Object.freeze({
        status: "rejected" as const,
        reason: "binding-revoked" as const,
      }),
    });
  }
  if (candidate.principalState === "disabled") {
    return Object.freeze({
      requestId,
      installationId,
      decidedAt,
      outcome: Object.freeze({
        status: "rejected" as const,
        reason: "principal-disabled" as const,
      }),
    });
  }
  const endpointId = readUniqueEndpoint(transaction, candidate);
  return Object.freeze({
    requestId,
    installationId,
    decidedAt,
    outcome: Object.freeze({
      status: "authenticated" as const,
      principalId: candidate.principalId,
      identityBindingId: candidate.bindingId,
      endpointId,
    }),
  });
}

function recordAuthentication(
  transaction: V2RepositoryTransaction,
  decision: AuthenticationDecision,
  auditId: AuditEnvelopeId,
): void {
  insertAuthenticationRequest(transaction, decision);
  insertAuditEnvelope(transaction, {
    id: auditId,
    installationId: decision.installationId,
    actor: { kind: "system", component: "local-connector" },
    outcome:
      decision.outcome.status === "authenticated"
        ? "succeeded"
        : "denied",
    action: "authentication-recorded",
    authenticationRequestId: decision.requestId,
    occurredAt: decision.decidedAt,
  });
}

function mintContext(
  decision: AuthenticationDecision & {
    readonly outcome: Extract<
      AuthenticationDecision["outcome"],
      { readonly status: "authenticated" }
    >;
  },
): AuthenticatedConnectorContext {
  const actor: AuthenticatedPrincipal = Object.freeze({
    kind: "authenticated-principal",
    principalId: decision.outcome.principalId,
    identityBindingId: decision.outcome.identityBindingId,
    method: "local-peer",
    assurance: "normal",
    requestId: decision.requestId,
    authenticatedAt: decision.decidedAt,
  });
  return Object.freeze({
    actor,
    endpointId: decision.outcome.endpointId,
  }) as AuthenticatedConnectorContext;
}

/**
 * Creates one runtime-local trust domain. Composition passes its three narrow
 * capabilities to the socket listener, authentication adapter, and
 * application services respectively; none can manufacture another's values.
 */
export function createLocalConnectorAuthentication(
  options: LocalConnectorAuthenticationOptions,
): LocalConnectorAuthenticationBundle {
  const acceptedConnections = new WeakSet<object>();
  const authenticatedContexts = new WeakSet<object>();

  const connectionIssuer: LocalConnectorConnectionIssuer = Object.freeze({
    issueAcceptedConnection(): AcceptedLocalConnectorConnection {
      const connection = Object.freeze(
        {},
      ) as AcceptedLocalConnectorConnection;
      acceptedConnections.add(connection);
      return connection;
    },
  });

  const authentication: LocalConnectorAuthenticationPort = Object.freeze({
    async authenticate(
      connection: AcceptedLocalConnectorConnection,
    ): Promise<ConnectorAuthenticationResult> {
      if (
        typeof connection !== "object" ||
        connection === null ||
        !acceptedConnections.delete(connection)
      ) {
        throw new LocalConnectorTrustError(
          "connection was not issued by this local trust domain or was already consumed",
        );
      }
      const decidedAt = decodeIsoTimestamp(options.clock.now());
      const requestId = decodeServiceId(
        "AuthenticationRequest",
        options.ids.next("AuthenticationRequest"),
      );
      const auditId = decodeServiceId(
        "AuditEnvelope",
        options.ids.next("AuditEnvelope"),
      );
      const decision = options.database.transaction((transaction) => {
        const installationId = readPublishedInstallation(transaction);
        const next = decideAuthentication(
          transaction,
          installationId,
          requestId,
          decidedAt,
        );
        recordAuthentication(transaction, next, auditId);
        return next;
      });
      if (decision.outcome.status === "rejected") {
        return Object.freeze({
          status: "rejected" as const,
          authenticationRequestId: decision.requestId,
          reason: decision.outcome.reason,
        });
      }
      const context = mintContext(
        decision as AuthenticationDecision & {
          readonly outcome: Extract<
            AuthenticationDecision["outcome"],
            { readonly status: "authenticated" }
          >;
        },
      );
      authenticatedContexts.add(context);
      return Object.freeze({
        status: "authenticated" as const,
        context,
      });
    },
  });

  const contextVerifier: AuthenticatedConnectorContextVerifier =
    Object.freeze({
      isAuthentic(context: AuthenticatedConnectorContext): boolean {
        return (
          typeof context === "object" &&
          context !== null &&
          authenticatedContexts.has(context)
        );
      },
    });

  return Object.freeze({
    connectionIssuer,
    authentication,
    contextVerifier,
  });
}

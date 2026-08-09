import { encodeCanonicalJson } from "../codecs/json.js";
import { decodeIsoTimestamp, decodeServiceId } from "../codecs/primitives.js";
import type {
  AuthenticatedConnectorContext,
  Clock,
  ConnectorAuthenticationResult,
  IdSource,
  RemoteConnectorAuthenticationPort,
  VerifiedClientCertificateEvidence,
} from "../model/application.js";
import type { AuthenticatedPrincipal } from "../model/identity-access.js";
import type {
  AuditEnvelopeId,
  AuthenticationRequestId,
  ClientCertificateFingerprint,
  ClientCertificateTrustRootId,
  EndpointId,
  IdentityBindingId,
  InstallationId,
  PrincipalId,
} from "../model/primitives.js";
import type { VerifiedClientCertificateEvidenceConsumer } from "../connectors/remote/certificate-verification.js";
import { insertAuditEnvelope } from "../persistence/audit-repository.js";
import type {
  SQLiteRow,
  V2Database,
  V2RepositoryTransaction,
} from "../persistence/database.js";
import type { AuthenticatedConnectorContextVerifier } from "./local-authentication.js";

export interface RemoteConnectorAuthenticationOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly evidenceConsumer: VerifiedClientCertificateEvidenceConsumer;
}

export interface RemoteConnectorAuthenticationBundle {
  readonly authentication: RemoteConnectorAuthenticationPort;
  readonly contextVerifier: AuthenticatedConnectorContextVerifier;
}

export class RemoteAuthenticationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteAuthenticationStateError";
  }
}

interface RemoteBindingCandidate {
  readonly bindingId: IdentityBindingId;
  readonly principalId: PrincipalId;
  readonly bindingState: "active" | "revoked";
  readonly principalState: "active" | "disabled";
}

interface RemoteAuthenticationDecision {
  readonly requestId: AuthenticationRequestId;
  readonly installationId: InstallationId;
  readonly trustRootId: ClientCertificateTrustRootId;
  readonly fingerprint: ClientCertificateFingerprint;
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

function requiredText(row: SQLiteRow, column: string, label: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new RemoteAuthenticationStateError(`durable ${label} is invalid`);
  }
  return value;
}

function readInstallation(
  transaction: V2RepositoryTransaction,
): InstallationId {
  const rows = transaction.all("SELECT id FROM installations");
  if (rows.length !== 1) {
    throw new RemoteAuthenticationStateError(
      "remote authentication requires exactly one installation",
    );
  }
  const installationId = decodeServiceId(
    "Installation",
    requiredText(rows[0]!, "id", "installation identifier"),
  );
  const publication = transaction.get(
    `SELECT COUNT(*) AS count
    FROM bootstrap_publication_rows AS publication
    JOIN audit_envelopes AS first_audit
      ON first_audit.id = publication.first_published_audit_id
    WHERE publication.table_name = 'installations'
      AND publication.primary_key_json = ?
      AND first_audit.installation_id = ?
      AND first_audit.actor_kind = 'bootstrap'
      AND first_audit.outcome = 'succeeded'
      AND first_audit.action = 'installation-published'`,
    [encodeCanonicalJson([installationId]), installationId],
  );
  if (publication?.count !== 1) {
    throw new RemoteAuthenticationStateError(
      "remote authentication installation lacks bootstrap provenance",
    );
  }
  return installationId;
}

function decodeCandidate(row: SQLiteRow): RemoteBindingCandidate {
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
    throw new RemoteAuthenticationStateError(
      "durable identity-binding state is unsupported",
    );
  }
  if (principalState !== "active" && principalState !== "disabled") {
    throw new RemoteAuthenticationStateError(
      "durable principal state is unsupported",
    );
  }
  return Object.freeze({
    bindingId: decodeServiceId(
      "IdentityBinding",
      requiredText(row, "binding_id", "identity-binding identifier"),
    ),
    principalId: decodeServiceId(
      "Principal",
      requiredText(row, "principal_id", "principal identifier"),
    ),
    bindingState,
    principalState,
  });
}

function readCandidates(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  trustRootId: ClientCertificateTrustRootId,
  fingerprint: ClientCertificateFingerprint,
): readonly RemoteBindingCandidate[] {
  return transaction.all(
    `SELECT
      identity_bindings.id AS binding_id,
      identity_bindings.principal_id AS principal_id,
      identity_bindings.state AS binding_state,
      principals.state AS principal_state
    FROM identity_bindings
    JOIN principals
      ON principals.id = identity_bindings.principal_id
      AND principals.installation_id = identity_bindings.installation_id
    WHERE identity_bindings.installation_id = ?
      AND identity_bindings.source_kind = 'mtls-client'
      AND identity_bindings.client_trust_root_id = ?
      AND identity_bindings.subject_id = ?`,
    [installationId, trustRootId, fingerprint],
  ).map(decodeCandidate);
}

function readRemoteEndpoint(
  transaction: V2RepositoryTransaction,
  installationId: InstallationId,
  candidate: RemoteBindingCandidate,
): EndpointId {
  const rows = transaction.all(
    `SELECT id FROM endpoints
    WHERE installation_id = ?
      AND address_kind = 'remote-client'
      AND identity_binding_id = ?
      AND identity_binding_source_kind = 'mtls-client'
      AND audience_kind = 'private'
      AND audience_principal_id = ?`,
    [installationId, candidate.bindingId, candidate.principalId],
  );
  if (rows.length !== 1) {
    throw new RemoteAuthenticationStateError(
      "remote authentication endpoint mapping is missing or ambiguous",
    );
  }
  return decodeServiceId(
    "Endpoint",
    requiredText(rows[0]!, "id", "endpoint identifier"),
  );
}

function decideAuthentication(
  transaction: V2RepositoryTransaction,
  input: Omit<RemoteAuthenticationDecision, "installationId" | "outcome">,
): RemoteAuthenticationDecision {
  const installationId = readInstallation(transaction);
  const candidates = readCandidates(
    transaction,
    installationId,
    input.trustRootId,
    input.fingerprint,
  );
  const active = candidates.filter(
    (candidate) => candidate.bindingState === "active",
  );
  if (active.length > 1) {
    throw new RemoteAuthenticationStateError(
      "remote authentication identity binding is ambiguous",
    );
  }
  if (active.length === 0) {
    return Object.freeze({
      ...input,
      installationId,
      outcome: Object.freeze({
        status: "rejected" as const,
        reason: candidates.length === 0
          ? "unknown-binding" as const
          : "binding-revoked" as const,
      }),
    });
  }
  const candidate = active[0]!;
  if (candidate.principalState === "disabled") {
    return Object.freeze({
      ...input,
      installationId,
      outcome: Object.freeze({
        status: "rejected" as const,
        reason: "principal-disabled" as const,
      }),
    });
  }
  return Object.freeze({
    ...input,
    installationId,
    outcome: Object.freeze({
      status: "authenticated" as const,
      principalId: candidate.principalId,
      identityBindingId: candidate.bindingId,
      endpointId: readRemoteEndpoint(
        transaction,
        installationId,
        candidate,
      ),
    }),
  });
}

function insertAuthenticationRequest(
  transaction: V2RepositoryTransaction,
  decision: RemoteAuthenticationDecision,
): void {
  const authenticated = decision.outcome.status === "authenticated"
    ? decision.outcome
    : undefined;
  const rejected = decision.outcome.status === "rejected"
    ? decision.outcome
    : undefined;
  const result = transaction.run(
    `INSERT INTO authentication_requests (
      id, installation_id, evidence_kind, client_trust_root_id,
      client_certificate_fingerprint, binding_source_kind, outcome_status,
      principal_id, identity_binding_id, assurance, rejection_reason,
      decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.requestId,
      decision.installationId,
      "mtls-client-certificate",
      decision.trustRootId,
      decision.fingerprint,
      authenticated === undefined ? null : "mtls-client",
      decision.outcome.status,
      authenticated?.principalId ?? null,
      authenticated?.identityBindingId ?? null,
      authenticated === undefined ? null : "normal",
      rejected?.reason ?? null,
      decision.decidedAt,
    ],
  );
  if (result.changes !== 1) {
    throw new RemoteAuthenticationStateError(
      "remote authentication request insert did not affect exactly one row",
    );
  }
}

function recordAuthentication(
  transaction: V2RepositoryTransaction,
  decision: RemoteAuthenticationDecision,
  auditId: AuditEnvelopeId,
): void {
  insertAuthenticationRequest(transaction, decision);
  insertAuditEnvelope(transaction, {
    id: auditId,
    installationId: decision.installationId,
    actor: { kind: "system", component: "remote-ingress" },
    outcome: decision.outcome.status === "authenticated"
      ? "succeeded"
      : "denied",
    action: "authentication-recorded",
    authenticationRequestId: decision.requestId,
    occurredAt: decision.decidedAt,
  });
}

function mintContext(
  decision: RemoteAuthenticationDecision & {
    readonly outcome: Extract<
      RemoteAuthenticationDecision["outcome"],
      { readonly status: "authenticated" }
    >;
  },
): AuthenticatedConnectorContext {
  const actor: AuthenticatedPrincipal = Object.freeze({
    kind: "authenticated-principal",
    principalId: decision.outcome.principalId,
    identityBindingId: decision.outcome.identityBindingId,
    method: "mtls-client",
    assurance: "normal",
    requestId: decision.requestId,
    authenticatedAt: decision.decidedAt,
  });
  return Object.freeze({
    actor,
    endpointId: decision.outcome.endpointId,
  }) as AuthenticatedConnectorContext;
}

/** Resolves verified transport evidence into one process-local context. */
export function createRemoteConnectorAuthentication(
  options: RemoteConnectorAuthenticationOptions,
): RemoteConnectorAuthenticationBundle {
  const authenticatedContexts = new WeakSet<object>();
  const authentication: RemoteConnectorAuthenticationPort = Object.freeze({
    async authenticate(
      evidence: VerifiedClientCertificateEvidence,
    ): Promise<ConnectorAuthenticationResult> {
      const material = options.evidenceConsumer.consume(evidence);
      const input = Object.freeze({
        requestId: decodeServiceId(
          "AuthenticationRequest",
          options.ids.next("AuthenticationRequest"),
        ),
        trustRootId: material.trustRootId,
        fingerprint: material.fingerprint,
        decidedAt: decodeIsoTimestamp(options.clock.now()),
      });
      const auditId = decodeServiceId(
        "AuditEnvelope",
        options.ids.next("AuditEnvelope"),
      );
      const decision = options.database.transaction((transaction) => {
        const next = decideAuthentication(transaction, input);
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
        decision as RemoteAuthenticationDecision & {
          readonly outcome: Extract<
            RemoteAuthenticationDecision["outcome"],
            { readonly status: "authenticated" }
          >;
        },
      );
      authenticatedContexts.add(context);
      return Object.freeze({ status: "authenticated" as const, context });
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
  return Object.freeze({ authentication, contextVerifier });
}

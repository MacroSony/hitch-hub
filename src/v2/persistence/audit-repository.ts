import { decodeAuditEnvelope } from "../codecs/audit-events.js";
import type { AuditEnvelope } from "../model/records.js";
import type { V2RepositoryTransaction } from "./database.js";

export class AuditRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditRepositoryError";
  }
}

function correlation(
  envelope: AuditEnvelope,
  field:
    | "authenticationRequestId"
    | "identityBindingId"
    | "accessGrantId"
    | "sessionId"
    | "sessionSpecId"
    | "endpointBindingId"
    | "attachmentId"
    | "turnId"
    | "attemptId"
    | "messageId"
    | "interactionId"
    | "interactionResponseId"
    | "workerLeaseId"
    | "credentialLeaseId"
    | "resumeHandleId"
    | "reservationId"
    | "forwardingAttemptId"
    | "deliveryId"
    | "deliveryAttemptId",
): string | null {
  return field in envelope
    ? (envelope as unknown as Record<string, string>)[field] ?? null
    : null;
}

/**
 * Appends one allowlisted content-free audit envelope inside its caller's
 * authoritative transaction.
 */
export function insertAuditEnvelope<Envelope extends AuditEnvelope>(
  transaction: V2RepositoryTransaction,
  input: Envelope,
): Envelope;
export function insertAuditEnvelope(
  transaction: V2RepositoryTransaction,
  input: AuditEnvelope,
): AuditEnvelope {
  const envelope = decodeAuditEnvelope(input);
  const actorPrincipalId =
    envelope.actor.kind === "principal"
      ? envelope.actor.principalId
      : null;
  const systemComponent =
    envelope.actor.kind === "system" ? envelope.actor.component : null;
  const result = transaction.run(
    `INSERT INTO audit_envelopes (
      id, installation_id, actor_kind, actor_principal_id, system_component,
      outcome, action, authentication_request_id, identity_binding_id,
      access_grant_id, session_id, session_spec_id, endpoint_binding_id,
      attachment_id,
      turn_id, attempt_id, turn_message_id, interaction_id,
      interaction_response_id, worker_lease_id, credential_lease_id,
      resume_handle_id, reservation_id, forwarding_attempt_id, delivery_id,
      delivery_attempt_id, occurred_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )`,
    [
      envelope.id,
      envelope.installationId,
      envelope.actor.kind,
      actorPrincipalId,
      systemComponent,
      envelope.outcome,
      envelope.action,
      correlation(envelope, "authenticationRequestId"),
      correlation(envelope, "identityBindingId"),
      correlation(envelope, "accessGrantId"),
      correlation(envelope, "sessionId"),
      correlation(envelope, "sessionSpecId"),
      correlation(envelope, "endpointBindingId"),
      correlation(envelope, "attachmentId"),
      correlation(envelope, "turnId"),
      correlation(envelope, "attemptId"),
      correlation(envelope, "messageId"),
      correlation(envelope, "interactionId"),
      correlation(envelope, "interactionResponseId"),
      correlation(envelope, "workerLeaseId"),
      correlation(envelope, "credentialLeaseId"),
      correlation(envelope, "resumeHandleId"),
      correlation(envelope, "reservationId"),
      correlation(envelope, "forwardingAttemptId"),
      correlation(envelope, "deliveryId"),
      correlation(envelope, "deliveryAttemptId"),
      envelope.occurredAt,
    ],
  );
  if (result.changes !== 1) {
    throw new AuditRepositoryError(
      "audit append did not create exactly one envelope",
    );
  }
  return envelope;
}

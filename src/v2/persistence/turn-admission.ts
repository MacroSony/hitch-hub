/**
 * V2 Turn admission, idempotency, FIFO queue, and cancellation intent.
 *
 * One transaction admits a Turn: live identity, owner-scoped session
 * resolution, private endpoint-binding and lifecycle recheck, exact
 * idempotent replay by `(endpoint_id, idempotency_key)`, pinned-capacity
 * check, immutable input snapshot and attachment rows, resolved-model
 * inference resolution, queue insertion, runtime projection, receipt, and
 * audit. Cancellation compare-and-removes a still-queued Turn and
 * terminalizes it, or records active cancellation intent without touching
 * worker authority. Staged attachment files are finalized or rolled back by
 * the caller outside this unit of work; a failed admission never persists
 * attachment rows.
 */
import { encodeCanonicalJson } from "../codecs/json.js";
import { decodeInstallationHardCeilings } from "../bootstrap/records.js";
import {
  decodeBoundedString,
  decodeServiceId,
} from "../codecs/primitives.js";
import type { TrustedAuthorizationContextVerifier } from "../application/authorization-contexts.js";
import type {
  ActiveCancellationUnitOfWork,
  AuthenticatedConnectorContext,
  Clock,
  IdSource,
  QueuedCancellationUnitOfWork,
  TurnAdmissionUnitOfWork,
} from "../model/application.js";
import type { AuditActorRef } from "../model/identity-access.js";
import type {
  Attachment,
  TurnResponseDelivery,
  TurnTerminalResponse,
} from "../model/records.js";
import type {
  AgentProfileRevisionId,
  AttachmentId,
  AuthenticationRequestId,
  EndpointId,
  InstallationId,
  IsoTimestamp,
  ModelId,
  PrincipalId,
  ProviderId,
  SessionEndpointBindingId,
  SessionId,
  SessionSpecId,
  TurnId,
  TurnPolicySnapshotId,
} from "../model/primitives.js";
import type {
  Turn,
  TurnInferenceResolution,
  TurnInputSnapshot,
  TurnReceipt,
  TurnRuntimeState,
} from "../model/turn.js";
import {
  insertAuditEnvelope,
} from "./audit-repository.js";
import type { V2Database, V2RepositoryTransaction } from "./database.js";
import {
  SQLiteFoundationalAuthorizationReads,
  type LiveConnectorIdentity,
} from "./foundational-authorization.js";

/** Mirror of the connector protocol bounds; the unit of work revalidates. */
export const FIRST_SLICE_TURN_LIMITS = Object.freeze({
  maximumPromptCharacters: 65_536,
  maximumCorrelationCharacters: 128,
});

/**
 * No delivery policy record exists in the first slice; cancelled-turn
 * deliveries use these pinned values until one is published.
 */
export const FIRST_SLICE_RESPONSE_DELIVERY = Object.freeze({
  maximumAttempts: 3,
  deadlineMs: 300_000,
});

const AGENT_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const INTEGRITY_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MAXIMUM_IMAGE_BYTES = 8 * 1024 * 1024;
const ACTIVE_TURN_STATUSES = new Set([
  "dispatching",
  "submission-armed",
  "submitted-unconfirmed",
  "accepted",
  "running",
  "waiting-for-approval",
  "waiting-for-input",
]);

export class TurnAdmissionIntegrityError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "TurnAdmissionIntegrityError";
  }
}

export class TurnAdmissionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnAdmissionInputError";
  }
}

export interface SQLiteTurnAdmissionUnitOfWorkOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
}

type AdmitTurnInput = Parameters<TurnAdmissionUnitOfWork["admitTurn"]>[0];
type TurnAdmissionResult = Awaited<
  ReturnType<TurnAdmissionUnitOfWork["admitTurn"]>
>;
type CancelQueuedInput = Parameters<
  QueuedCancellationUnitOfWork["cancelStillQueuedTurn"]
>[0];
type QueuedCancellationResult = Awaited<
  ReturnType<QueuedCancellationUnitOfWork["cancelStillQueuedTurn"]>
>;
type ActiveCancellationInput = Parameters<
  ActiveCancellationUnitOfWork["requestActiveTurnCancellation"]
>[0];
type ActiveCancellationResult = Awaited<
  ReturnType<ActiveCancellationUnitOfWork["requestActiveTurnCancellation"]>
>;

type AdmittedTurnResult = Extract<
  TurnAdmissionResult,
  { readonly status: "admitted" }
>;
type QueuedTurnRuntime = AdmittedTurnResult["runtime"];
type CancellingTurnRuntime = Extract<
  ActiveCancellationResult,
  { readonly status: "cancelling" }
>["runtime"];

interface SessionResolution {
  readonly sessionId: SessionId;
  readonly specId: SessionSpecId;
  readonly turnPolicySnapshotId: TurnPolicySnapshotId;
  readonly profileRevisionId: AgentProfileRevisionId;
}

function requiredText(
  row: object,
  field: string,
  subject: string,
): string {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TurnAdmissionIntegrityError(
      `${subject} is missing its ${field}`,
    );
  }
  return value;
}

function requiredNumber(
  row: object,
  field: string,
  subject: string,
): number {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TurnAdmissionIntegrityError(
      `${subject} is missing its ${field}`,
    );
  }
  return value;
}

function decodeCorrelationText(
  input: unknown,
  label: string,
): string {
  try {
    return decodeBoundedString(input, {
      minimumLength: 1,
      maximumLength: FIRST_SLICE_TURN_LIMITS.maximumCorrelationCharacters,
      label,
    });
  } catch (error) {
    throw new TurnAdmissionInputError(
      `${label} must be 1-${FIRST_SLICE_TURN_LIMITS.maximumCorrelationCharacters} characters`,
    );
  }
}

function decodePromptText(input: unknown): string {
  try {
    return decodeBoundedString(input, {
      minimumLength: 1,
      maximumLength: FIRST_SLICE_TURN_LIMITS.maximumPromptCharacters,
      label: "prompt text",
    });
  } catch {
    throw new TurnAdmissionInputError(
      `prompt text must be 1-${FIRST_SLICE_TURN_LIMITS.maximumPromptCharacters} characters`,
    );
  }
}

function decodeSessionName(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > 256 ||
    CONTROL_CHARACTERS.test(input)
  ) {
    throw new TurnAdmissionInputError(
      "session name must be 1-256 characters without control characters",
    );
  }
  return input;
}

function plusMilliseconds(
  timestamp: IsoTimestamp,
  milliseconds: number,
): IsoTimestamp {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString() as IsoTimestamp;
}

/**
 * Owns the single admission transaction. Durable attachment rows are
 * appended here — never by staging — so a rejected admission leaves no
 * private-blob reference behind.
 */
export class SQLiteTurnAdmissionUnitOfWork implements TurnAdmissionUnitOfWork {
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #reads: SQLiteFoundationalAuthorizationReads;

  constructor(options: SQLiteTurnAdmissionUnitOfWorkOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#reads = new SQLiteFoundationalAuthorizationReads({
      contextVerifier: options.contextVerifier,
    });
  }

  async admitTurn(input: AdmitTurnInput): Promise<TurnAdmissionResult> {
    return this.#database.transaction((transaction) =>
      this.#admit(transaction, input),
    );
  }

  #admit(
    transaction: V2RepositoryTransaction,
    input: AdmitTurnInput,
  ): TurnAdmissionResult {
    const identity = this.#reads.readLiveConnectorIdentity(
      transaction,
      input.context,
    );
    if (identity.status === "denied") {
      return Object.freeze({ status: "denied" as const });
    }
    const text = decodePromptText(input.text);
    const idempotencyKey = decodeCorrelationText(
      input.idempotencyKey,
      "Turn idempotency key",
    );
    const originMessageId = decodeCorrelationText(
      input.originMessageId,
      "Turn origin message",
    );
    const attachment = input.preparedAttachment === undefined
      ? undefined
      : this.#validatePreparedAttachment(
          transaction,
          input,
          identity,
        );

    const resolution = this.#resolveSession(
      transaction,
      identity,
      input.session,
    );
    if (resolution.status !== "resolved") {
      return Object.freeze({ status: resolution.status });
    }
    const session = resolution.session;

    // Exact idempotency precedes binding/lifecycle gating: a lost-response
    // retry must still receive its original receipt after a later binding
    // suspension, while a new submission remains denied.
    const duplicate = this.#readExactReplay(
      transaction,
      identity,
      session,
      originMessageId,
      idempotencyKey,
      text,
      attachment?.id,
    );
    if (duplicate === "conflict") {
      return Object.freeze({ status: "denied" as const });
    }
    if (duplicate !== undefined) {
      return Object.freeze({
        status: "duplicate" as const,
        turnId: duplicate.turnId,
        receipt: this.#readReceipt(
          transaction,
          duplicate.turnId,
          identity.principalId,
        ),
      });
    }

    const authorization = this.#authorizeSession(
      transaction,
      identity,
      session,
    );
    if (authorization.status !== "authorized") {
      return Object.freeze({ status: "denied" as const });
    }
    const bindingId = authorization.bindingId;

    const maximumQueued = this.#readMaximumPendingTurns(
      transaction,
      identity.installationId,
      session.turnPolicySnapshotId,
    );
    const pendingRow = transaction.get(
      `SELECT COUNT(*) AS pending FROM turn_queue_entries WHERE principal_id = ?`,
      [identity.principalId],
    );
    if (pendingRow === undefined) {
      throw new TurnAdmissionIntegrityError(
        "principal queue count is unavailable",
      );
    }
    const pendingCount = requiredNumber(
      pendingRow,
      "pending",
      "principal queue",
    );
    if (pendingCount >= maximumQueued) {
      return Object.freeze({ status: "queue-capacity-exceeded" as const });
    }

    return this.#insertTurn(
      transaction,
      identity,
      session,
      bindingId,
      input,
      {
        text,
        idempotencyKey,
        originMessageId,
        attachment,
      },
    );
  }

  /**
   * Defense-in-depth revalidation of a store-minted admission record. The
   * provenance authentication request must exist and belong to the caller's
   * principal and identity binding; cross-checking the minted stage itself
   * belongs to the composing adapter, which holds both ports.
   */
  #validatePreparedAttachment(
    transaction: V2RepositoryTransaction,
    input: AdmitTurnInput,
    identity: LiveConnectorIdentity,
  ): Attachment {
    const prepared = input.preparedAttachment;
    if (
      typeof prepared !== "object" ||
      prepared === null ||
      typeof prepared.attachment !== "object" ||
      prepared.attachment === null
    ) {
      throw new TurnAdmissionIntegrityError(
        "prepared attachment admission is malformed",
      );
    }
    const attachment = prepared.attachment;
    if (
      attachment.installationId !== identity.installationId ||
      attachment.mediaType !== "image" ||
      !AGENT_IMAGE_MIME_TYPES.has(attachment.mimeType) ||
      !Number.isInteger(attachment.byteLength) ||
      attachment.byteLength < 1 ||
      attachment.byteLength > MAXIMUM_IMAGE_BYTES ||
      !INTEGRITY_DIGEST.test(attachment.integrityDigest) ||
      attachment.blob.storage !== "installation-private" ||
      attachment.admittedFrom.kind !== "local-cli"
    ) {
      throw new TurnAdmissionIntegrityError(
        "prepared attachment admission failed validation",
      );
    }
    decodeServiceId("Attachment", attachment.id);
    decodeServiceId("PrivateBlob", attachment.blob.blobId);
    const authenticationRequestId = decodeServiceId(
      "AuthenticationRequest",
      attachment.admittedFrom.authenticationRequestId,
    );
    const provenance = transaction.get(
      `SELECT principal_id, identity_binding_id FROM authentication_requests
      WHERE id = ?`,
      [authenticationRequestId],
    );
    if (
      provenance === undefined ||
      requiredText(provenance, "principal_id", "attachment provenance") !==
        identity.principalId ||
      requiredText(
        provenance,
        "identity_binding_id",
        "attachment provenance",
      ) !== identity.identityBindingId
    ) {
      throw new TurnAdmissionIntegrityError(
        "prepared attachment provenance does not belong to the caller",
      );
    }
    return attachment;
  }

  #resolveSession(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    selector: AdmitTurnInput["session"],
  ):
    | { readonly status: "resolved"; readonly session: SessionResolution }
    | {
        readonly status: "session-not-found" | "session-name-ambiguous";
      } {
    let sessionRow;
    if (selector.kind === "session-id") {
      sessionRow = transaction.get(
        `SELECT id, spec_id FROM sessions
        WHERE id = ? AND owner_principal_id = ?`,
        [selector.sessionId, identity.principalId],
      );
    } else {
      const name = decodeSessionName(selector.name);
      const matches = transaction.all(
        `SELECT sessions.id AS id, sessions.spec_id AS spec_id
        FROM sessions
        JOIN session_metadata ON session_metadata.session_id = sessions.id
        WHERE sessions.owner_principal_id = ?
          AND session_metadata.display_name = ?
        ORDER BY sessions.id`,
        [identity.principalId, name],
      );
      if (matches.length > 1) {
        return Object.freeze({ status: "session-name-ambiguous" as const });
      }
      sessionRow = matches[0];
    }
    if (sessionRow === undefined) {
      return Object.freeze({ status: "session-not-found" as const });
    }
    const sessionId = decodeServiceId(
      "Session",
      requiredText(sessionRow, "id", "session"),
    );
    const specId = decodeServiceId(
      "SessionSpec",
      requiredText(sessionRow, "spec_id", "session"),
    );

    const specRow = transaction.get(
      `SELECT turn_policy_snapshot_id, agent_profile_revision_id
      FROM session_specs WHERE id = ?`,
      [specId],
    );
    if (specRow === undefined) {
      throw new TurnAdmissionIntegrityError(
        "session is missing its pinned SessionSpec",
      );
    }
    return Object.freeze({
      status: "resolved" as const,
      session: Object.freeze({
        sessionId,
        specId,
        turnPolicySnapshotId: decodeServiceId(
          "TurnPolicySnapshot",
          requiredText(specRow, "turn_policy_snapshot_id", "session spec"),
        ),
        profileRevisionId: decodeServiceId(
          "AgentProfileRevision",
          requiredText(specRow, "agent_profile_revision_id", "session spec"),
        ),
      }),
    });
  }

  /** Binding and lifecycle gating for new admissions (after idempotency). */
  #authorizeSession(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    session: SessionResolution,
  ):
    | {
        readonly status: "authorized";
        readonly bindingId: SessionEndpointBindingId;
      }
    | { readonly status: "denied" } {
    const bindingRow = transaction.get(
      `SELECT id, state FROM session_endpoint_bindings
      WHERE session_id = ? AND endpoint_id = ?`,
      [session.sessionId, identity.endpointId],
    );
    if (
      bindingRow === undefined ||
      requiredText(bindingRow, "state", "session endpoint binding") !==
        "active"
    ) {
      return Object.freeze({ status: "denied" as const });
    }
    const lifecycleRow = transaction.get(
      `SELECT status FROM session_lifecycle WHERE session_id = ?`,
      [session.sessionId],
    );
    if (
      lifecycleRow === undefined ||
      requiredText(lifecycleRow, "status", "session lifecycle") !== "active"
    ) {
      return Object.freeze({ status: "denied" as const });
    }
    return Object.freeze({
      status: "authorized" as const,
      bindingId: decodeServiceId(
        "SessionEndpointBinding",
        requiredText(bindingRow, "id", "session endpoint binding"),
      ),
    });
  }

  /**
   * Exact replay: same endpoint key must carry the same session, requester,
   * origin message, text, and attachment. A reused origin message with a
   * different key is a conflict; both fail closed as `denied`.
   */
  #readExactReplay(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    session: SessionResolution,
    originMessageId: string,
    idempotencyKey: string,
    text: string,
    attachmentId: AttachmentId | undefined,
  ): { readonly turnId: TurnId } | "conflict" | undefined {
    const byKey = transaction.get(
      `SELECT id, session_id, requester_principal_id, origin_message_id,
        input_snapshot_id
      FROM turns WHERE endpoint_id = ? AND idempotency_key = ?`,
      [identity.endpointId, idempotencyKey],
    );
    if (byKey === undefined) {
      const byOrigin = transaction.get(
        `SELECT id FROM turns
        WHERE endpoint_id = ? AND origin_message_id = ?`,
        [identity.endpointId, originMessageId],
      );
      return byOrigin === undefined ? undefined : "conflict";
    }
    const snapshotId = requiredText(byKey, "input_snapshot_id", "turn");
    const blocks = transaction.all(
      `SELECT kind, text_content, attachment_id FROM turn_input_blocks
      WHERE turn_input_snapshot_id = ? ORDER BY ordinal`,
      [snapshotId],
    );
    const textBlock = blocks[0];
    const attachmentBlock = blocks[1];
    const exact =
      requiredText(byKey, "session_id", "turn") === session.sessionId &&
      requiredText(byKey, "requester_principal_id", "turn") ===
        identity.principalId &&
      requiredText(byKey, "origin_message_id", "turn") === originMessageId &&
      blocks.length === (attachmentId === undefined ? 1 : 2) &&
      textBlock !== undefined &&
      textBlock.kind === "text" &&
      textBlock.text_content === text &&
      (attachmentId === undefined ||
        (attachmentBlock !== undefined &&
          attachmentBlock.kind === "attachment" &&
          attachmentBlock.attachment_id === attachmentId));
    if (!exact) {
      return "conflict";
    }
    return Object.freeze({
      turnId: decodeServiceId("Turn", requiredText(byKey, "id", "turn")),
    });
  }

  #readReceipt(
    transaction: V2RepositoryTransaction,
    turnId: TurnId,
    requesterPrincipalId: PrincipalId,
  ): TurnReceipt {
    const entry = transaction.get(
      `SELECT principal_id, admission_ordinal
      FROM turn_queue_entries WHERE turn_id = ?`,
      [turnId],
    );
    if (entry !== undefined) {
      const principalId = requiredText(
        entry,
        "principal_id",
        "queue entry",
      );
      const ordinal = requiredNumber(
        entry,
        "admission_ordinal",
        "queue entry",
      );
      const positionRow = transaction.get(
        `SELECT COUNT(*) AS position FROM turn_queue_entries
        WHERE principal_id = ? AND admission_ordinal < ?`,
        [principalId, ordinal],
      );
      if (positionRow === undefined) {
        throw new TurnAdmissionIntegrityError(
          "principal queue position is unavailable",
        );
      }
      return Object.freeze({
        turnId,
        status: "queued" as const,
        queue: Object.freeze({
          turnId,
          position: requiredNumber(positionRow, "position", "queue entry"),
          requesterPrincipalId,
          controls: Object.freeze({ canCancel: true }),
        }),
      });
    }
    const runtime = transaction.get(
      `SELECT status FROM turn_runtime_states WHERE turn_id = ?`,
      [turnId],
    );
    const terminal =
      runtime !== undefined &&
      requiredText(runtime, "status", "turn runtime") === "terminal";
    return Object.freeze({
      turnId,
      status: "starting" as const,
      controls: Object.freeze({ canCancel: !terminal }),
    });
  }

  #readMaximumPendingTurns(
    transaction: V2RepositoryTransaction,
    installationId: InstallationId,
    turnPolicySnapshotId: TurnPolicySnapshotId,
  ): number {
    const row = transaction.get(
      `SELECT p.max_queued_turns, i.hard_ceilings_json
      FROM turn_policy_snapshots p
      JOIN installations i ON i.id = ?
      WHERE p.id = ?`,
      [installationId, turnPolicySnapshotId],
    );
    if (row === undefined) {
      throw new TurnAdmissionIntegrityError(
        "session pins an unknown Turn policy snapshot",
      );
    }
    const hardCeilingsJson = requiredText(
      row,
      "hard_ceilings_json",
      "installation hard ceilings",
    );
    let hardCeilings: ReturnType<typeof decodeInstallationHardCeilings>;
    try {
      hardCeilings = decodeInstallationHardCeilings(
        JSON.parse(hardCeilingsJson) as unknown,
      );
    } catch {
      throw new TurnAdmissionIntegrityError(
        "installation hard ceilings are invalid",
      );
    }
    return Math.min(
      requiredNumber(row, "max_queued_turns", "turn policy snapshot"),
      hardCeilings.maximumPendingTurnsPerPrincipal,
    );
  }

  #insertOne(
    transaction: V2RepositoryTransaction,
    sql: string,
    parameters: readonly (
      | string
      | number
      | null
    )[],
  ): void {
    const result = transaction.run(sql, parameters);
    if (result.changes !== 1) {
      throw new TurnAdmissionIntegrityError(
        "turn admission did not append exactly one row",
      );
    }
  }

  #updateExactlyOne(
    transaction: V2RepositoryTransaction,
    sql: string,
    parameters: readonly (string | number | null)[],
    label: string,
  ): void {
    const result = transaction.run(sql, parameters);
    if (result.changes !== 1) {
      throw new TurnAdmissionIntegrityError(
        `turn admission did not update exactly one ${label}`,
      );
    }
  }

  #insertTurn(
    transaction: V2RepositoryTransaction,
    identity: LiveConnectorIdentity,
    session: SessionResolution,
    bindingId: SessionEndpointBindingId,
    input: AdmitTurnInput,
    validated: {
      readonly text: string;
      readonly idempotencyKey: string;
      readonly originMessageId: string;
      readonly attachment: Attachment | undefined;
    },
  ): TurnAdmissionResult {
    const now = this.#clock.now();
    const profileRow = transaction.get(
      `SELECT default_provider_id, default_model_id
      FROM agent_profile_revisions WHERE id = ?`,
      [session.profileRevisionId],
    );
    if (profileRow === undefined) {
      throw new TurnAdmissionIntegrityError(
        "session pins an unknown agent profile revision",
      );
    }
    const providerId = decodeServiceId(
      "Provider",
      requiredText(profileRow, "default_provider_id", "profile revision"),
    );
    const modelId = decodeServiceId(
      "Model",
      requiredText(profileRow, "default_model_id", "profile revision"),
    );
    const bindingRow = transaction.get(
      `SELECT provider_id FROM session_spec_provider_bindings
      WHERE session_spec_id = ?`,
      [session.specId],
    );
    if (
      bindingRow === undefined ||
      requiredText(bindingRow, "provider_id", "spec provider binding") !==
        providerId
    ) {
      throw new TurnAdmissionIntegrityError(
        "session spec provider binding and profile default drifted",
      );
    }

    const turnId = this.#ids.next("Turn");
    const snapshotId = this.#ids.next("TurnInputSnapshot");
    const { attachment } = validated;

    if (attachment !== undefined) {
      this.#insertOne(
        transaction,
        `INSERT INTO private_blobs (
          id, installation_id, storage, integrity_digest, created_at
        ) VALUES (?, ?, 'installation-private', ?, ?)`,
        [
          attachment.blob.blobId,
          attachment.installationId,
          attachment.integrityDigest,
          now,
        ],
      );
      this.#insertOne(
        transaction,
        `INSERT INTO attachments (
          id, installation_id, media_type, mime_type, byte_length,
          integrity_digest, blob_id, admitted_from_kind,
          authentication_request_id, created_at
        ) VALUES (?, ?, 'image', ?, ?, ?, ?, 'local-cli', ?, ?)`,
        [
          attachment.id,
          attachment.installationId,
          attachment.mimeType,
          attachment.byteLength,
          attachment.integrityDigest,
          attachment.blob.blobId,
          attachment.admittedFrom.authenticationRequestId,
          now,
        ],
      );
    }

    this.#insertOne(
      transaction,
      `INSERT INTO turn_input_snapshots (id, installation_id, created_at)
      VALUES (?, ?, ?)`,
      [snapshotId, identity.installationId, now],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO turn_input_blocks (
        turn_input_snapshot_id, ordinal, kind, text_content,
        attachment_id, media_type, mime_type, display_name
      ) VALUES (?, 0, 'text', ?, NULL, NULL, NULL, NULL)`,
      [snapshotId, validated.text],
    );
    if (attachment !== undefined) {
      this.#insertOne(
        transaction,
        `INSERT INTO turn_input_blocks (
          turn_input_snapshot_id, ordinal, kind, text_content,
          attachment_id, media_type, mime_type, display_name
        ) VALUES (?, 1, 'attachment', NULL, ?, 'image', ?, NULL)`,
        [snapshotId, attachment.id, attachment.mimeType],
      );
    }

    this.#insertOne(
      transaction,
      `INSERT INTO turns (
        id, session_id, requester_principal_id,
        requester_identity_binding_id, authentication_request_id,
        endpoint_id, endpoint_binding_id, origin_message_id,
        input_snapshot_id, turn_policy_snapshot_id,
        model_selection_kind, selected_provider_id, selected_model_id,
        reasoning_kind, reasoning_effort, idempotency_key, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved', ?, ?, 'agent-default',
        NULL, ?, ?
      )`,
      [
        turnId,
        session.sessionId,
        identity.principalId,
        identity.identityBindingId,
        identity.authenticationRequestId,
        identity.endpointId,
        bindingId,
        validated.originMessageId,
        snapshotId,
        session.turnPolicySnapshotId,
        providerId,
        modelId,
        validated.idempotencyKey,
        now,
      ],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO turn_inference_resolutions (
        turn_id, provider_id, model_id, reasoning_kind, reasoning_effort,
        resolved_by, resolved_at
      ) VALUES (?, ?, ?, 'agent-default', NULL, 'hitch', ?)`,
      [turnId, providerId, modelId, now],
    );

    const capacity = transaction.get(
      `SELECT next_admission_ordinal FROM principal_execution_capacity
      WHERE principal_id = ?`,
      [identity.principalId],
    );
    if (capacity === undefined) {
      throw new TurnAdmissionIntegrityError(
        "principal execution capacity is unavailable",
      );
    }
    const admissionOrdinal = requiredNumber(
      capacity,
      "next_admission_ordinal",
      "principal execution capacity",
    );
    const pending = transaction.get(
      `SELECT COUNT(*) AS position FROM turn_queue_entries
      WHERE principal_id = ?`,
      [identity.principalId],
    );
    if (pending === undefined) {
      throw new TurnAdmissionIntegrityError(
        "principal queue position is unavailable",
      );
    }
    const position = requiredNumber(pending, "position", "principal queue");
    this.#updateExactlyOne(
      transaction,
      `UPDATE principal_execution_capacity
      SET next_admission_ordinal = ?, updated_at = ?
      WHERE principal_id = ? AND next_admission_ordinal = ?`,
      [admissionOrdinal + 1, now, identity.principalId, admissionOrdinal],
      "principal admission ordinal",
    );
    this.#insertOne(
      transaction,
      `INSERT INTO turn_queue_entries (
        principal_id, turn_id, admission_ordinal, enqueued_at
      ) VALUES (?, ?, ?, ?)`,
      [identity.principalId, turnId, admissionOrdinal, now],
    );
    this.#insertOne(
      transaction,
      `INSERT INTO turn_runtime_states (
        turn_id, session_id, status, attempt_id, interaction_id,
        interaction_kind, requested_at, requested_actor_kind,
        requested_actor_principal_id, requested_actor_system_component,
        cancellation_reason, completed_at, result_json,
        partial_output_available, updated_at
      ) VALUES (
        ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, ?
      )`,
      [turnId, session.sessionId, now],
    );

    const turnAudit = insertAuditEnvelope(transaction, {
      id: this.#ids.next("AuditEnvelope"),
      installationId: identity.installationId,
      actor: { kind: "principal", principalId: identity.principalId },
      outcome: "succeeded",
      action: "turn-admitted",
      sessionId: session.sessionId,
      turnId,
      occurredAt: now,
    });
    const auditEvents = Object.freeze(
      attachment === undefined
        ? [turnAudit]
        : [
            turnAudit,
            insertAuditEnvelope(transaction, {
              id: this.#ids.next("AuditEnvelope"),
              installationId: identity.installationId,
              actor: {
                kind: "principal",
                principalId: identity.principalId,
              },
              outcome: "succeeded",
              action: "attachment-admitted",
              attachmentId: attachment.id,
              authenticationRequestId:
                attachment.admittedFrom.authenticationRequestId,
              occurredAt: now,
            }),
          ],
    ) as unknown as AdmittedTurnResult["auditEvents"];

    const turn: Turn = Object.freeze({
      id: turnId,
      sessionId: session.sessionId,
      requester: Object.freeze({
        principalId: identity.principalId,
        identityBindingId: identity.identityBindingId,
        authenticationRequestId: identity.authenticationRequestId,
      }),
      origin: Object.freeze({
        kind: "endpoint" as const,
        endpointId: identity.endpointId,
        endpointBindingId: bindingId,
        originMessageId:
          validated.originMessageId as Turn["origin"]["originMessageId"],
      }),
      inputSnapshotId: snapshotId,
      turnPolicySnapshotId: session.turnPolicySnapshotId,
      execution: Object.freeze({
        model: Object.freeze({
          kind: "resolved" as const,
          providerId,
          modelId,
        }),
        reasoning: Object.freeze({ kind: "agent-default" as const }),
      }),
      idempotencyKey:
        validated.idempotencyKey as Turn["idempotencyKey"],
      createdAt: now,
    });
    const inputSnapshot: TurnInputSnapshot = Object.freeze({
      id: snapshotId,
      triggeringContent: Object.freeze(
        attachment === undefined
          ? [Object.freeze({ kind: "text" as const, text: validated.text })]
          : [
              Object.freeze({ kind: "text" as const, text: validated.text }),
              Object.freeze({
                kind: "attachment" as const,
                attachmentId: attachment.id,
                mediaType: "image" as const,
                mimeType: attachment.mimeType,
              }),
            ],
      ),
      createdAt: now,
    });
    const runtime: QueuedTurnRuntime = Object.freeze({
      turnId,
      state: Object.freeze({ status: "queued" as const }),
      updatedAt: now,
    });
    const inferenceResolution: TurnInferenceResolution = Object.freeze({
      turnId,
      model: Object.freeze({ providerId, modelId }),
      reasoning: Object.freeze({ kind: "agent-default" as const }),
      resolvedBy: "hitch" as const,
      resolvedAt: now,
    });
    const receipt: TurnReceipt = Object.freeze({
      turnId,
      status: "queued" as const,
      queue: Object.freeze({
        turnId,
        position,
        requesterPrincipalId: identity.principalId,
        controls: Object.freeze({ canCancel: true }),
      }),
    });

    return Object.freeze({
      status: "admitted" as const,
      turn,
      inputSnapshot,
      runtime,
      inferenceResolution,
      ...(attachment === undefined ? {} : { attachment }),
      receipt,
      auditEvents,
    });
  }
}

/**
 * Compare-and-remove queued cancellation and active cancellation intent.
 * Neither launches nor signals a worker; the dispatcher observes the durable
 * cancelling projection.
 */
export class SQLiteTurnCancellationUnitOfWork
  implements QueuedCancellationUnitOfWork, ActiveCancellationUnitOfWork
{
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #contextVerifier: TrustedAuthorizationContextVerifier;

  constructor(options: SQLiteTurnAdmissionUnitOfWorkOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#contextVerifier = options.contextVerifier;
  }

  async cancelStillQueuedTurn(
    input: CancelQueuedInput,
  ): Promise<QueuedCancellationResult> {
    return this.#database.transaction((transaction) =>
      this.#cancelQueued(transaction, input),
    );
  }

  async requestActiveTurnCancellation(
    input: ActiveCancellationInput,
  ): Promise<ActiveCancellationResult> {
    return this.#database.transaction((transaction) =>
      this.#cancelActive(transaction, input),
    );
  }

  /** Only the requester or the turn-coordinator may control a Turn. */
  #authorize(
    transaction: V2RepositoryTransaction,
    context: CancelQueuedInput["context"],
    turnId: TurnId,
  ):
    | { readonly status: "authorized"; readonly actor: AuditActorRef }
    | { readonly status: "denied" }
    | { readonly status: "unknown-turn" } {
    const verified = this.#contextVerifier.classify(context);
    if (verified === undefined) {
      return Object.freeze({ status: "denied" as const });
    }
    const row = transaction.get(
      `SELECT session_id, requester_principal_id FROM turns WHERE id = ?`,
      [turnId],
    );
    if (row === undefined) {
      return Object.freeze({ status: "unknown-turn" as const });
    }
    if (verified.kind === "connector") {
      const principalId = verified.context.actor.principalId;
      if (
        requiredText(row, "requester_principal_id", "turn") !== principalId
      ) {
        return Object.freeze({ status: "denied" as const });
      }
      return Object.freeze({
        status: "authorized" as const,
        actor: Object.freeze({
          kind: "principal" as const,
          principalId,
        }),
      });
    }
    if (verified.component !== "turn-coordinator") {
      return Object.freeze({ status: "denied" as const });
    }
    return Object.freeze({
      status: "authorized" as const,
      actor: Object.freeze({
        kind: "system" as const,
        component: "turn-coordinator" as const,
      }),
    });
  }

  #cancelQueued(
    transaction: V2RepositoryTransaction,
    input: CancelQueuedInput,
  ): QueuedCancellationResult {
    let turnId: TurnId;
    try {
      turnId = decodeServiceId("Turn", input.turnId);
    } catch {
      return Object.freeze({
        status: "not-queued" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const authorization = this.#authorize(transaction, input.context, turnId);
    if (authorization.status === "denied") {
      return Object.freeze({
        status: "denied" as const,
        auditEvents: Object.freeze([]),
      });
    }
    if (authorization.status === "unknown-turn") {
      return Object.freeze({
        status: "not-queued" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const runtimeRow = transaction.get(
      `SELECT session_id, status, result_json FROM turn_runtime_states
      WHERE turn_id = ?`,
      [turnId],
    );
    if (runtimeRow === undefined) {
      throw new TurnAdmissionIntegrityError(
        "turn is missing its runtime projection",
      );
    }
    const status = requiredText(runtimeRow, "status", "turn runtime");
    if (status === "terminal") {
      const resultJson = runtimeRow.result_json;
      const parsed: unknown =
        typeof resultJson === "string" ? JSON.parse(resultJson) : undefined;
      const cancelled =
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as { readonly outcome?: unknown }).outcome === "cancelled";
      return Object.freeze({
        status: cancelled
          ? ("already-cancelled" as const)
          : ("not-queued" as const),
        auditEvents: Object.freeze([]),
      });
    }
    if (status !== "queued") {
      return Object.freeze({
        status: "not-queued" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const sessionId = decodeServiceId(
      "Session",
      requiredText(runtimeRow, "session_id", "turn runtime"),
    );

    // Compare-and-remove: the delete proves the entry was still pending.
    const removed = transaction.run(
      `DELETE FROM turn_queue_entries
      WHERE turn_id = ?`,
      [turnId],
    );
    if (removed.changes !== 1) {
      return Object.freeze({
        status: "not-queued" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const now = this.#clock.now();
    const reason =
      authorization.actor.kind === "principal"
        ? ("withdrawn-by-requester" as const)
        : ("cancelled-by-controller" as const);
    const result = Object.freeze({
      outcome: "cancelled" as const,
      reason,
    });
    const resultJson = encodeCanonicalJson(result);
    const terminalized = transaction.run(
      `UPDATE turn_runtime_states
      SET status = 'terminal', completed_at = ?, result_json = ?,
        partial_output_available = 0, updated_at = ?
      WHERE turn_id = ? AND status = 'queued'`,
      [now, resultJson, now, turnId],
    );
    if (terminalized.changes !== 1) {
      throw new TurnAdmissionIntegrityError(
        "queued turn vanished during its cancellation",
      );
    }

    const terminalResponseId = this.#ids.next("TurnTerminalResponse");
    this.#insertOne(
      transaction,
      `INSERT INTO turn_terminal_responses (
        id, turn_id, result_json, partial_output_available, finalized_at
      ) VALUES (?, ?, ?, 0, ?)`,
      [terminalResponseId, turnId, resultJson, now],
    );

    const origin = transaction.get(
      `SELECT requester_principal_id, endpoint_id, endpoint_binding_id
      FROM turns WHERE id = ?`,
      [turnId],
    );
    if (origin === undefined) {
      throw new TurnAdmissionIntegrityError(
        "cancelled turn vanished before its delivery",
      );
    }
    const deliveryId = this.#ids.next("TurnResponseDelivery");
    const deadlineAt = plusMilliseconds(
      now,
      FIRST_SLICE_RESPONSE_DELIVERY.deadlineMs,
    );
    this.#insertOne(
      transaction,
      `INSERT INTO turn_response_deliveries (
        id, terminal_response_id, turn_id, session_id, endpoint_id,
        endpoint_binding_id, recipient_principal_id, deadline_at,
        maximum_attempts, attempt_count, state, current_attempt_id,
        started_at, delivered_at, failed_at, suppressed_at, expired_at,
        next_attempt_at, reason, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, ?, ?
      )`,
      [
        deliveryId,
        terminalResponseId,
        turnId,
        sessionId,
        requiredText(origin, "endpoint_id", "turn origin"),
        requiredText(origin, "endpoint_binding_id", "turn origin"),
        requiredText(origin, "requester_principal_id", "turn origin"),
        deadlineAt,
        FIRST_SLICE_RESPONSE_DELIVERY.maximumAttempts,
        now,
        now,
      ],
    );

    const installationId = this.#soleInstallationId(transaction);
    const terminalizedAudit = insertAuditEnvelope(transaction, {
      id: this.#ids.next("AuditEnvelope"),
      installationId,
      actor: authorization.actor,
      outcome: "succeeded",
      action: "turn-terminalized",
      sessionId,
      turnId,
      occurredAt: now,
    });
    const deliveryAudit = insertAuditEnvelope(transaction, {
      id: this.#ids.next("AuditEnvelope"),
      installationId,
      actor: authorization.actor,
      outcome: "succeeded",
      action: "response-delivery-created",
      sessionId,
      turnId,
      deliveryId,
      occurredAt: now,
    });
    const transitionAudit = insertAuditEnvelope(transaction, {
      id: this.#ids.next("AuditEnvelope"),
      installationId,
      actor: authorization.actor,
      outcome: "succeeded",
      action: "turn-state-transitioned",
      sessionId,
      turnId,
      occurredAt: now,
    });

    const terminalResponse: TurnTerminalResponse = Object.freeze({
      id: terminalResponseId,
      turnId,
      result,
      partialOutputAvailable: false,
      finalizedMessages: Object.freeze([]),
      finalizedAt: now,
    });
    const delivery: TurnResponseDelivery = Object.freeze({
      id: deliveryId,
      terminalResponseId,
      turnId,
      endpointBindingId: decodeServiceId(
        "SessionEndpointBinding",
        requiredText(origin, "endpoint_binding_id", "turn origin"),
      ),
      recipientPrincipalId: decodeServiceId(
        "Principal",
        requiredText(origin, "requester_principal_id", "turn origin"),
      ),
      deadlineAt,
      maximumAttempts: FIRST_SLICE_RESPONSE_DELIVERY.maximumAttempts,
      attemptCount: 0,
      state: Object.freeze({ status: "pending" as const }),
      createdAt: now,
      updatedAt: now,
    });

    return Object.freeze({
      status: "cancelled" as const,
      terminalResponse,
      delivery,
      auditEvents: Object.freeze([
        terminalizedAudit,
        deliveryAudit,
        transitionAudit,
      ]) as unknown as Extract<
        QueuedCancellationResult,
        { readonly status: "cancelled" }
      >["auditEvents"],
    });
  }

  #cancelActive(
    transaction: V2RepositoryTransaction,
    input: ActiveCancellationInput,
  ): ActiveCancellationResult {
    let turnId: TurnId;
    try {
      turnId = decodeServiceId("Turn", input.turnId);
    } catch {
      return Object.freeze({
        status: "not-active" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const authorization = this.#authorize(transaction, input.context, turnId);
    if (authorization.status === "denied") {
      return Object.freeze({
        status: "denied" as const,
        auditEvents: Object.freeze([]),
      });
    }
    if (authorization.status === "unknown-turn") {
      return Object.freeze({
        status: "not-active" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const runtimeRow = transaction.get(
      `SELECT session_id, status, attempt_id FROM turn_runtime_states
      WHERE turn_id = ?`,
      [turnId],
    );
    if (runtimeRow === undefined) {
      throw new TurnAdmissionIntegrityError(
        "turn is missing its runtime projection",
      );
    }
    const status = requiredText(runtimeRow, "status", "turn runtime");
    if (status === "terminal") {
      return Object.freeze({
        status: "already-terminal" as const,
        auditEvents: Object.freeze([]),
      });
    }
    if (!ACTIVE_TURN_STATUSES.has(status)) {
      // Queued turns use compare-and-remove; an already-cancelling Turn has
      // its intent recorded, so a repeat is response-idempotent.
      return Object.freeze({
        status: "not-active" as const,
        auditEvents: Object.freeze([]),
      });
    }
    const sessionId = decodeServiceId(
      "Session",
      requiredText(runtimeRow, "session_id", "turn runtime"),
    );
    const attemptId = decodeServiceId(
      "AgentDispatchAttempt",
      requiredText(runtimeRow, "attempt_id", "active turn runtime"),
    );
    const now = this.#clock.now();
    const actor = authorization.actor;
    const updated = transaction.run(
      `UPDATE turn_runtime_states
      SET status = 'cancelling', requested_at = ?,
        requested_actor_kind = ?, requested_actor_principal_id = ?,
        requested_actor_system_component = ?, cancellation_reason = ?,
        updated_at = ?
      WHERE turn_id = ? AND status = ?`,
      [
        now,
        actor.kind,
        actor.kind === "principal" ? actor.principalId : null,
        actor.kind === "system" ? actor.component : null,
        input.reason,
        now,
        turnId,
        status,
      ],
    );
    if (updated.changes !== 1) {
      throw new TurnAdmissionIntegrityError(
        "active turn vanished during its cancellation intent",
      );
    }
    const installationId = this.#soleInstallationId(transaction);
    const transitionAudit = insertAuditEnvelope(transaction, {
      id: this.#ids.next("AuditEnvelope"),
      installationId,
      actor,
      outcome: "succeeded",
      action: "turn-state-transitioned",
      sessionId,
      turnId,
      occurredAt: now,
    });
    const runtime: CancellingTurnRuntime = Object.freeze({
      turnId,
      state: Object.freeze({
        status: "cancelling" as const,
        attemptId,
        requestedAt: now,
        requestedBy: actor,
        reason: input.reason,
      }),
      updatedAt: now,
    });
    return Object.freeze({
      status: "cancelling" as const,
      runtime,
      auditEvents: Object.freeze([
        transitionAudit,
      ]) as unknown as Extract<
        ActiveCancellationResult,
        { readonly status: "cancelling" }
      >["auditEvents"],
    });
  }

  #insertOne(
    transaction: V2RepositoryTransaction,
    sql: string,
    parameters: readonly (string | number | null)[],
  ): void {
    const result = transaction.run(sql, parameters);
    if (result.changes !== 1) {
      throw new TurnAdmissionIntegrityError(
        "turn cancellation did not append exactly one row",
      );
    }
  }

  #soleInstallationId(
    transaction: V2RepositoryTransaction,
  ): InstallationId {
    const rows = transaction.all(`SELECT id FROM installations`, []);
    if (rows.length !== 1) {
      throw new TurnAdmissionIntegrityError(
        "turn control requires exactly one installation",
      );
    }
    return decodeServiceId(
      "Installation",
      requiredText(rows[0]!, "id", "installation"),
    );
  }
}

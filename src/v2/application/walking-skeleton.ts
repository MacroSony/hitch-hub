/**
 * V2-014A development walking-skeleton application.
 *
 * This composition deliberately stops at durable admission. Its coordinator
 * claims one FIFO head into `dispatching` so the two-process CLI can exercise
 * one-active/three-queued behavior, but it never launches a worker, emits an
 * assistant response, terminalizes work, or creates delivery state. Production
 * startup must not use this component once V2-014B runtime composition exists.
 */

import { createHash } from "node:crypto";

import type { TrustedAuthorizationContextVerifier } from "./authorization-contexts.js";
import {
  decodeIsoTimestamp,
  decodeServiceId,
} from "../codecs/primitives.js";
import { decodeTurnResult } from "../codecs/turn-events.js";
import type {
  ActiveCancellationUnitOfWork,
  AttachedConnectorResponseStream,
  AuthenticatedConnectorContext,
  ConnectorCommand,
  ConnectorCommandResponse,
  FirstSliceConnectorApplication,
  IdSource,
  QueuedCancellationUnitOfWork,
  SessionCreationUnitOfWork,
  TurnAdmissionUnitOfWork,
  TurnResultQueryPort,
  AuthorizedTurnResultQuery,
  Clock,
} from "../model/application.js";
import type { PrivateAttachmentStoragePort } from "../model/external-runtime.js";
import type {
  AgentDispatchAttemptId,
  OriginMessageId,
  PrincipalId,
  TurnId,
} from "../model/primitives.js";
import type {
  TurnLifecycleState,
  TurnReceipt,
  TurnRuntimeState,
} from "../model/turn.js";
import { insertAuditEnvelope } from "../persistence/audit-repository.js";
import type {
  SQLiteBindValue,
  V2Database,
  V2RepositoryTransaction,
} from "../persistence/database.js";
import { SQLiteFoundationalAuthorizationReads } from "../persistence/foundational-authorization.js";

export class WalkingSkeletonApplicationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WalkingSkeletonApplicationError";
  }
}

export interface WalkingSkeletonCoordinatorPort {
  claimAdmittedHead(input: {
    readonly context: AuthenticatedConnectorContext;
    readonly turnId: TurnId;
    readonly receipt: TurnReceipt;
  }): Promise<TurnReceipt>;
}

export interface WalkingSkeletonConnectorApplicationOptions {
  readonly sessionCreation: SessionCreationUnitOfWork;
  readonly turnAdmission: TurnAdmissionUnitOfWork;
  readonly attachmentStorage: Pick<
    PrivateAttachmentStoragePort,
    | "stageBoundedImage"
    | "finalizeAdmittedImage"
    | "rollbackUnfinalizedImage"
  >;
  readonly turnResultQuery: TurnResultQueryPort;
  readonly queuedCancellation: QueuedCancellationUnitOfWork;
  readonly activeCancellation: ActiveCancellationUnitOfWork;
  readonly coordinator: WalkingSkeletonCoordinatorPort;
}

function closedResponseStream(): AttachedConnectorResponseStream {
  return Object.freeze({
    events: (async function* () {})(),
    async close() {},
  });
}

/**
 * A stable local origin derived from the client retry key. The endpoint is
 * still taken exclusively from authenticated context by Turn admission, so a
 * client cannot select another principal or endpoint origin. Stable derivation
 * lets a retry converge after a daemon restart without a process-local cache.
 */
function localOriginMessageId(idempotencyKey: string): OriginMessageId {
  const digest = createHash("sha256")
    .update("hitch.local.origin.v1\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("base64url");
  return `om:local:${digest}` as OriginMessageId;
}

type AnyCommandResponse = ConnectorCommandResponse<ConnectorCommand>;

export class WalkingSkeletonConnectorApplication
  implements FirstSliceConnectorApplication
{
  readonly #options: WalkingSkeletonConnectorApplicationOptions;

  constructor(options: WalkingSkeletonConnectorApplicationOptions) {
    this.#options = options;
  }

  async execute<Command extends ConnectorCommand>(
    context: AuthenticatedConnectorContext,
    command: Command,
  ): Promise<ConnectorCommandResponse<Command>> {
    let response: AnyCommandResponse;
    switch (command.kind) {
      case "create-session":
        response = await this.#createSession(context, command);
        break;
      case "submit-turn":
        response = await this.#submitTurn(context, command);
        break;
      case "get-turn":
        response = await this.#getTurn(context, command.turnId);
        break;
      case "cancel-turn":
        response = await this.#cancelTurn(context, command.turnId);
        break;
      case "stop-session":
      case "resolve-interaction":
        response = Object.freeze({
          status: "rejected" as const,
          code: "temporarily-unavailable" as const,
        });
        break;
    }
    return response as ConnectorCommandResponse<Command>;
  }

  async #createSession(
    context: AuthenticatedConnectorContext,
    command: Extract<ConnectorCommand, { readonly kind: "create-session" }>,
  ): Promise<AnyCommandResponse> {
    const created = await this.#options.sessionCreation.createPrivateSession({
      context,
      profileReference: command.profileReference,
      workspaceReference: command.workspaceReference,
      ...(command.displayName === undefined
        ? {}
        : { displayName: command.displayName }),
    });
    if (created.status === "created") {
      return Object.freeze({
        status: "succeeded" as const,
        result: Object.freeze({
          kind: "session-created" as const,
          sessionId: created.session.id,
        }),
      });
    }
    return Object.freeze({
      status: "rejected" as const,
      code: created.status === "not-found"
        ? ("not-found" as const)
        : ("not-authorized" as const),
    });
  }

  async #submitTurn(
    context: AuthenticatedConnectorContext,
    command: Extract<ConnectorCommand, { readonly kind: "submit-turn" }>,
  ): Promise<AnyCommandResponse> {
    let stage;
    if (command.image !== undefined) {
      const staged = await this.#options.attachmentStorage.stageBoundedImage(
        command.image,
      );
      if (staged.status === "rejected") {
        return Object.freeze({
          status: "rejected" as const,
          code: staged.reason === "private-storage-unavailable"
            ? ("temporarily-unavailable" as const)
            : ("invalid-request" as const),
        });
      }
      stage = staged.stage;
    }

    let admission;
    try {
      admission = await this.#options.turnAdmission.admitTurn({
        context,
        session: command.session,
        originMessageId: localOriginMessageId(command.idempotencyKey),
        idempotencyKey: command.idempotencyKey,
        text: command.text,
        ...(stage === undefined
          ? {}
          : { preparedAttachment: stage.preparedAdmission }),
      });
    } catch (error) {
      if (stage !== undefined) {
        await this.#options.attachmentStorage.rollbackUnfinalizedImage({
          stage,
          reason: "application-aborted",
        });
      }
      throw error;
    }

    if (admission.status === "admitted" && stage !== undefined) {
      if (admission.attachment === undefined) {
        await this.#options.attachmentStorage.rollbackUnfinalizedImage({
          stage,
          reason: "attachment-mismatch",
        });
        throw new WalkingSkeletonApplicationError(
          "admitted image Turn is missing its attachment projection",
        );
      }
      const finalized = await this.#options.attachmentStorage
        .finalizeAdmittedImage({
          stage,
          admission: {
            ...admission,
            attachment: admission.attachment,
          },
        });
      if (finalized.status !== "finalized") {
        return Object.freeze({
          status: "rejected" as const,
          code: "temporarily-unavailable" as const,
        });
      }
    } else if (stage !== undefined) {
      const rolledBack = await this.#options.attachmentStorage
        .rollbackUnfinalizedImage({
          stage,
          reason: admission.status === "duplicate"
            ? "duplicate-turn"
            : "admission-rejected",
        });
      if (rolledBack.status === "cleanup-failed") {
        return Object.freeze({
          status: "rejected" as const,
          code: "temporarily-unavailable" as const,
        });
      }
    }

    if (admission.status === "admitted") {
      const receipt = await this.#options.coordinator.claimAdmittedHead({
        context,
        turnId: admission.turn.id,
        receipt: admission.receipt,
      });
      return Object.freeze({
        status: "succeeded" as const,
        result: Object.freeze({ kind: "turn-submitted" as const, receipt }),
        responseEvents: closedResponseStream(),
      });
    }
    if (admission.status === "duplicate") {
      return Object.freeze({
        status: "succeeded" as const,
        result: Object.freeze({
          kind: "turn-submitted" as const,
          receipt: admission.receipt,
        }),
        responseEvents: closedResponseStream(),
      });
    }
    const code = admission.status === "queue-capacity-exceeded"
      ? ("queue-capacity-exceeded" as const)
      : admission.status === "session-not-found"
        ? ("not-found" as const)
        : admission.status === "session-name-ambiguous"
          ? ("conflict" as const)
          : ("not-authorized" as const);
    return Object.freeze({ status: "rejected" as const, code });
  }

  async #getTurn(
    context: AuthenticatedConnectorContext,
    turnId: TurnId,
  ): Promise<AnyCommandResponse> {
    const result = await this.#options.turnResultQuery
      .queryAuthorizedTurnResult({ context, turnId });
    if (result.kind === "turn-found") {
      return Object.freeze({ status: "succeeded" as const, result });
    }
    return Object.freeze({
      status: "rejected" as const,
      code: result.kind === "turn-not-found"
        ? ("not-found" as const)
        : ("not-authorized" as const),
    });
  }

  async #cancelTurn(
    context: AuthenticatedConnectorContext,
    turnId: TurnId,
  ): Promise<AnyCommandResponse> {
    const queued = await this.#options.queuedCancellation
      .cancelStillQueuedTurn({ context, turnId });
    if (queued.status === "cancelled") {
      return Object.freeze({
        status: "succeeded" as const,
        result: Object.freeze({ kind: "turn-cancelled" as const, turnId }),
      });
    }
    if (queued.status === "already-cancelled") {
      return Object.freeze({
        status: "succeeded" as const,
        result: Object.freeze({
          kind: "turn-already-cancelled" as const,
          turnId,
        }),
      });
    }
    if (queued.status === "denied") {
      return Object.freeze({
        status: "rejected" as const,
        code: "not-authorized" as const,
      });
    }
    const active = await this.#options.activeCancellation
      .requestActiveTurnCancellation({
        context,
        turnId,
        reason: "withdrawn-by-requester",
      });
    if (active.status === "cancelling") {
      return Object.freeze({
        status: "succeeded" as const,
        result: Object.freeze({ kind: "turn-cancelled" as const, turnId }),
      });
    }
    if (active.status === "denied") {
      return Object.freeze({
        status: "rejected" as const,
        code: "not-authorized" as const,
      });
    }
    return Object.freeze({
      status: "succeeded" as const,
      result: Object.freeze({
        kind: "turn-not-cancelled" as const,
        turnId,
        reason: active.status === "already-terminal"
          ? ("already-terminal" as const)
          : ("turn-not-queued-or-active" as const),
      }),
    });
  }
}

function requiredText(
  row: object,
  field: string,
  subject: string,
): string {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new WalkingSkeletonApplicationError(
      `${subject} is missing ${field}`,
    );
  }
  return value;
}

function requiredInteger(
  row: object,
  field: string,
  subject: string,
): number {
  const value = (row as Record<string, unknown>)[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WalkingSkeletonApplicationError(
      `${subject} is missing ${field}`,
    );
  }
  return value;
}

function parseStoredJson(value: unknown, subject: string): unknown {
  if (typeof value !== "string") {
    throw new WalkingSkeletonApplicationError(
      `${subject} is missing its JSON projection`,
    );
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new WalkingSkeletonApplicationError(
      `${subject} contains invalid JSON`,
      { cause: error },
    );
  }
}

function runExactlyOne(
  transaction: V2RepositoryTransaction,
  sql: string,
  parameters: readonly SQLiteBindValue[],
  subject: string,
): void {
  if (transaction.run(sql, parameters).changes !== 1) {
    throw new WalkingSkeletonApplicationError(
      `development coordinator did not update exactly one ${subject}`,
    );
  }
}

export interface SQLiteWalkingSkeletonTurnQueryOptions {
  readonly database: V2Database;
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
}

/** Development-only current-state query used before V2-013 delivery/query. */
export class SQLiteWalkingSkeletonTurnResultQuery
  implements TurnResultQueryPort
{
  readonly #database: V2Database;
  readonly #reads: SQLiteFoundationalAuthorizationReads;

  constructor(options: SQLiteWalkingSkeletonTurnQueryOptions) {
    this.#database = options.database;
    this.#reads = new SQLiteFoundationalAuthorizationReads({
      contextVerifier: options.contextVerifier,
    });
  }

  async queryAuthorizedTurnResult(input: {
    readonly context: AuthenticatedConnectorContext;
    readonly turnId: TurnId;
  }): Promise<AuthorizedTurnResultQuery> {
    return this.#database.transaction((transaction) =>
      this.#query(transaction, input.context, input.turnId),
    );
  }

  #query(
    transaction: V2RepositoryTransaction,
    context: AuthenticatedConnectorContext,
    inputTurnId: TurnId,
  ): AuthorizedTurnResultQuery {
    let turnId: TurnId;
    try {
      turnId = decodeServiceId("Turn", inputTurnId);
    } catch {
      return Object.freeze({ kind: "turn-not-found" as const });
    }
    const identity = this.#reads.readLiveConnectorIdentity(
      transaction,
      context,
    );
    if (identity.status === "denied") {
      return Object.freeze({ kind: "turn-read-denied" as const });
    }
    const turn = transaction.get(
      `SELECT session_id, requester_principal_id
      FROM turns WHERE id = ?`,
      [turnId],
    );
    if (turn === undefined) {
      return Object.freeze({ kind: "turn-not-found" as const });
    }
    if (
      requiredText(turn, "requester_principal_id", "turn") !==
        identity.principalId
    ) {
      return Object.freeze({ kind: "turn-not-found" as const });
    }
    const runtimeRow = transaction.get(
      `SELECT status, attempt_id, requested_at, requested_actor_kind,
        requested_actor_principal_id, requested_actor_system_component,
        cancellation_reason, completed_at, result_json,
        partial_output_available, updated_at
      FROM turn_runtime_states WHERE turn_id = ?`,
      [turnId],
    );
    if (runtimeRow === undefined) {
      throw new WalkingSkeletonApplicationError(
        "Turn is missing its runtime projection",
      );
    }
    const runtime = this.#runtime(transaction, turnId, runtimeRow);
    if (runtime.state.status !== "terminal") {
      const nonterminalRuntime = runtime as TurnRuntimeState & {
        readonly state: Exclude<
          TurnLifecycleState,
          { readonly status: "terminal" }
        >;
      };
      return Object.freeze({
        kind: "turn-found" as const,
        turnId,
        status: "active" as const,
        runtime: nonterminalRuntime,
      });
    }
    const terminalRow = transaction.get(
      `SELECT id, result_json, partial_output_available, finalized_at
      FROM turn_terminal_responses WHERE turn_id = ?`,
      [turnId],
    );
    if (terminalRow === undefined) {
      throw new WalkingSkeletonApplicationError(
        "terminal Turn is missing its immutable response",
      );
    }
    const messages = transaction.all(
      `SELECT id FROM turn_messages WHERE turn_id = ?`,
      [turnId],
    );
    if (messages.length !== 0) {
      throw new WalkingSkeletonApplicationError(
        "development query cannot project finalized messages",
      );
    }
    const response = Object.freeze({
      id: decodeServiceId(
        "TurnTerminalResponse",
        requiredText(terminalRow, "id", "terminal response"),
      ),
      turnId,
      result: decodeTurnResult(
        parseStoredJson(terminalRow.result_json, "terminal response"),
      ),
      partialOutputAvailable:
        requiredInteger(
          terminalRow,
          "partial_output_available",
          "terminal response",
        ) === 1,
      finalizedMessages: Object.freeze([]),
      finalizedAt: decodeIsoTimestamp(
        requiredText(terminalRow, "finalized_at", "terminal response"),
      ),
    });
    return Object.freeze({
      kind: "turn-found" as const,
      turnId,
      status: "terminal" as const,
      runtime: runtime as TurnRuntimeState & {
        readonly state: Extract<
          TurnLifecycleState,
          { readonly status: "terminal" }
        >;
      },
      terminalResponse: response,
    });
  }

  #runtime(
    transaction: V2RepositoryTransaction,
    turnId: TurnId,
    row: Readonly<Record<string, unknown>>,
  ): TurnRuntimeState {
    const status = requiredText(row, "status", "Turn runtime");
    const updatedAt = decodeIsoTimestamp(
      requiredText(row, "updated_at", "Turn runtime"),
    );
    let state: TurnLifecycleState;
    if (status === "queued") {
      state = Object.freeze({ status: "queued" as const });
    } else if (status === "dispatching") {
      const attemptId = decodeServiceId(
        "AgentDispatchAttempt",
        requiredText(row, "attempt_id", "dispatching Turn"),
      );
      const attempt = transaction.get(
        `SELECT attempt_number, started_at FROM agent_dispatch_attempts
        WHERE id = ? AND turn_id = ?`,
        [attemptId, turnId],
      );
      if (attempt === undefined) {
        throw new WalkingSkeletonApplicationError(
          "dispatching Turn is missing its attempt",
        );
      }
      state = Object.freeze({
        status: "dispatching" as const,
        attemptId,
        attempt: requiredInteger(attempt, "attempt_number", "dispatch attempt"),
        startedAt: decodeIsoTimestamp(
          requiredText(attempt, "started_at", "dispatch attempt"),
        ),
      });
    } else if (status === "cancelling") {
      const actorKind = requiredText(
        row,
        "requested_actor_kind",
        "cancelling Turn",
      );
      const requestedBy = actorKind === "principal"
        ? Object.freeze({
            kind: "principal" as const,
            principalId: decodeServiceId(
              "Principal",
              requiredText(
                row,
                "requested_actor_principal_id",
                "cancelling Turn",
              ),
            ),
          })
        : Object.freeze({
            kind: "system" as const,
            component: requiredText(
              row,
              "requested_actor_system_component",
              "cancelling Turn",
            ) as "turn-coordinator",
          });
      state = Object.freeze({
        status: "cancelling" as const,
        attemptId: decodeServiceId(
          "AgentDispatchAttempt",
          requiredText(row, "attempt_id", "cancelling Turn"),
        ),
        requestedAt: decodeIsoTimestamp(
          requiredText(row, "requested_at", "cancelling Turn"),
        ),
        requestedBy,
        reason: requiredText(
          row,
          "cancellation_reason",
          "cancelling Turn",
        ) as Extract<TurnLifecycleState, {
          readonly status: "cancelling";
        }>["reason"],
      });
    } else if (status === "terminal") {
      state = Object.freeze({
        status: "terminal" as const,
        completedAt: decodeIsoTimestamp(
          requiredText(row, "completed_at", "terminal Turn"),
        ),
        result: decodeTurnResult(
          parseStoredJson(row.result_json, "terminal Turn"),
        ),
        partialOutputAvailable:
          requiredInteger(
            row,
            "partial_output_available",
            "terminal Turn",
          ) === 1,
      });
    } else {
      throw new WalkingSkeletonApplicationError(
        `development query does not support runtime state ${status}`,
      );
    }
    return Object.freeze({ turnId, state, updatedAt });
  }
}

export interface SQLiteDevelopmentNoOpCoordinatorOptions {
  readonly database: V2Database;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
}

/** Development-only deterministic claim; it never calls or emulates Pi. */
export class SQLiteDevelopmentNoOpCoordinator
  implements WalkingSkeletonCoordinatorPort
{
  readonly #database: V2Database;
  readonly #clock: Clock;
  readonly #ids: IdSource;
  readonly #reads: SQLiteFoundationalAuthorizationReads;

  constructor(options: SQLiteDevelopmentNoOpCoordinatorOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#reads = new SQLiteFoundationalAuthorizationReads({
      contextVerifier: options.contextVerifier,
    });
  }

  async claimAdmittedHead(input: {
    readonly context: AuthenticatedConnectorContext;
    readonly turnId: TurnId;
    readonly receipt: TurnReceipt;
  }): Promise<TurnReceipt> {
    if (input.receipt.status !== "queued") return input.receipt;
    return this.#database.transaction((transaction) => {
      const identity = this.#reads.readLiveConnectorIdentity(
        transaction,
        input.context,
      );
      if (identity.status === "denied") return input.receipt;
      const admittedEntry = transaction.get(
        `SELECT q.principal_id, t.session_id FROM turn_queue_entries q
        JOIN turns t ON t.id = q.turn_id
        WHERE q.turn_id = ? AND t.requester_principal_id = ?`,
        [input.turnId, identity.principalId],
      );
      if (admittedEntry === undefined) {
        return input.receipt;
      }
      const sessionId = requiredText(
        admittedEntry,
        "session_id",
        "admitted queue entry",
      );
      const principalId = requiredText(
        admittedEntry,
        "principal_id",
        "admitted queue entry",
      );
      const head = transaction.get(
        `SELECT turn_id FROM turn_queue_entries
        WHERE principal_id = ? ORDER BY admission_ordinal LIMIT 1`,
        [principalId],
      );
      if (
        head === undefined ||
        requiredText(head, "turn_id", "queue head") !== input.turnId
      ) {
        return input.receipt;
      }
      const queue = transaction.get(
        `SELECT active_turn_id FROM principal_execution_capacity
        WHERE principal_id = ?`,
        [principalId],
      );
      const session = transaction.get(
        `SELECT active_turn_id FROM session_runtime_state WHERE session_id = ?`,
        [sessionId],
      );
      if (
        queue === undefined ||
        session === undefined ||
        queue.active_turn_id !== null ||
        session.active_turn_id !== null
      ) {
        return input.receipt;
      }
      const now = this.#clock.now();
      const attemptId = this.#ids.next("AgentDispatchAttempt");
      runExactlyOne(
        transaction,
        `INSERT INTO agent_dispatch_attempts (
          id, turn_id, session_id, attempt_number, state, worker_lease_id,
          worker_fencing_token, started_at, armed_at, submitted_at,
          accepted_at, completed_at, submission_outcome,
          acceptance_evidence_json
        ) VALUES (?, ?, ?, 1, 'dispatching', NULL, NULL, ?, NULL, NULL,
          NULL, NULL, NULL, NULL)`,
        [attemptId, input.turnId, sessionId, now],
        "dispatch attempt",
      );
      runExactlyOne(
        transaction,
        `DELETE FROM turn_queue_entries WHERE principal_id = ? AND turn_id = ?`,
        [principalId, input.turnId],
        "queue entry",
      );
      runExactlyOne(
        transaction,
        `UPDATE principal_execution_capacity
        SET active_turn_id = ?, updated_at = ?
        WHERE principal_id = ? AND active_turn_id IS NULL`,
        [input.turnId, now, principalId],
        "principal execution capacity",
      );
      runExactlyOne(
        transaction,
        `UPDATE session_runtime_state
        SET status = 'starting', active_turn_id = ?, last_activity_at = ?,
          updated_at = ?
        WHERE session_id = ?`,
        [input.turnId, now, now, sessionId],
        "session runtime",
      );
      runExactlyOne(
        transaction,
        `UPDATE turn_runtime_states
        SET status = 'dispatching', attempt_id = ?, updated_at = ?
        WHERE turn_id = ? AND status = 'queued'`,
        [attemptId, now, input.turnId],
        "Turn runtime",
      );
      const installation = transaction.get(
        `SELECT id FROM installations ORDER BY id LIMIT 1`,
        [],
      );
      if (installation === undefined) {
        throw new WalkingSkeletonApplicationError(
          "development coordinator is missing its installation",
        );
      }
      const installationId = decodeServiceId(
        "Installation",
        requiredText(installation, "id", "installation"),
      );
      insertAuditEnvelope(transaction, {
        id: this.#ids.next("AuditEnvelope"),
        installationId,
        actor: { kind: "system", component: "turn-coordinator" },
        outcome: "succeeded",
        action: "turn-dispatched",
        sessionId: decodeServiceId("Session", sessionId),
        turnId: input.turnId,
        attemptId,
        occurredAt: now,
      });
      insertAuditEnvelope(transaction, {
        id: this.#ids.next("AuditEnvelope"),
        installationId,
        actor: { kind: "system", component: "turn-coordinator" },
        outcome: "succeeded",
        action: "turn-state-transitioned",
        sessionId: decodeServiceId("Session", sessionId),
        turnId: input.turnId,
        occurredAt: now,
      });
      return Object.freeze({
        turnId: input.turnId,
        status: "starting" as const,
        controls: Object.freeze({ canCancel: true }),
      });
    });
  }
}

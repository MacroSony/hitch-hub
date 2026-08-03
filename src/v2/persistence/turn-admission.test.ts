import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  createFirstSliceAuthorizationTrust,
  type FirstSliceAuthorizationTrust,
} from "../application/authorization-contexts.js";
import type {
  AuthenticatedConnectorContext,
} from "../model/application.js";
import type { PreparedAttachmentAdmission } from "../model/application.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  createLocalImageIntakeVault,
  LocalPrivateAttachmentStore,
} from "./attachment-store.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "./bootstrap-publication.js";
import type { V2Database } from "./database.js";
import { openCanonicalHitchV2Database } from "./initialize.js";
import { SQLiteSessionCreationUnitOfWork } from "./session-creation.js";
import {
  FIRST_SLICE_RESPONSE_DELIVERY,
  SQLiteTurnAdmissionUnitOfWork,
  SQLiteTurnCancellationUnitOfWork,
  TurnAdmissionInputError,
  TurnAdmissionIntegrityError,
} from "./turn-admission.js";
import type { SessionId, TurnId } from "../model/primitives.js";

const CLOCK_START = "2026-07-29T12:06:00.000Z";
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
]);

interface Harness {
  readonly trust: FirstSliceAuthorizationTrust;
  readonly context: AuthenticatedConnectorContext;
  readonly sessionId: SessionId;
}

async function publishAuthenticateAndCreateSession(
  database: V2Database,
  displayName?: string,
): Promise<Harness> {
  const records = createBootstrapPublicationRecords();
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:00:01.000Z"),
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(records);
  const trust = createFirstSliceAuthorizationTrust({
    database,
    clock: new DeterministicClock("2026-07-29T12:03:00.000Z"),
    ids: new DeterministicIdSource("authorization"),
  });
  const authentication = await trust.localAuthentication.authenticate(
    trust.localConnectionIssuer.issueAcceptedConnection(),
  );
  assert.equal(authentication.status, "authenticated");
  if (authentication.status !== "authenticated") {
    throw new Error("test authentication unexpectedly failed");
  }
  const created = await new SQLiteSessionCreationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:05:00.000Z"),
    ids: new DeterministicIdSource("session"),
    contextVerifier: trust.contextVerifier,
  }).createPrivateSession({
    context: authentication.context,
    profileReference: records.agentProfile.reference,
    workspaceReference: records.workspace.reference,
    ...(displayName === undefined ? {} : { displayName }),
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    throw new Error("test session unexpectedly not created");
  }
  return Object.freeze({
    trust,
    context: authentication.context,
    sessionId: created.session.id,
  });
}

function admission(
  database: V2Database,
  trust: FirstSliceAuthorizationTrust,
): SQLiteTurnAdmissionUnitOfWork {
  return new SQLiteTurnAdmissionUnitOfWork({
    database,
    clock: new DeterministicClock(CLOCK_START),
    ids: new DeterministicIdSource("admission"),
    contextVerifier: trust.contextVerifier,
  });
}

function cancellation(
  database: V2Database,
  trust: FirstSliceAuthorizationTrust,
): SQLiteTurnCancellationUnitOfWork {
  return new SQLiteTurnCancellationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:07:00.000Z"),
    ids: new DeterministicIdSource("cancellation"),
    contextVerifier: trust.contextVerifier,
  });
}

function countRows(database: V2Database, table: string): number {
  return database.transaction((transaction) => {
    const row = transaction.get(
      `SELECT COUNT(*) AS count FROM "${table}"`,
      [],
    );
    assert.ok(row !== undefined && typeof row.count === "number");
    return row.count;
  });
}

async function createSecondSession(
  database: V2Database,
  harness: Harness,
  displayName: string | undefined,
  ids: string,
): Promise<SessionId> {
  const records = createBootstrapPublicationRecords();
  const created = await new SQLiteSessionCreationUnitOfWork({
    database,
    clock: new DeterministicClock("2026-07-29T12:05:30.000Z"),
    ids: new DeterministicIdSource(ids),
    contextVerifier: harness.trust.contextVerifier,
  }).createPrivateSession({
    context: harness.context,
    profileReference: records.agentProfile.reference,
    workspaceReference: records.workspace.reference,
    ...(displayName === undefined ? {} : { displayName }),
  });
  assert.equal(created.status, "created");
  if (created.status !== "created") {
    throw new Error("second session unexpectedly not created");
  }
  return created.session.id;
}

test("[V2-S04/turn-admission-idempotency] duplicate submission returns the original receipt; key/origin conflicts fail closed", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(database);
      const unitOfWork = admission(database, harness.trust);
      const input = {
        context: harness.context,
        session: {
          kind: "session-id" as const,
          sessionId: harness.sessionId,
        },
        originMessageId: "origin-1",
        idempotencyKey: "key-1",
        text: "Summarize the workspace.",
      };

      const admitted = await unitOfWork.admitTurn({
        ...input,
        originMessageId: input.originMessageId as never,
        idempotencyKey: input.idempotencyKey as never,
      });
      assert.equal(admitted.status, "admitted");
      if (admitted.status !== "admitted") return;
      assert.equal(admitted.turn.id, "admission:Turn:0001");
      assert.equal(admitted.turn.sessionId, harness.sessionId);
      assert.equal(admitted.turn.origin.kind, "endpoint");
      assert.equal(admitted.turn.origin.originMessageId, "origin-1");
      assert.equal(admitted.turn.idempotencyKey, "key-1");
      assert.deepEqual(admitted.turn.execution, {
        model: {
          kind: "resolved",
          providerId: "openai-codex",
          modelId: "gpt-5.4-mini",
        },
        reasoning: { kind: "agent-default" },
      });
      assert.deepEqual(admitted.inputSnapshot.triggeringContent, [
        { kind: "text", text: "Summarize the workspace." },
      ]);
      assert.deepEqual(admitted.inferenceResolution, {
        turnId: admitted.turn.id,
        model: { providerId: "openai-codex", modelId: "gpt-5.4-mini" },
        reasoning: { kind: "agent-default" },
        resolvedBy: "hitch",
        resolvedAt: CLOCK_START,
      });
      assert.deepEqual(admitted.runtime, {
        turnId: admitted.turn.id,
        state: { status: "queued" },
        updatedAt: CLOCK_START,
      });
      assert.deepEqual(admitted.receipt, {
        turnId: admitted.turn.id,
        status: "queued",
        queue: {
          turnId: admitted.turn.id,
          position: 0,
          requesterPrincipalId: "owner-v1",
          controls: { canCancel: true },
        },
      });
      assert.equal(admitted.auditEvents.length, 1);
      assert.equal(admitted.auditEvents[0]?.action, "turn-admitted");

      const duplicate = await unitOfWork.admitTurn({
        ...input,
        originMessageId: input.originMessageId as never,
        idempotencyKey: input.idempotencyKey as never,
      });
      assert.deepEqual(duplicate, {
        status: "duplicate",
        turnId: admitted.turn.id,
        receipt: admitted.receipt,
      });
      assert.equal(countRows(database, "turns"), 1);
      assert.equal(countRows(database, "turn_queue_entries"), 1);

      const changedText = await unitOfWork.admitTurn({
        ...input,
        text: "Different text entirely.",
        originMessageId: input.originMessageId as never,
        idempotencyKey: input.idempotencyKey as never,
      });
      assert.deepEqual(changedText, { status: "denied" });
      const reusedOrigin = await unitOfWork.admitTurn({
        ...input,
        idempotencyKey: "key-2" as never,
        originMessageId: input.originMessageId as never,
      });
      assert.deepEqual(reusedOrigin, { status: "denied" });
      const otherSessionKey = await unitOfWork.admitTurn({
        ...input,
        session: { kind: "session-name" as const, name: "missing" },
        originMessageId: "origin-9" as never,
        idempotencyKey: "key-1" as never,
      });
      assert.deepEqual(otherSessionKey, { status: "session-not-found" });

      // The same key against a real second session is a conflict, not a replay.
      const secondSession = await createSecondSession(
        database,
        harness,
        "Second session",
        "session-two",
      );
      const crossSession = await unitOfWork.admitTurn({
        ...input,
        session: { kind: "session-id" as const, sessionId: secondSession },
        originMessageId: "origin-10" as never,
        idempotencyKey: "key-1" as never,
      });
      assert.deepEqual(crossSession, { status: "denied" });
      assert.equal(countRows(database, "turns"), 1);

      const auditCounts = database.transaction((transaction) => {
        const row = transaction.get(
          `SELECT COUNT(*) AS count FROM audit_envelopes
          WHERE action = 'turn-admitted'`,
          [],
        );
        assert.ok(row !== undefined);
        return row.count;
      });
      assert.equal(auditCounts, 1);
    } finally {
      database.close();
    }
  });
});

test("[V2-S05/turn-queue-capacity] three pending turns are admitted; the fourth is rejected and sessions are independent", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(database);
      const unitOfWork = admission(database, harness.trust);
      const selector = {
        kind: "session-id" as const,
        sessionId: harness.sessionId,
      };

      const turnIds: TurnId[] = [];
      for (let index = 1; index <= 3; index += 1) {
        const result = await unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: `origin-${index}` as never,
          idempotencyKey: `key-${index}` as never,
          text: `Prompt ${index}`,
        });
        assert.equal(result.status, "admitted");
        if (result.status !== "admitted") return;
        assert.equal(result.receipt.status, "queued");
        if (result.receipt.status !== "queued") return;
        assert.equal(result.receipt.queue.position, index - 1);
        turnIds.push(result.turn.id);
      }
      const rejected = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-4" as never,
        idempotencyKey: "key-4" as never,
        text: "Prompt 4",
      });
      assert.deepEqual(rejected, { status: "queue-capacity-exceeded" });
      assert.equal(countRows(database, "turns"), 3);
      assert.equal(countRows(database, "turn_queue_entries"), 3);

      const secondSession = await createSecondSession(
        database,
        harness,
        "Second session",
        "session-two",
      );
      const other = await unitOfWork.admitTurn({
        context: harness.context,
        session: { kind: "session-id", sessionId: secondSession },
        originMessageId: "origin-other" as never,
        idempotencyKey: "key-other" as never,
        text: "Independent session prompt",
      });
      assert.equal(other.status, "admitted");
      if (other.status === "admitted") {
        assert.equal(other.receipt.status, "queued");
        if (other.receipt.status === "queued") {
          assert.equal(other.receipt.queue.position, 0);
        }
      }
      assert.equal(countRows(database, "turns"), 4);

      // A duplicate replay reports the live queue position.
      const replay = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-3" as never,
        idempotencyKey: "key-3" as never,
        text: "Prompt 3",
      });
      assert.equal(replay.status, "duplicate");
      if (replay.status === "duplicate") {
        assert.deepEqual(replay, {
          status: "duplicate",
          turnId: turnIds[2],
          receipt: {
            turnId: turnIds[2],
            status: "queued",
            queue: {
              turnId: turnIds[2],
              position: 2,
              requesterPrincipalId: "owner-v1",
              controls: { canCancel: true },
            },
          },
        });
      }
    } finally {
      database.close();
    }
  });
});

test("[V2-S12/turn-admission-attachment] admission persists attachment rows exactly once and rejection leaves none", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(database);
      const unitOfWork = admission(database, harness.trust);
      const authenticationRequestId =
        harness.context.actor.requestId as never;
      const intake = createLocalImageIntakeVault();
      const store = new LocalPrivateAttachmentStore({
        database,
        clock: new DeterministicClock("2026-07-29T12:05:40.000Z"),
        ids: new DeterministicIdSource("store"),
        intake,
      });
      const selector = {
        kind: "session-id" as const,
        sessionId: harness.sessionId,
      };

      const staged = await store.stageBoundedImage(
        intake.seal({ bytes: PNG, authenticationRequestId }),
      );
      assert.equal(staged.status, "staged");
      if (staged.status !== "staged") return;

      const admitted = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-a" as never,
        idempotencyKey: "key-a" as never,
        text: "Look at this image.",
        preparedAttachment: staged.stage.preparedAdmission,
      });
      assert.equal(admitted.status, "admitted");
      if (admitted.status !== "admitted") return;
      assert.deepEqual(admitted.attachment, staged.stage.preparedAdmission.attachment);
      assert.deepEqual(admitted.inputSnapshot.triggeringContent, [
        { kind: "text", text: "Look at this image." },
        {
          kind: "attachment",
          attachmentId: staged.stage.preparedAdmission.attachment.id,
          mediaType: "image",
          mimeType: "image/png",
        },
      ]);
      assert.equal(admitted.auditEvents.length, 2);
      assert.equal(admitted.auditEvents[1]?.action, "attachment-admitted");
      assert.equal(countRows(database, "attachments"), 1);
      assert.equal(countRows(database, "private_blobs"), 1);

      const finalized = await store.finalizeAdmittedImage({
        stage: staged.stage,
        admission: admitted as never,
      });
      assert.deepEqual(finalized, {
        status: "finalized",
        attachmentId: staged.stage.preparedAdmission.attachment.id,
      });

      // Rejection persists no attachment rows; the caller rolls the stage back.
      for (let index = 1; index <= 2; index += 1) {
        const filler = await unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: `origin-fill-${index}` as never,
          idempotencyKey: `key-fill-${index}` as never,
          text: `Filler ${index}`,
        });
        assert.equal(filler.status, "admitted");
      }
      const rejectedStage = await store.stageBoundedImage(
        intake.seal({ bytes: PNG, authenticationRequestId }),
      );
      assert.equal(rejectedStage.status, "staged");
      if (rejectedStage.status !== "staged") return;
      const rejected = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-b" as never,
        idempotencyKey: "key-b" as never,
        text: "One image too many.",
        preparedAttachment: rejectedStage.stage.preparedAdmission,
      });
      assert.deepEqual(rejected, { status: "queue-capacity-exceeded" });
      assert.equal(countRows(database, "attachments"), 1);
      assert.equal(countRows(database, "private_blobs"), 1);
      const rolledBack = await store.rollbackUnfinalizedImage({
        stage: rejectedStage.stage,
        reason: "admission-rejected",
      });
      assert.deepEqual(rolledBack, { status: "rolled-back" });
      assert.equal(
        existsSync(
          join(
            database.root.path,
            "attachments",
            "stage",
            rejectedStage.stage.preparedAdmission.attachment.blob.blobId,
          ),
        ),
        false,
      );

      // A forged admission record fails closed before any row is written.
      const forged = {
        attachment: {
          ...staged.stage.preparedAdmission.attachment,
          integrityDigest: "sha256:not-a-digest",
        },
      } as unknown as PreparedAttachmentAdmission;
      await assert.rejects(
        unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: "origin-c" as never,
          idempotencyKey: "key-c" as never,
          text: "Forged attachment.",
          preparedAttachment: forged,
        }),
        TurnAdmissionIntegrityError,
      );

      // Well-shaped but foreign provenance is rejected before persistence.
      const foreignProvenance = {
        attachment: {
          ...staged.stage.preparedAdmission.attachment,
          id: "store:Attachment:7777",
          admittedFrom: {
            kind: "local-cli" as const,
            authenticationRequestId:
              "store:AuthenticationRequest:9999" as never,
          },
        },
      } as unknown as PreparedAttachmentAdmission;
      await assert.rejects(
        unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: "origin-d" as never,
          idempotencyKey: "key-d" as never,
          text: "Foreign provenance.",
          preparedAttachment: foreignProvenance,
        }),
        TurnAdmissionIntegrityError,
      );
      assert.equal(countRows(database, "attachments"), 1);

      // Replaying the admitted turn with a different attachment conflicts.
      const otherStage = await store.stageBoundedImage(
        intake.seal({ bytes: PNG, authenticationRequestId }),
      );
      assert.equal(otherStage.status, "staged");
      if (otherStage.status !== "staged") return;
      const mismatchedReplay = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-a" as never,
        idempotencyKey: "key-a" as never,
        text: "Look at this image.",
        preparedAttachment: otherStage.stage.preparedAdmission,
      });
      assert.deepEqual(mismatchedReplay, { status: "denied" });
      const rolledBackOther = await store.rollbackUnfinalizedImage({
        stage: otherStage.stage,
        reason: "admission-rejected",
      });
      assert.deepEqual(rolledBackOther, { status: "rolled-back" });

      // Replaying it exactly returns the original receipt.
      const exactReplay = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-a" as never,
        idempotencyKey: "key-a" as never,
        text: "Look at this image.",
        preparedAttachment: staged.stage.preparedAdmission,
      });
      assert.equal(exactReplay.status, "duplicate");
      if (exactReplay.status === "duplicate") {
        assert.equal(exactReplay.turnId, admitted.turn.id);
      }
    } finally {
      database.close();
    }
  });
});

test("[V2-S06/queued-cancellation] requester cancellation compare-removes only a still-pending turn and is response-idempotent", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(database);
      const unitOfWork = admission(database, harness.trust);
      const control = cancellation(database, harness.trust);
      const selector = {
        kind: "session-id" as const,
        sessionId: harness.sessionId,
      };

      const first = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-1" as never,
        idempotencyKey: "key-1" as never,
        text: "First",
      });
      const second = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-2" as never,
        idempotencyKey: "key-2" as never,
        text: "Second",
      });
      assert.equal(first.status, "admitted");
      assert.equal(second.status, "admitted");
      if (first.status !== "admitted" || second.status !== "admitted") return;

      const cancelled = await control.cancelStillQueuedTurn({
        context: harness.context,
        turnId: first.turn.id,
      });
      assert.equal(cancelled.status, "cancelled");
      if (cancelled.status !== "cancelled") return;
      assert.deepEqual(cancelled.terminalResponse.result, {
        outcome: "cancelled",
        reason: "withdrawn-by-requester",
      });
      assert.equal(cancelled.terminalResponse.partialOutputAvailable, false);
      assert.deepEqual(cancelled.terminalResponse.finalizedMessages, []);
      assert.equal(cancelled.delivery.state.status, "pending");
      assert.equal(cancelled.delivery.attemptCount, 0);
      assert.equal(
        cancelled.delivery.maximumAttempts,
        FIRST_SLICE_RESPONSE_DELIVERY.maximumAttempts,
      );
      assert.equal(
        cancelled.delivery.recipientPrincipalId,
        "owner-v1",
      );
      assert.deepEqual(
        cancelled.auditEvents.map((event) => event.action),
        [
          "turn-terminalized",
          "response-delivery-created",
          "turn-state-transitioned",
        ],
      );

      const replay = await control.cancelStillQueuedTurn({
        context: harness.context,
        turnId: first.turn.id,
      });
      assert.deepEqual(replay, { status: "already-cancelled", auditEvents: [] });
      assert.equal(countRows(database, "turn_queue_entries"), 1);

      // The survivor keeps its durable position; FIFO order is preserved.
      const remaining = database.transaction((transaction) => {
        const row = transaction.get(
          `SELECT turn_id, queue_position FROM turn_queue_entries
          WHERE session_id = ?`,
          [harness.sessionId],
        );
        assert.ok(row !== undefined);
        return row;
      });
      assert.equal(remaining.turn_id, second.turn.id);
      assert.equal(remaining.queue_position, 1);

      const runtime = database.transaction((transaction) => {
        const row = transaction.get(
          `SELECT status, result_json, partial_output_available
          FROM turn_runtime_states WHERE turn_id = ?`,
          [first.turn.id],
        );
        assert.ok(row !== undefined);
        return row;
      });
      assert.equal(runtime.status, "terminal");
      assert.deepEqual(JSON.parse(String(runtime.result_json)), {
        outcome: "cancelled",
        reason: "withdrawn-by-requester",
      });
      assert.equal(runtime.partial_output_available, 0);

      const unknown = await control.cancelStillQueuedTurn({
        context: harness.context,
        turnId: "admission:Turn:9999" as TurnId,
      });
      assert.deepEqual(unknown, { status: "not-queued", auditEvents: [] });

      const forged = await control.cancelStillQueuedTurn({
        context: {} as never,
        turnId: second.turn.id,
      });
      assert.deepEqual(forged, { status: "denied", auditEvents: [] });

      const deliveryComponent =
        await harness.trust.serviceContextIssuer.forComponent("delivery");
      const wrongComponent = await control.cancelStillQueuedTurn({
        context: deliveryComponent as never,
        turnId: second.turn.id,
      });
      assert.deepEqual(wrongComponent, {
        status: "denied",
        auditEvents: [],
      });
      assert.equal(countRows(database, "turn_queue_entries"), 1);

      // A lost-response retry after cancellation reports the terminal truth.
      const replayedAdmission = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-1" as never,
        idempotencyKey: "key-1" as never,
        text: "First",
      });
      assert.deepEqual(replayedAdmission, {
        status: "duplicate",
        turnId: first.turn.id,
        receipt: {
          turnId: first.turn.id,
          status: "starting",
          controls: { canCancel: false },
        },
      });

      const persistedAudit = database.transaction((transaction) => {
        const rows = transaction.all(
          `SELECT action FROM audit_envelopes WHERE turn_id = ?
          ORDER BY rowid`,
          [first.turn.id],
        );
        return rows.map((row) => row.action);
      });
      assert.deepEqual(persistedAudit, [
        "turn-admitted",
        "turn-terminalized",
        "response-delivery-created",
        "turn-state-transitioned",
      ]);
    } finally {
      database.close();
    }
  });
});

test("[V2-S06/active-cancellation-intent] active cancellation records durable intent without touching worker authority", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(database);
      const unitOfWork = admission(database, harness.trust);
      const control = cancellation(database, harness.trust);
      const selector = {
        kind: "session-id" as const,
        sessionId: harness.sessionId,
      };

      const admitted = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-1" as never,
        idempotencyKey: "key-1" as never,
        text: "Active work",
      });
      assert.equal(admitted.status, "admitted");
      if (admitted.status !== "admitted") return;

      // A queued Turn is not active; it uses compare-and-remove instead.
      const queued = await control.requestActiveTurnCancellation({
        context: harness.context,
        turnId: admitted.turn.id,
        reason: "withdrawn-by-requester",
      });
      assert.deepEqual(queued, { status: "not-active", auditEvents: [] });

      // Simulate a claimed head: one dispatching attempt with no worker lease.
      database.transaction((transaction) => {
        transaction.run(
          `INSERT INTO agent_dispatch_attempts (
            id, turn_id, session_id, attempt_number, state, started_at
          ) VALUES ('test-attempt-1', ?, ?, 1, 'dispatching', ?)`,
          [admitted.turn.id, harness.sessionId, CLOCK_START],
        );
        const updated = transaction.run(
          `UPDATE turn_runtime_states
          SET status = 'dispatching', attempt_id = 'test-attempt-1',
            updated_at = ?
          WHERE turn_id = ?`,
          [CLOCK_START, admitted.turn.id],
        );
        assert.equal(updated.changes, 1);
        transaction.run(
          `DELETE FROM turn_queue_entries WHERE turn_id = ?`,
          [admitted.turn.id],
        );
      });

      const cancelling = await control.requestActiveTurnCancellation({
        context: harness.context,
        turnId: admitted.turn.id,
        reason: "withdrawn-by-requester",
      });
      assert.equal(cancelling.status, "cancelling");
      if (cancelling.status !== "cancelling") return;
      assert.deepEqual(cancelling.runtime, {
        turnId: admitted.turn.id,
        state: {
          status: "cancelling",
          attemptId: "test-attempt-1",
          requestedAt: "2026-07-29T12:07:00.000Z",
          requestedBy: { kind: "principal", principalId: "owner-v1" },
          reason: "withdrawn-by-requester",
        },
        updatedAt: "2026-07-29T12:07:00.000Z",
      });
      assert.equal(cancelling.auditEvents.length, 1);
      assert.equal(
        cancelling.auditEvents[0]?.action,
        "turn-state-transitioned",
      );

      // Worker authority is untouched: the attempt row is unchanged.
      const attempt = database.transaction((transaction) => {
        const row = transaction.get(
          `SELECT state, worker_lease_id FROM agent_dispatch_attempts
          WHERE id = 'test-attempt-1'`,
          [],
        );
        assert.ok(row !== undefined);
        return row;
      });
      assert.equal(attempt.state, "dispatching");
      assert.equal(attempt.worker_lease_id, null);

      // Repeats are response-idempotent; queued cancellation no longer wins.
      const repeat = await control.requestActiveTurnCancellation({
        context: harness.context,
        turnId: admitted.turn.id,
        reason: "withdrawn-by-requester",
      });
      assert.deepEqual(repeat, { status: "not-active", auditEvents: [] });
      const queuedCancel = await control.cancelStillQueuedTurn({
        context: harness.context,
        turnId: admitted.turn.id,
      });
      assert.deepEqual(queuedCancel, {
        status: "not-queued",
        auditEvents: [],
      });

      // The coordinator may record intent for a session stop.
      const coordinator =
        await harness.trust.serviceContextIssuer.forComponent(
          "turn-coordinator",
        );
      const stopped = await control.requestActiveTurnCancellation({
        context: coordinator,
        turnId: admitted.turn.id,
        reason: "session-stopped",
      });
      // Already-cancelling: intent was already recorded by the requester.
      assert.deepEqual(stopped, { status: "not-active", auditEvents: [] });

      // Coordinator intent on an accepted attempt records system authority.
      const second = await unitOfWork.admitTurn({
        context: harness.context,
        session: selector,
        originMessageId: "origin-2" as never,
        idempotencyKey: "key-2" as never,
        text: "Accepted work",
      });
      assert.equal(second.status, "admitted");
      if (second.status !== "admitted") return;
      database.transaction((transaction) => {
        transaction.run(
          `INSERT INTO agent_dispatch_attempts (
            id, turn_id, session_id, attempt_number, state, started_at,
            armed_at, submitted_at, accepted_at, submission_outcome,
            acceptance_evidence_json
          ) VALUES (
            'test-attempt-2', ?, ?, 1, 'accepted', ?, ?, ?, ?, 'submitted',
            '{"kind":"explicit-ack","correlation":"dispatched-prompt-request"}'
          )`,
          [
            second.turn.id,
            harness.sessionId,
            CLOCK_START,
            CLOCK_START,
            CLOCK_START,
            CLOCK_START,
          ],
        );
        transaction.run(
          `UPDATE turn_runtime_states
          SET status = 'accepted', attempt_id = 'test-attempt-2',
            updated_at = ?
          WHERE turn_id = ?`,
          [CLOCK_START, second.turn.id],
        );
        transaction.run(
          `DELETE FROM turn_queue_entries WHERE turn_id = ?`,
          [second.turn.id],
        );
      });
      const coordinatorCancelling =
        await control.requestActiveTurnCancellation({
          context: coordinator,
          turnId: second.turn.id,
          reason: "session-stopped",
        });
      assert.equal(coordinatorCancelling.status, "cancelling");
      if (coordinatorCancelling.status === "cancelling") {
        assert.deepEqual(coordinatorCancelling.runtime.state, {
          status: "cancelling",
          attemptId: "test-attempt-2",
          requestedAt: "2026-07-29T12:07:00.000Z",
          requestedBy: { kind: "system", component: "turn-coordinator" },
          reason: "session-stopped",
        });
      }
    } finally {
      database.close();
    }
  });
});

test("session resolution handles names, ambiguity, missing sessions, and inactive bindings", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(
        database,
        "Shared name",
      );
      const unitOfWork = admission(database, harness.trust);
      const input = {
        context: harness.context,
        originMessageId: "origin-n" as never,
        idempotencyKey: "key-n" as never,
        text: "Resolve me",
      };

      const missing = await unitOfWork.admitTurn({
        ...input,
        session: {
          kind: "session-id",
          sessionId: "session:Session:9999" as SessionId,
        },
      });
      assert.deepEqual(missing, { status: "session-not-found" });

      const ambiguousBase = await createSecondSession(
        database,
        harness,
        "Shared name",
        "session-two",
      );
      const ambiguous = await unitOfWork.admitTurn({
        ...input,
        session: { kind: "session-name", name: "Shared name" },
      });
      assert.deepEqual(ambiguous, { status: "session-name-ambiguous" });

      const byName = await unitOfWork.admitTurn({
        ...input,
        session: { kind: "session-id", sessionId: ambiguousBase },
      });
      assert.equal(byName.status, "admitted");

      const uniqueName = await createSecondSession(
        database,
        harness,
        "Unique name",
        "session-three",
      );
      const resolvedByName = await unitOfWork.admitTurn({
        ...input,
        originMessageId: "origin-n2" as never,
        idempotencyKey: "key-n2" as never,
        session: { kind: "session-name", name: "Unique name" },
      });
      assert.equal(resolvedByName.status, "admitted");
      if (resolvedByName.status === "admitted") {
        assert.equal(resolvedByName.turn.sessionId, uniqueName);
      }

      // A suspended binding denies admission without new state.
      database.transaction((transaction) => {
        const updated = transaction.run(
          `UPDATE session_endpoint_bindings
          SET state = 'suspended', suspended_at = ?,
            suspended_actor_kind = 'principal',
            suspended_actor_principal_id = 'owner-v1',
            suspended_reason = 'test suspension', updated_at = ?
          WHERE session_id = ?`,
          [CLOCK_START, CLOCK_START, harness.sessionId],
        );
        assert.equal(updated.changes, 1);
      });
      const denied = await unitOfWork.admitTurn({
        ...input,
        originMessageId: "origin-n3" as never,
        idempotencyKey: "key-n3" as never,
        session: { kind: "session-id", sessionId: harness.sessionId },
      });
      assert.deepEqual(denied, { status: "denied" });
    } finally {
      database.close();
    }
  });
});

test("admission revalidates prompt bounds and rejects malformed input", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await publishAuthenticateAndCreateSession(database);
      const unitOfWork = admission(database, harness.trust);
      const selector = {
        kind: "session-id" as const,
        sessionId: harness.sessionId,
      };

      await assert.rejects(
        unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: "origin-e" as never,
          idempotencyKey: "key-e" as never,
          text: "",
        }),
        TurnAdmissionInputError,
      );
      await assert.rejects(
        unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: "origin-e" as never,
          idempotencyKey: "key-e" as never,
          text: "x".repeat(65_537),
        }),
        TurnAdmissionInputError,
      );
      await assert.rejects(
        unitOfWork.admitTurn({
          context: harness.context,
          session: selector,
          originMessageId: "" as never,
          idempotencyKey: "key-e" as never,
          text: "valid",
        }),
        TurnAdmissionInputError,
      );
      assert.equal(countRows(database, "turns"), 0);
    } finally {
      database.close();
    }
  });
});

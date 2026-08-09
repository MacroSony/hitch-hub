import assert from "node:assert/strict";
import test from "node:test";

import { createFirstSliceAuthorizationTrust } from "./authorization-contexts.js";
import type {
  AuthenticatedConnectorContext,
  FirstSliceConnectorApplication,
} from "../model/application.js";
import { createLocalImageIntakeVault } from "../persistence/attachment-store.js";
import { LocalPrivateAttachmentStore } from "../persistence/attachment-store.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import type { V2Database } from "../persistence/database.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { SQLiteSessionCreationUnitOfWork } from "../persistence/session-creation.js";
import {
  SQLiteTurnAdmissionUnitOfWork,
  SQLiteTurnCancellationUnitOfWork,
} from "../persistence/turn-admission.js";
import { createBootstrapPublicationRecords } from "../test-support/bootstrap-publication.js";
import {
  DeterministicClock,
  DeterministicIdSource,
} from "../test-support/deterministic.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  SQLiteDevelopmentNoOpCoordinator,
  SQLiteWalkingSkeletonTurnResultQuery,
  WalkingSkeletonConnectorApplication,
} from "./walking-skeleton.js";

const CLOCK = new DeterministicClock("2026-07-30T12:00:00.000Z");

async function prepare(database: V2Database): Promise<{
  readonly context: AuthenticatedConnectorContext;
  readonly application: FirstSliceConnectorApplication;
  readonly rebuild: () => FirstSliceConnectorApplication;
  readonly imageIntake: ReturnType<typeof createLocalImageIntakeVault>;
}> {
  const records = createBootstrapPublicationRecords();
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock: CLOCK,
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(records);
  const trust = createFirstSliceAuthorizationTrust({
    database,
    clock: CLOCK,
    ids: new DeterministicIdSource("authentication"),
  });
  const authenticated = await trust.localAuthentication.authenticate(
    trust.localConnectionIssuer.issueAcceptedConnection(),
  );
  assert.equal(authenticated.status, "authenticated");
  if (authenticated.status !== "authenticated") {
    throw new Error("walking skeleton authentication failed");
  }
  const imageIntake = createLocalImageIntakeVault();
  let generation = 0;
  const rebuild = (): FirstSliceConnectorApplication => {
    generation += 1;
    const ids = new DeterministicIdSource(`skeleton-${generation}`);
    const cancellation = new SQLiteTurnCancellationUnitOfWork({
      database,
      clock: CLOCK,
      ids,
      contextVerifier: trust.contextVerifier,
    });
    return new WalkingSkeletonConnectorApplication({
      sessionCreation: new SQLiteSessionCreationUnitOfWork({
        database,
        clock: CLOCK,
        ids,
        contextVerifier: trust.contextVerifier,
      }),
      turnAdmission: new SQLiteTurnAdmissionUnitOfWork({
        database,
        clock: CLOCK,
        ids,
        contextVerifier: trust.contextVerifier,
      }),
      attachmentStorage: new LocalPrivateAttachmentStore({
        database,
        clock: CLOCK,
        ids,
        intake: imageIntake,
      }),
      turnResultQuery: new SQLiteWalkingSkeletonTurnResultQuery({
        database,
        contextVerifier: trust.contextVerifier,
      }),
      queuedCancellation: cancellation,
      activeCancellation: cancellation,
      coordinator: new SQLiteDevelopmentNoOpCoordinator({
        database,
        clock: CLOCK,
        ids,
        contextVerifier: trust.contextVerifier,
      }),
    });
  };
  return {
    context: authenticated.context,
    application: rebuild(),
    rebuild,
    imageIntake,
  };
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

test("[V2-S05/walking-skeleton-active-and-fifo-capacity] durable local application preserves principal-wide capacity across sessions and restart", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const records = createBootstrapPublicationRecords();
      const created = await harness.application.execute(harness.context, {
        kind: "create-session",
        profileReference: records.agentProfile.reference,
        workspaceReference: records.workspace.reference,
        displayName: "Walking skeleton",
      });
      assert.equal(created.status, "succeeded");
      if (created.status !== "succeeded") return;
      assert.equal(created.result.kind, "session-created");
      if (created.result.kind !== "session-created") return;
      const sessionId = created.result.sessionId;
      const secondCreated = await harness.application.execute(
        harness.context,
        {
          kind: "create-session",
          profileReference: records.agentProfile.reference,
          workspaceReference: records.workspace.reference,
          displayName: "Second walking skeleton",
        },
      );
      assert.equal(secondCreated.status, "succeeded");
      if (
        secondCreated.status !== "succeeded" ||
        secondCreated.result.kind !== "session-created"
      ) return;
      const secondSessionId = secondCreated.result.sessionId;
      const sessions = [
        sessionId,
        secondSessionId,
        sessionId,
        secondSessionId,
      ] as const;

      const submitted: { turnId: string; status: string }[] = [];
      for (let index = 1; index <= 4; index += 1) {
        const response = await harness.application.execute(harness.context, {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: sessions[index - 1]! },
          idempotencyKey: `retry-key-${index}` as never,
          text: `Prompt ${index}`,
        });
        assert.equal(response.status, "succeeded");
        if (
          response.status !== "succeeded" ||
          response.result.kind !== "turn-submitted"
        ) return;
        submitted.push({
          turnId: response.result.receipt.turnId,
          status: response.result.receipt.status,
        });
        await response.responseEvents.close();
      }
      assert.deepEqual(submitted.map((item) => item.status), [
        "starting",
        "queued",
        "queued",
        "queued",
      ]);

      const full = await harness.application.execute(harness.context, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId },
        idempotencyKey: "retry-key-5" as never,
        text: "Prompt 5",
      });
      assert.deepEqual(full, {
        status: "rejected",
        code: "queue-capacity-exceeded",
      });

      const restarted = harness.rebuild();
      const replay = await restarted.execute(harness.context, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId },
        idempotencyKey: "retry-key-1" as never,
        text: "Prompt 1",
      });
      assert.equal(replay.status, "succeeded");
      if (
        replay.status !== "succeeded" ||
        replay.result.kind !== "turn-submitted"
      ) return;
      assert.equal(replay.result.receipt.turnId, submitted[0]!.turnId);
      assert.equal(replay.result.receipt.status, "starting");
      await replay.responseEvents.close();

      const active = await restarted.execute(harness.context, {
        kind: "get-turn",
        turnId: submitted[0]!.turnId as never,
      });
      assert.equal(active.status, "succeeded");
      if (active.status === "succeeded") {
        assert.equal(active.result.kind, "turn-found");
        if (active.result.kind === "turn-found") {
          assert.equal(active.result.status, "active");
          assert.equal(active.result.runtime.state.status, "dispatching");
        }
      }
      const queued = await restarted.execute(harness.context, {
        kind: "get-turn",
        turnId: submitted[1]!.turnId as never,
      });
      assert.equal(queued.status, "succeeded");
      if (
        queued.status === "succeeded" &&
        queued.result.kind === "turn-found"
      ) {
        assert.equal(queued.result.runtime.state.status, "queued");
      }

      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT q.admission_ordinal, t.session_id
            FROM turn_queue_entries q
            JOIN turns t ON t.id = q.turn_id
            WHERE q.principal_id = ?
            ORDER BY q.admission_ordinal`,
            ["owner-v1"],
          ),
        ),
        [
          { admission_ordinal: 1, session_id: secondSessionId },
          { admission_ordinal: 2, session_id: sessionId },
          { admission_ordinal: 3, session_id: secondSessionId },
        ],
      );

      assert.equal(countRows(database, "turns"), 4);
      assert.equal(countRows(database, "agent_dispatch_attempts"), 1);
      assert.equal(countRows(database, "turn_queue_entries"), 3);
      assert.equal(countRows(database, "turn_terminal_responses"), 0);
      assert.equal(countRows(database, "turn_response_deliveries"), 0);
      assert.equal(countRows(database, "turn_messages"), 0);
    } finally {
      database.close();
    }
  });
});

test("walking skeleton finalizes one private image and exposes no source bytes in durable state", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const records = createBootstrapPublicationRecords();
      const created = await harness.application.execute(harness.context, {
        kind: "create-session",
        profileReference: records.agentProfile.reference,
        workspaceReference: records.workspace.reference,
      });
      assert.equal(created.status, "succeeded");
      if (
        created.status !== "succeeded" ||
        created.result.kind !== "session-created"
      ) return;
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const image = harness.imageIntake.seal({
        bytes: png,
        authenticationRequestId: harness.context.actor.requestId,
      });
      const submitted = await harness.application.execute(harness.context, {
        kind: "submit-turn",
        session: {
          kind: "session-id",
          sessionId: created.result.sessionId,
        },
        idempotencyKey: "image-key-1" as never,
        text: "Inspect the image",
        image,
      });
      assert.equal(submitted.status, "succeeded");
      if (submitted.status === "succeeded") {
        await submitted.responseEvents.close();
      }
      assert.equal(countRows(database, "attachments"), 1);
      assert.equal(countRows(database, "private_blobs"), 1);
      const block = database.transaction((transaction) =>
        transaction.get(
          `SELECT kind, text_content, attachment_id
          FROM turn_input_blocks WHERE kind = 'attachment'`,
          [],
        ),
      );
      assert.ok(block !== undefined);
      assert.equal(block.kind, "attachment");
      assert.equal(block.text_content, null);
      assert.equal(typeof block.attachment_id, "string");
    } finally {
      database.close();
    }
  });
});

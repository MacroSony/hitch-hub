import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync } from "node:fs";
import test from "node:test";

import {
  TEST_CLIENT_CERTIFICATE_PEM,
  TEST_SECOND_CLIENT_CERTIFICATE_PEM,
} from "../connectors/remote/test-certificates.js";
import { createRemoteProtocolApplicationDispatch } from "../connectors/remote/application-dispatch.js";
import {
  decodeRemoteProtocolClientFrame,
  type RemoteProtocolCommand,
  type RemoteProtocolCommandOutcome,
} from "../connectors/remote/protocol.js";
import type { AuthenticatedRemoteProtocolExchange } from "../connectors/remote/socket.js";
import type {
  AuthenticatedConnectorContext,
  FirstSliceConnectorApplication,
  LocalAdministrationPort,
} from "../model/application.js";
import type { SessionId } from "../model/primitives.js";
import { createLocalImageIntakeVault } from "../persistence/attachment-store.js";
import { LocalPrivateAttachmentStore } from "../persistence/attachment-store.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import type { V2Database } from "../persistence/database.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { SQLiteLocalAdministration } from "../persistence/local-administration.js";
import { FoundationalAuthorizationIntegrityError } from "../persistence/foundational-authorization.js";
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
import { createMultiUserAuthorizationTrust } from "./authorization-contexts.js";
import {
  SQLiteDevelopmentNoOpCoordinator,
  SQLiteWalkingSkeletonTurnResultQuery,
  WalkingSkeletonConnectorApplication,
} from "./walking-skeleton.js";

const NOW = "2026-08-09T12:00:00.000Z";
const TRUST_ROOT = "private-alpha-client-ca-v1";
const CLIENT_CERTIFICATES = Object.freeze({
  a: new X509Certificate(TEST_CLIENT_CERTIFICATE_PEM).raw,
  b: new X509Certificate(TEST_SECOND_CLIENT_CERTIFICATE_PEM).raw,
});

interface MultiUserHarness {
  readonly database: V2Database;
  readonly administration: LocalAdministrationPort;
  readonly administratorContext: AuthenticatedConnectorContext;
  readonly application: FirstSliceConnectorApplication;
  readonly turnAdmission: SQLiteTurnAdmissionUnitOfWork;
  readonly coordinator: SQLiteDevelopmentNoOpCoordinator;
  readonly authenticateCertificate: (
    certificate: Uint8Array,
  ) => Promise<AuthenticatedConnectorContext>;
}

async function prepare(database: V2Database): Promise<MultiUserHarness> {
  const clock = new DeterministicClock(NOW);
  await new SQLiteBootstrapPublicationUnitOfWork({
    database,
    clock,
    ids: new DeterministicIdSource("bootstrap"),
  }).publishBootstrap(createBootstrapPublicationRecords());
  const trust = createMultiUserAuthorizationTrust({
    database,
    clock,
    ids: new DeterministicIdSource("m03-trust"),
    clientCertificateTrustRootId: TRUST_ROOT,
  });
  const administrator = await trust.localAuthentication.authenticate(
    trust.localConnectionIssuer.issueAcceptedConnection(),
  );
  assert.equal(administrator.status, "authenticated");
  if (administrator.status !== "authenticated") {
    throw new Error("local administrator authentication failed");
  }
  const administration = new SQLiteLocalAdministration({
    database,
    clock,
    ids: new DeterministicIdSource("m03-admin"),
    contextVerifier: trust.contextVerifier,
    clientCertificateTrustRootId: TRUST_ROOT,
  });
  const ids = new DeterministicIdSource("m03-application");
  const cancellation = new SQLiteTurnCancellationUnitOfWork({
    database,
    clock,
    ids,
    contextVerifier: trust.contextVerifier,
  });
  const turnAdmission = new SQLiteTurnAdmissionUnitOfWork({
    database,
    clock,
    ids,
    contextVerifier: trust.contextVerifier,
  });
  const coordinator = new SQLiteDevelopmentNoOpCoordinator({
    database,
    clock,
    ids,
    contextVerifier: trust.contextVerifier,
  });
  const application = new WalkingSkeletonConnectorApplication({
    sessionCreation: new SQLiteSessionCreationUnitOfWork({
      database,
      clock,
      ids,
      contextVerifier: trust.contextVerifier,
    }),
    turnAdmission,
    attachmentStorage: new LocalPrivateAttachmentStore({
      database,
      clock,
      ids,
      intake: createLocalImageIntakeVault(),
    }),
    turnResultQuery: new SQLiteWalkingSkeletonTurnResultQuery({
      database,
      contextVerifier: trust.contextVerifier,
    }),
    queuedCancellation: cancellation,
    activeCancellation: cancellation,
    coordinator,
  });
  return Object.freeze({
    database,
    administration,
    administratorContext: administrator.context,
    application,
    turnAdmission,
    coordinator,
    async authenticateCertificate(certificate: Uint8Array) {
      const verified = trust.remoteCertificateVerifier.verify({
        authorized: true,
        protocol: "TLSv1.3",
        completeDer: certificate,
      });
      assert.equal(verified.status, "verified");
      if (verified.status !== "verified") {
        throw new Error("test client certificate was rejected");
      }
      const authenticated = await trust.remoteAuthentication.authenticate(
        verified.evidence,
      );
      assert.equal(authenticated.status, "authenticated");
      if (authenticated.status !== "authenticated") {
        throw new Error("test remote principal authentication failed");
      }
      return authenticated.context;
    },
  });
}

async function executeRemote(
  application: FirstSliceConnectorApplication,
  context: AuthenticatedConnectorContext,
  command: RemoteProtocolCommand,
): Promise<RemoteProtocolCommandOutcome> {
  const request = decodeRemoteProtocolClientFrame({
    protocol: "hitch.remote",
    version: 1,
    frame: "request",
    requestId: "m03-remote-request",
    command,
  });
  const outcomes: RemoteProtocolCommandOutcome[] = [];
  await createRemoteProtocolApplicationDispatch({ application })(
    Object.freeze({
      context,
      request,
      signal: new AbortController().signal,
      async respond(outcome: RemoteProtocolCommandOutcome) {
        outcomes.push(outcome);
      },
    }) satisfies AuthenticatedRemoteProtocolExchange,
  );
  assert.equal(outcomes.length, 1);
  return outcomes[0]!;
}

async function provisionPrincipal(
  harness: MultiUserHarness,
  input: {
    readonly reference: string;
    readonly displayName: string;
    readonly workspaceReference: string;
    readonly workspaceRoot: string;
    readonly bindingReference: string;
    readonly certificate: Uint8Array;
  },
): Promise<{ readonly principalId: string; readonly context: AuthenticatedConnectorContext }> {
  mkdirSync(input.workspaceRoot, { mode: 0o700 });
  const created = await harness.administration.execute(
    harness.administratorContext,
    {
      kind: "create-principal",
      principalReference: input.reference,
      displayName: input.displayName,
      role: "member",
      workspaceReference: input.workspaceReference,
      canonicalWorkspaceRoot: input.workspaceRoot,
    },
  );
  assert.equal(created.status, "succeeded");
  if (created.status !== "succeeded" || created.result.kind !== "principal-created") {
    throw new Error("test remote principal creation failed");
  }
  const bound = await harness.administration.execute(
    harness.administratorContext,
    {
      kind: "bind-client-certificate",
      principalReference: input.reference,
      bindingReference: input.bindingReference,
      completeDer: input.certificate,
    },
  );
  assert.equal(bound.status, "succeeded");
  if (bound.status !== "succeeded" || bound.result.kind !== "client-certificate-bound") {
    throw new Error("test certificate binding failed");
  }
  assert.equal(bound.result.principalId, created.result.principalId);
  return Object.freeze({
    principalId: created.result.principalId,
    context: await harness.authenticateCertificate(input.certificate),
  });
}

test("[V2-M03/cross-principal-application] two certificate-bound principals cannot cross workspace, session, Turn, result, or cancellation boundaries", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principalA = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const principalB = await provisionPrincipal(harness, {
        reference: "user-b",
        displayName: "User B",
        workspaceReference: "workspace-b",
        workspaceRoot: root.resolve("workspace-b"),
        bindingReference: "user-b-certificate",
        certificate: CLIENT_CERTIFICATES.b,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;

      const crossWorkspace = await harness.application.execute(
        principalA.context,
        {
          kind: "create-session",
          profileReference,
          workspaceReference: "workspace-b",
          displayName: "Cross-owner attempt",
        },
      );
      assert.deepEqual(crossWorkspace, {
        status: "rejected",
        code: "not-found",
      });

      const sessionA = await harness.application.execute(principalA.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
        displayName: "Same private name",
      });
      const sessionB = await harness.application.execute(principalB.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-b",
        displayName: "Same private name",
      });
      assert.equal(sessionA.status, "succeeded");
      assert.equal(sessionB.status, "succeeded");
      if (
        sessionA.status !== "succeeded" ||
        sessionA.result.kind !== "session-created" ||
        sessionB.status !== "succeeded" ||
        sessionB.result.kind !== "session-created"
      ) {
        return;
      }

      const submittedA = await harness.application.execute(principalA.context, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId: sessionA.result.sessionId },
        idempotencyKey: "user-a-turn-1" as never,
        text: "Inspect only workspace A.",
      });
      const submittedB = await harness.application.execute(principalB.context, {
        kind: "submit-turn",
        session: { kind: "session-name", name: "Same private name" },
        idempotencyKey: "user-b-turn-1" as never,
        text: "Inspect only workspace B.",
      });
      assert.equal(submittedA.status, "succeeded");
      assert.equal(submittedB.status, "succeeded");
      if (
        submittedA.status !== "succeeded" ||
        submittedA.result.kind !== "turn-submitted" ||
        submittedB.status !== "succeeded" ||
        submittedB.result.kind !== "turn-submitted"
      ) {
        return;
      }
      assert.equal(submittedA.result.receipt.status, "starting");
      assert.equal(submittedB.result.receipt.status, "starting");
      await submittedA.responseEvents.close();
      await submittedB.responseEvents.close();

      assert.deepEqual(
        await harness.application.execute(principalB.context, {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: sessionA.result.sessionId },
          idempotencyKey: "user-b-cross-turn" as never,
          text: "Attempt another principal's session.",
        }),
        { status: "rejected", code: "not-found" },
      );
      const foreignRead = await harness.application.execute(
        principalB.context,
        {
          kind: "get-turn",
          turnId: submittedA.result.receipt.turnId,
        },
      );
      assert.deepEqual(
        foreignRead,
        await harness.application.execute(principalB.context, {
          kind: "get-turn",
          turnId: "missing:Turn:9999" as never,
        }),
      );
      assert.deepEqual(foreignRead, {
        status: "rejected",
        code: "not-found",
      });
      const foreignCancellation = await harness.application.execute(
        principalB.context,
        {
          kind: "cancel-turn",
          turnId: submittedA.result.receipt.turnId,
        },
      );
      const missingCancellation = await harness.application.execute(
        principalB.context,
        {
          kind: "cancel-turn",
          turnId: "missing:Turn:9999" as never,
        },
      );
      assert.equal(foreignCancellation.status, missingCancellation.status);
      if (
        foreignCancellation.status === "succeeded" &&
        missingCancellation.status === "succeeded"
      ) {
        assert.equal(
          foreignCancellation.result.kind,
          missingCancellation.result.kind,
        );
        assert.equal(
          foreignCancellation.result.kind === "turn-not-cancelled"
            ? foreignCancellation.result.reason
            : undefined,
          missingCancellation.result.kind === "turn-not-cancelled"
            ? missingCancellation.result.reason
            : undefined,
        );
      }
      const ownerRead = await harness.application.execute(principalA.context, {
        kind: "get-turn",
        turnId: submittedA.result.receipt.turnId,
      });
      assert.equal(ownerRead.status, "succeeded");

      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT requester_principal_id, COUNT(*) AS count
            FROM turns GROUP BY requester_principal_id
            ORDER BY requester_principal_id`,
          ),
        ),
        [
          { requester_principal_id: principalA.principalId, count: 1 },
          { requester_principal_id: principalB.principalId, count: 1 },
        ],
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT principal_id, active_turn_id
            FROM principal_execution_capacity
            WHERE principal_id IN (?, ?)
            ORDER BY principal_id`,
            [principalA.principalId, principalB.principalId],
          ),
        ),
        [
          {
            principal_id: principalA.principalId,
            active_turn_id: submittedA.result.receipt.turnId,
          },
          {
            principal_id: principalB.principalId,
            active_turn_id: submittedB.result.receipt.turnId,
          },
        ],
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT action, actor_principal_id, COUNT(*) AS count
            FROM audit_envelopes
            WHERE action IN ('session-created', 'turn-admitted')
            GROUP BY action, actor_principal_id
            ORDER BY action, actor_principal_id`,
          ),
        ),
        [
          {
            action: "session-created",
            actor_principal_id: principalA.principalId,
            count: 1,
          },
          {
            action: "session-created",
            actor_principal_id: principalB.principalId,
            count: 1,
          },
          {
            action: "turn-admitted",
            actor_principal_id: principalA.principalId,
            count: 1,
          },
          {
            action: "turn-admitted",
            actor_principal_id: principalB.principalId,
            count: 1,
          },
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/remote-dispatch-isolation] the bounded remote surface preserves owner opacity and live revocation", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principalA = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const principalB = await provisionPrincipal(harness, {
        reference: "user-b",
        displayName: "User B",
        workspaceReference: "workspace-b",
        workspaceRoot: root.resolve("workspace-b"),
        bindingReference: "user-b-certificate",
        certificate: CLIENT_CERTIFICATES.b,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const createdA = await executeRemote(
        harness.application,
        principalA.context,
        {
          kind: "create-session",
          profileReference,
          workspaceReference: "workspace-a",
          displayName: "Remote A",
        },
      );
      assert.equal(createdA.status, "succeeded");
      if (createdA.status !== "succeeded" || createdA.result.kind !== "session-created") {
        return;
      }
      const submittedA = await executeRemote(
        harness.application,
        principalA.context,
        {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: createdA.result.sessionId },
          idempotencyKey: "remote-a-turn" as never,
          text: "Remote owner A prompt.",
        },
      );
      assert.equal(submittedA.status, "succeeded");
      if (submittedA.status !== "succeeded" || submittedA.result.kind !== "turn-submitted") {
        return;
      }

      assert.deepEqual(
        await executeRemote(harness.application, principalB.context, {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: createdA.result.sessionId },
          idempotencyKey: "remote-b-cross-turn" as never,
          text: "Cross-owner prompt must fail.",
        }),
        { status: "rejected", code: "not-found" },
      );
      assert.deepEqual(
        await executeRemote(harness.application, principalB.context, {
          kind: "get-turn",
          turnId: submittedA.result.turnId,
        }),
        { status: "rejected", code: "not-found" },
      );
      const foreignCancellation = await executeRemote(
        harness.application,
        principalB.context,
        { kind: "cancel-turn", turnId: submittedA.result.turnId },
      );
      const missingCancellation = await executeRemote(
        harness.application,
        principalB.context,
        { kind: "cancel-turn", turnId: "missing:Turn:9999" as never },
      );
      assert.equal(foreignCancellation.status, missingCancellation.status);
      if (
        foreignCancellation.status === "succeeded" &&
        missingCancellation.status === "succeeded"
      ) {
        assert.equal(
          foreignCancellation.result.kind,
          missingCancellation.result.kind,
        );
      }
      const ownerRead = await executeRemote(
        harness.application,
        principalA.context,
        { kind: "get-turn", turnId: submittedA.result.turnId },
      );
      assert.equal(ownerRead.status, "succeeded");

      const queuedA = await executeRemote(
        harness.application,
        principalA.context,
        {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: createdA.result.sessionId },
          idempotencyKey: "remote-a-cancelled-turn" as never,
          text: "Create one terminal result for the owner-only query.",
        },
      );
      assert.equal(queuedA.status, "succeeded");
      if (queuedA.status !== "succeeded" || queuedA.result.kind !== "turn-submitted") {
        return;
      }
      assert.equal(queuedA.result.status, "queued");
      const ownerCancellation = await executeRemote(
        harness.application,
        principalA.context,
        { kind: "cancel-turn", turnId: queuedA.result.turnId },
      );
      assert.equal(ownerCancellation.status, "succeeded");
      const terminalOwnerRead = await executeRemote(
        harness.application,
        principalA.context,
        { kind: "get-turn", turnId: queuedA.result.turnId },
      );
      assert.equal(terminalOwnerRead.status, "succeeded");
      if (
        terminalOwnerRead.status === "succeeded" &&
        terminalOwnerRead.result.kind === "turn-found"
      ) {
        assert.equal(terminalOwnerRead.result.state, "terminal");
        assert.equal(
          terminalOwnerRead.result.terminalResponse?.result.outcome,
          "cancelled",
        );
      }
      assert.deepEqual(
        await executeRemote(harness.application, principalB.context, {
          kind: "get-turn",
          turnId: queuedA.result.turnId,
        }),
        { status: "rejected", code: "not-found" },
      );

      const revoked = await harness.administration.execute(
        harness.administratorContext,
        {
          kind: "revoke-client-certificate",
          bindingReference: "user-a-certificate",
        },
      );
      assert.equal(revoked.status, "succeeded");
      assert.deepEqual(
        await executeRemote(harness.application, principalA.context, {
          kind: "get-turn",
          turnId: submittedA.result.turnId,
        }),
        { status: "rejected", code: "not-authorized" },
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/queued-dispatch-revocation] revoked queued work cannot cross the development dispatch boundary", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principal = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const created = await harness.application.execute(principal.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
      });
      assert.equal(created.status, "succeeded");
      if (created.status !== "succeeded" || created.result.kind !== "session-created") {
        return;
      }
      const admitted = await harness.turnAdmission.admitTurn({
        context: principal.context,
        session: { kind: "session-id", sessionId: created.result.sessionId },
        originMessageId: "queued-before-revocation" as never,
        idempotencyKey: "queued-before-revocation" as never,
        text: "This Turn must remain queued after revocation.",
      });
      assert.equal(admitted.status, "admitted");
      if (admitted.status !== "admitted") return;

      const revoked = await harness.administration.execute(
        harness.administratorContext,
        {
          kind: "revoke-client-certificate",
          bindingReference: "user-a-certificate",
        },
      );
      assert.equal(revoked.status, "succeeded");
      const claim = await harness.coordinator.claimAdmittedHead({
        context: principal.context,
        turnId: admitted.turn.id,
        receipt: admitted.receipt,
      });
      assert.equal(claim.status, "queued");
      assert.deepEqual(
        database.transaction((transaction) => ({
          runtime: transaction.get(
            `SELECT status, attempt_id FROM turn_runtime_states
            WHERE turn_id = ?`,
            [admitted.turn.id],
          ),
          queued: transaction.get(
            `SELECT admission_ordinal FROM turn_queue_entries
            WHERE turn_id = ?`,
            [admitted.turn.id],
          ),
          capacity: transaction.get(
            `SELECT active_turn_id FROM principal_execution_capacity
            WHERE principal_id = ?`,
            [principal.principalId],
          ),
        })),
        {
          runtime: { status: "queued", attempt_id: null },
          queued: { admission_ordinal: 0 },
          capacity: { active_turn_id: null },
        },
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/principal-capacity] each principal owns an independent one-active and three-pending FIFO", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principalA = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const principalB = await provisionPrincipal(harness, {
        reference: "user-b",
        displayName: "User B",
        workspaceReference: "workspace-b",
        workspaceRoot: root.resolve("workspace-b"),
        bindingReference: "user-b-certificate",
        certificate: CLIENT_CERTIFICATES.b,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const createdA = await harness.application.execute(principalA.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
      });
      const createdB = await harness.application.execute(principalB.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-b",
      });
      assert.equal(createdA.status, "succeeded");
      assert.equal(createdB.status, "succeeded");
      if (
        createdA.status !== "succeeded" ||
        createdA.result.kind !== "session-created" ||
        createdB.status !== "succeeded" ||
        createdB.result.kind !== "session-created"
      ) {
        return;
      }

      const turnIds = new Map<string, string[]>();
      turnIds.set(principalA.principalId, []);
      turnIds.set(principalB.principalId, []);
      const capacityEntries: readonly {
        readonly principal: {
          readonly principalId: string;
          readonly context: AuthenticatedConnectorContext;
        };
        readonly sessionId: SessionId;
        readonly label: string;
      }[] = [
        {
          principal: principalA,
          sessionId: createdA.result.sessionId,
          label: "a",
        },
        {
          principal: principalB,
          sessionId: createdB.result.sessionId,
          label: "b",
        },
      ];
      for (let index = 0; index < 4; index += 1) {
        for (const entry of capacityEntries) {
          const submitted = await harness.application.execute(
            entry.principal.context,
            {
              kind: "submit-turn",
              session: { kind: "session-id", sessionId: entry.sessionId },
              idempotencyKey: `shared-retry-key-${index}` as never,
              text: `Principal ${entry.label} prompt ${index}`,
            },
          );
          assert.equal(submitted.status, "succeeded");
          if (
            submitted.status !== "succeeded" ||
            submitted.result.kind !== "turn-submitted"
          ) {
            return;
          }
          assert.equal(
            submitted.result.receipt.status,
            index === 0 ? "starting" : "queued",
          );
          turnIds.get(entry.principal.principalId)!.push(
            submitted.result.receipt.turnId,
          );
          await submitted.responseEvents.close();
        }
      }

      for (const entry of [
        { principal: principalA, sessionId: createdA.result.sessionId },
        { principal: principalB, sessionId: createdB.result.sessionId },
      ] as const) {
        assert.deepEqual(
          await harness.application.execute(entry.principal.context, {
            kind: "submit-turn",
            session: { kind: "session-id", sessionId: entry.sessionId },
            idempotencyKey: "capacity-rejected" as never,
            text: "This exceeds only my own pending capacity.",
          }),
          { status: "rejected", code: "queue-capacity-exceeded" },
        );
      }

      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT principal_id, next_admission_ordinal, active_turn_id,
              (SELECT COUNT(*) FROM turn_queue_entries AS queue
                WHERE queue.principal_id = capacity.principal_id) AS pending
            FROM principal_execution_capacity AS capacity
            WHERE principal_id IN (?, ?)
            ORDER BY principal_id`,
            [principalA.principalId, principalB.principalId],
          ),
        ),
        [principalA, principalB].map((principal) => ({
          principal_id: principal.principalId,
          next_admission_ordinal: 4,
          active_turn_id: turnIds.get(principal.principalId)![0],
          pending: 3,
        })),
      );
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT principal_id, admission_ordinal
            FROM turn_queue_entries
            WHERE principal_id IN (?, ?)
            ORDER BY principal_id, admission_ordinal`,
            [principalA.principalId, principalB.principalId],
          ),
        ),
        [principalA, principalB].flatMap((principal) =>
          [1, 2, 3].map((ordinal) => ({
            principal_id: principal.principalId,
            admission_ordinal: ordinal,
          })),
        ),
      );

      const cancelledA = await harness.application.execute(principalA.context, {
        kind: "cancel-turn",
        turnId: turnIds.get(principalA.principalId)![1] as never,
      });
      assert.equal(cancelledA.status, "succeeded");
      const replacementA = await harness.application.execute(
        principalA.context,
        {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: createdA.result.sessionId },
          idempotencyKey: "capacity-replacement" as never,
          text: "Replace only principal A's cancelled queue entry.",
        },
      );
      assert.equal(replacementA.status, "succeeded");
      if (
        replacementA.status !== "succeeded" ||
        replacementA.result.kind !== "turn-submitted"
      ) {
        return;
      }
      assert.equal(replacementA.result.receipt.status, "queued");
      await replacementA.responseEvents.close();
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.all(
            `SELECT principal_id, admission_ordinal
            FROM turn_queue_entries
            WHERE principal_id IN (?, ?)
            ORDER BY principal_id, admission_ordinal`,
            [principalA.principalId, principalB.principalId],
          ),
        ),
        [
          ...[2, 3, 4].map((ordinal) => ({
            principal_id: principalA.principalId,
            admission_ordinal: ordinal,
          })),
          ...[1, 2, 3].map((ordinal) => ({
            principal_id: principalB.principalId,
            admission_ordinal: ordinal,
          })),
        ],
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/turn-configuration-reauthorization] every new Turn rechecks pinned grants, credential state, and the fixed workspace binding", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principal = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const created = await harness.application.execute(principal.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
      });
      assert.equal(created.status, "succeeded");
      if (created.status !== "succeeded" || created.result.kind !== "session-created") {
        return;
      }
      const submit = (key: string) =>
        harness.application.execute(principal.context, {
          kind: "submit-turn" as const,
          session: {
            kind: "session-id" as const,
            sessionId: created.result.sessionId,
          },
          idempotencyKey: key as never,
          text: `Authorization check ${key}`,
        });

      database.transaction((transaction) => {
        const revoked = transaction.run(
          `UPDATE access_grants
          SET state = 'revoked', revoked_at = ?,
            revoked_actor_kind = 'principal',
            revoked_actor_principal_id = 'owner-v1'
          WHERE principal_id = ?
            AND kind = 'session-configuration-use'
            AND resource_kind = 'agent-profile'`,
          [NOW, principal.principalId],
        );
        assert.equal(revoked.changes, 1);
      });
      assert.deepEqual(await submit("revoked-profile-grant"), {
        status: "rejected",
        code: "not-authorized",
      });

      database.transaction((transaction) => {
        const restored = transaction.run(
          `UPDATE access_grants
          SET state = 'active', revoked_at = NULL,
            revoked_actor_kind = NULL, revoked_actor_principal_id = NULL
          WHERE principal_id = ?
            AND kind = 'session-configuration-use'
            AND resource_kind = 'agent-profile'`,
          [principal.principalId],
        );
        assert.equal(restored.changes, 1);
        const revokedCredential = transaction.run(
          `UPDATE provider_credential_bindings
          SET state = 'revoked', revoked_at = ?,
            revoked_actor_kind = 'principal',
            revoked_actor_principal_id = 'owner-v1', updated_at = ?`,
          [NOW, NOW],
        );
        assert.equal(revokedCredential.changes, 1);
      });
      assert.deepEqual(await submit("revoked-credential"), {
        status: "rejected",
        code: "not-authorized",
      });

      database.transaction((transaction) => {
        const restoredCredential = transaction.run(
          `UPDATE provider_credential_bindings
          SET state = 'active', revoked_at = NULL,
            revoked_actor_kind = NULL, revoked_actor_principal_id = NULL,
            updated_at = ?`,
          [NOW],
        );
        assert.equal(restoredCredential.changes, 1);
        const removedBinding = transaction.run(
          `DELETE FROM principal_workspace_bindings WHERE principal_id = ?`,
          [principal.principalId],
        );
        assert.equal(removedBinding.changes, 1);
      });
      await assert.rejects(
        submit("missing-workspace-binding"),
        FoundationalAuthorizationIntegrityError,
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(`SELECT COUNT(*) AS count FROM turns`)?.count,
        ),
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/certificate-replacement] a new same-owner certificate can prompt, read, and cancel an existing private session", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const original = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate-v1",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const created = await harness.application.execute(original.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
      });
      assert.equal(created.status, "succeeded");
      if (created.status !== "succeeded" || created.result.kind !== "session-created") {
        return;
      }
      const first = await harness.application.execute(original.context, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId: created.result.sessionId },
        idempotencyKey: "certificate-v1-turn" as never,
        text: "Turn from the original certificate.",
      });
      assert.equal(first.status, "succeeded");
      if (first.status !== "succeeded" || first.result.kind !== "turn-submitted") {
        return;
      }
      await first.responseEvents.close();

      const replacementBinding = await harness.administration.execute(
        harness.administratorContext,
        {
          kind: "bind-client-certificate",
          principalReference: "user-a",
          bindingReference: "user-a-certificate-v2",
          completeDer: CLIENT_CERTIFICATES.b,
        },
      );
      assert.equal(replacementBinding.status, "succeeded");
      const replacementContext = await harness.authenticateCertificate(
        CLIENT_CERTIFICATES.b,
      );
      assert.equal(
        replacementContext.actor.principalId,
        original.principalId,
      );

      const second = await harness.application.execute(replacementContext, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId: created.result.sessionId },
        idempotencyKey: "certificate-v2-turn" as never,
        text: "Turn from the replacement certificate.",
      });
      assert.equal(second.status, "succeeded");
      if (second.status !== "succeeded" || second.result.kind !== "turn-submitted") {
        return;
      }
      assert.equal(second.result.receipt.status, "queued");
      await second.responseEvents.close();
      const replacementRead = await harness.application.execute(
        replacementContext,
        { kind: "get-turn", turnId: first.result.receipt.turnId },
      );
      assert.equal(replacementRead.status, "succeeded");

      const bindingRows = database.transaction((transaction) =>
        transaction.all(
          `SELECT bindings.id, bindings.endpoint_id
          FROM session_endpoint_bindings AS bindings
          WHERE bindings.session_id = ?
            AND bindings.created_by_principal_id = ?
          ORDER BY bindings.id`,
          [created.result.sessionId, original.principalId],
        ),
      );
      assert.equal(bindingRows.length, 2);
      assert.equal(new Set(bindingRows.map((row) => row.endpoint_id)).size, 2);
      assert.deepEqual(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT turns.endpoint_binding_id AS turn_binding_id,
              audit.endpoint_binding_id AS audit_binding_id
            FROM turns
            JOIN audit_envelopes AS audit
              ON audit.turn_id = turns.id AND audit.action = 'turn-admitted'
            WHERE turns.id = ?`,
            [second.result.receipt.turnId],
          ),
        ),
        {
          turn_binding_id: bindingRows.find(
            (row) => row.endpoint_id === replacementContext.endpointId,
          )?.id,
          audit_binding_id: bindingRows.find(
            (row) => row.endpoint_id === replacementContext.endpointId,
          )?.id,
        },
      );

      const revokedOld = await harness.administration.execute(
        harness.administratorContext,
        {
          kind: "revoke-client-certificate",
          bindingReference: "user-a-certificate-v1",
        },
      );
      assert.equal(revokedOld.status, "succeeded");
      assert.deepEqual(
        await harness.application.execute(original.context, {
          kind: "get-turn",
          turnId: second.result.receipt.turnId,
        }),
        { status: "rejected", code: "not-authorized" },
      );
      const cancelled = await harness.application.execute(replacementContext, {
        kind: "cancel-turn",
        turnId: second.result.receipt.turnId,
      });
      assert.equal(cancelled.status, "succeeded");
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/live-application-revocation] minted contexts immediately lose create, submit, read, and cancellation authority", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principalA = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const session = await harness.application.execute(principalA.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
      });
      assert.equal(session.status, "succeeded");
      if (session.status !== "succeeded" || session.result.kind !== "session-created") {
        return;
      }
      const turn = await harness.application.execute(principalA.context, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId: session.result.sessionId },
        idempotencyKey: "user-a-turn" as never,
        text: "Keep this Turn active.",
      });
      assert.equal(turn.status, "succeeded");
      if (turn.status !== "succeeded" || turn.result.kind !== "turn-submitted") {
        return;
      }
      await turn.responseEvents.close();

      const disabled = await harness.administration.execute(
        harness.administratorContext,
        { kind: "disable-principal", principalReference: "user-a" },
      );
      assert.equal(disabled.status, "succeeded");
      assert.deepEqual(
        await harness.application.execute(principalA.context, {
          kind: "create-session",
          profileReference,
          workspaceReference: "workspace-a",
        }),
        { status: "rejected", code: "not-authorized" },
      );
      assert.deepEqual(
        await harness.application.execute(principalA.context, {
          kind: "submit-turn",
          session: { kind: "session-id", sessionId: session.result.sessionId },
          idempotencyKey: "user-a-turn-after-disable" as never,
          text: "This must be rejected.",
        }),
        { status: "rejected", code: "not-authorized" },
      );
      assert.deepEqual(
        await harness.application.execute(principalA.context, {
          kind: "get-turn",
          turnId: turn.result.receipt.turnId,
        }),
        { status: "rejected", code: "not-authorized" },
      );
      assert.deepEqual(
        await harness.application.execute(principalA.context, {
          kind: "cancel-turn",
          turnId: turn.result.receipt.turnId,
        }),
        { status: "rejected", code: "not-authorized" },
      );
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT status FROM turn_runtime_states WHERE turn_id = ?`,
            [turn.result.receipt.turnId],
          )?.status,
        ),
        "dispatching",
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/live-certificate-revocation] a revoked minted context cannot distinguish owned, foreign, or missing Turn identifiers", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principal = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;
      const session = await harness.application.execute(principal.context, {
        kind: "create-session",
        profileReference,
        workspaceReference: "workspace-a",
      });
      assert.equal(session.status, "succeeded");
      if (session.status !== "succeeded" || session.result.kind !== "session-created") {
        return;
      }
      const turn = await harness.application.execute(principal.context, {
        kind: "submit-turn",
        session: { kind: "session-id", sessionId: session.result.sessionId },
        idempotencyKey: "user-a-turn" as never,
        text: "Keep this Turn active.",
      });
      assert.equal(turn.status, "succeeded");
      if (turn.status !== "succeeded" || turn.result.kind !== "turn-submitted") {
        return;
      }
      await turn.responseEvents.close();

      const revoked = await harness.administration.execute(
        harness.administratorContext,
        {
          kind: "revoke-client-certificate",
          bindingReference: "user-a-certificate",
        },
      );
      assert.equal(revoked.status, "succeeded");

      const existingRead = await harness.application.execute(principal.context, {
        kind: "get-turn",
        turnId: turn.result.receipt.turnId,
      });
      const missingRead = await harness.application.execute(principal.context, {
        kind: "get-turn",
        turnId: "missing:Turn:9999" as never,
      });
      assert.deepEqual(existingRead, missingRead);
      assert.deepEqual(existingRead, {
        status: "rejected",
        code: "not-authorized",
      });

      const existingCancellation = await harness.application.execute(
        principal.context,
        { kind: "cancel-turn", turnId: turn.result.receipt.turnId },
      );
      const missingCancellation = await harness.application.execute(
        principal.context,
        { kind: "cancel-turn", turnId: "missing:Turn:9999" as never },
      );
      assert.deepEqual(existingCancellation, missingCancellation);
      assert.deepEqual(existingCancellation, {
        status: "rejected",
        code: "not-authorized",
      });
      assert.equal(
        database.transaction((transaction) =>
          transaction.get(
            `SELECT status FROM turn_runtime_states WHERE turn_id = ?`,
            [turn.result.receipt.turnId],
          )?.status,
        ),
        "dispatching",
      );
    } finally {
      database.close();
    }
  });
});

test("[V2-M03/principal-provisioning-provenance] replayed creation metadata cannot authorize replaced grants or mutated workspace rows", async () => {
  await withDisposableDataRoot(async (root) => {
    const database = openCanonicalHitchV2Database({
      dataRoot: root.resolve("state"),
    });
    try {
      const harness = await prepare(database);
      const principalA = await provisionPrincipal(harness, {
        reference: "user-a",
        displayName: "User A",
        workspaceReference: "workspace-a",
        workspaceRoot: root.resolve("workspace-a"),
        bindingReference: "user-a-certificate",
        certificate: CLIENT_CERTIFICATES.a,
      });
      const principalB = await provisionPrincipal(harness, {
        reference: "user-b",
        displayName: "User B",
        workspaceReference: "workspace-b",
        workspaceRoot: root.resolve("workspace-b"),
        bindingReference: "user-b-certificate",
        certificate: CLIENT_CERTIFICATES.b,
      });
      const profileReference = createBootstrapPublicationRecords().agentProfile.reference;

      database.transaction((transaction) => {
        const replaced = transaction.run(
          `UPDATE access_grants
          SET id = 'forged:AccessGrant:0001'
          WHERE principal_id = ?
            AND kind = 'session-configuration-use'
            AND resource_kind = 'agent-profile'`,
          [principalA.principalId],
        );
        assert.equal(replaced.changes, 1);
      });
      await assert.rejects(
        harness.application.execute(principalA.context, {
          kind: "create-session",
          profileReference,
          workspaceReference: "workspace-a",
        }),
        FoundationalAuthorizationIntegrityError,
      );

      database.transaction((transaction) => {
        const mutated = transaction.run(
          `UPDATE workspaces SET display_name = 'replayed workspace'
          WHERE id = (
            SELECT workspace_id FROM principal_workspace_bindings
            WHERE principal_id = ?
          )`,
          [principalB.principalId],
        );
        assert.equal(mutated.changes, 1);
      });
      await assert.rejects(
        harness.application.execute(principalB.context, {
          kind: "create-session",
          profileReference,
          workspaceReference: "workspace-b",
        }),
        FoundationalAuthorizationIntegrityError,
      );
    } finally {
      database.close();
    }
  });
});

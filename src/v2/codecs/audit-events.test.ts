import assert from "node:assert/strict";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import {
  AUDIT_ACTIONS,
  CodecDecodeError,
  decodeAuditEvent,
  decodeAuditEnvelope,
  encodeCanonicalAuditEvent,
  encodeCanonicalAuditEnvelope,
} from "./index.js";

function assertIssue(
  input: unknown,
  code: CodecDecodeError["issues"][number]["code"],
  path: readonly (string | number)[],
): void {
  assert.throws(() => decodeAuditEvent(input), (error: unknown) => {
    assert.ok(error instanceof CodecDecodeError);
    assert.equal(error.issues[0]?.code, code);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  });
}

test("audit actions are a closed exhaustive allowlist", () => {
  assert.equal(AUDIT_ACTIONS.length, 36);
  assert.deepEqual(decodeAuditEvent({ action: "installation-published" }), {
    action: "installation-published",
  });
  assert.deepEqual(
    decodeAuditEvent({
      action: "inference-send-completed",
      sessionId: "audit:Session:0001",
      turnId: "audit:Turn:0001",
      workerLeaseId: "audit:WorkerLease:0001",
      credentialLeaseId: "audit:CredentialLease:0001",
      reservationId: "audit:InferenceRequestReservation:0001",
      forwardingAttemptId: "audit:InferenceForwardingAttempt:0001",
    }),
    {
      action: "inference-send-completed",
      sessionId: "audit:Session:0001",
      turnId: "audit:Turn:0001",
      workerLeaseId: "audit:WorkerLease:0001",
      credentialLeaseId: "audit:CredentialLease:0001",
      reservationId: "audit:InferenceRequestReservation:0001",
      forwardingAttemptId: "audit:InferenceForwardingAttempt:0001",
    },
  );
  assertIssue(
    { action: "future-action" },
    "unsupported-discriminant",
    ["action"],
  );
});

test("audit encoder is deterministic and revalidates typed input", () => {
  const encoded = encodeCanonicalAuditEvent({
    action: "turn-dispatched",
    sessionId: "audit:Session:0001" as never,
    turnId: "audit:Turn:0001" as never,
    attemptId: "audit:AgentDispatchAttempt:0001" as never,
  });
  assert.equal(
    encoded,
    '{"action":"turn-dispatched","attemptId":"audit:AgentDispatchAttempt:0001","sessionId":"audit:Session:0001","turnId":"audit:Turn:0001"}',
  );
});

test("full audit envelopes decode exactly and retain only closed actor metadata", () => {
  const envelope = decodeAuditEnvelope({
    id: "audit:AuditEnvelope:0001",
    installationId: "audit:Installation:0001",
    actor: { kind: "system", component: "turn-coordinator" },
    outcome: "succeeded",
    occurredAt: "2026-07-25T14:01:02.003Z",
    action: "turn-dispatched",
    sessionId: "audit:Session:0001",
    turnId: "audit:Turn:0001",
    attemptId: "audit:AgentDispatchAttempt:0001",
  });
  assert.deepEqual(envelope.actor, { kind: "system", component: "turn-coordinator" });
  assert.equal(
    encodeCanonicalAuditEnvelope(envelope),
    '{"action":"turn-dispatched","actor":{"component":"turn-coordinator","kind":"system"},"attemptId":"audit:AgentDispatchAttempt:0001","id":"audit:AuditEnvelope:0001","installationId":"audit:Installation:0001","occurredAt":"2026-07-25T14:01:02.003Z","outcome":"succeeded","sessionId":"audit:Session:0001","turnId":"audit:Turn:0001"}',
  );
  for (const [actor, path] of [
    [{ kind: "principal", principalId: "audit:Principal:0001" }, ["actor", "principalId"]],
    [{ kind: "bootstrap" }, ["actor", "kind"]],
  ] as const) {
    assert.equal(
      decodeAuditEnvelope({
        ...envelope,
        actor,
      }).actor.kind,
      actor.kind,
      `actor at ${path.join(".")}`,
    );
  }
  assert.throws(
    () => decodeAuditEnvelope({ ...envelope, authorization: "Bearer secret" }),
    (error: unknown) => {
      assert.ok(error instanceof CodecDecodeError);
      assert.equal(error.issues[0]?.code, "unknown-field");
      assert.deepEqual(error.issues[0]?.path, ["authorization"]);
      return true;
    },
  );
  assert.throws(
    () => decodeAuditEnvelope({ ...envelope, actor: { kind: "system", component: "future" } }),
    CodecDecodeError,
  );
});

scenarioCase({
  scenarioId: "V2-S19",
  caseId: "audit-codec-content-free-allowlist",
  title: "audit events contain only action-specific correlation identifiers",
  run: () => {
    const valid = decodeAuditEvent({
      action: "interaction-response-dispatch-recorded",
      sessionId: "audit:Session:0001",
      turnId: "audit:Turn:0001",
      interactionId: "audit:TurnInteraction:0001",
      interactionResponseId: "audit:TurnInteractionResponse:0001",
    });
    assert.equal(valid.action, "interaction-response-dispatch-recorded");

    for (const forbidden of [
      { prompt: "private prompt" },
      { authorization: "Bearer abc" },
      { rawReasoning: "chain of thought" },
      { rawToolOutput: { password: "value" } },
      { canonicalHostPath: "/home/user/project" },
      { outcome: "succeeded" },
    ]) {
      assertIssue(
        {
          action: "turn-admitted",
          sessionId: "audit:Session:0001",
          turnId: "audit:Turn:0001",
          ...forbidden,
        },
        "unknown-field",
        [Object.keys(forbidden)[0]!],
      );
    }
  },
});

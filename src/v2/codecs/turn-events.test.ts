import assert from "node:assert/strict";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import type { AgentDriverTurnEventPayload } from "../model/agent-runtime.js";
import type { TurnEventPayload } from "../model/turn.js";
import {
  CodecDecodeError,
  DRIVER_TURN_EVENT_KINDS,
  TURN_EVENT_PAYLOAD_KINDS,
  decodeDriverTurnEvent,
  decodeDriverTurnEventPayload,
  decodeTurnEvent,
  decodeTurnEventPayload,
  encodeCanonicalTurnEvent,
} from "./index.js";

const NOW = "2026-07-25T14:01:02.003Z";

const payloadFixtures = {
  "agent-message-chunk": {
    kind: "agent-message-chunk",
    messageId: "event:TurnMessage:0001",
    protocolMessageId: "native-message-1",
    content: { kind: "text", text: "A protected response" },
  },
  "agent-progress-chunk": {
    kind: "agent-progress-chunk",
    content: { kind: "text", text: "Working" },
  },
  plan: {
    kind: "plan",
    entries: [{ content: "Inspect", status: "in-progress", priority: "high" }],
  },
  "tool-invocation-update": {
    kind: "tool-invocation-update",
    toolInvocationId: "event:ToolInvocation:0001",
    protocolToolCallId: "native-tool-1",
    title: "Read a file",
    status: "in-progress",
    sanitizedSummary: "Reading authorized workspace content",
  },
  "usage-update": {
    kind: "usage-update",
    usage: {
      scope: "turn",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cost: { amount: 0.001, currency: "USD" },
    },
  },
  "state-transition": {
    kind: "state-transition",
    from: { status: "queued" },
    to: {
      status: "dispatching",
      attemptId: "event:AgentDispatchAttempt:0001",
      attempt: 1,
      startedAt: NOW,
    },
  },
  "prompt-accepted": {
    kind: "prompt-accepted",
    evidence: {
      kind: "attributable-turn-event",
      eventKind: "agent-message",
      correlation: "driver-guaranteed",
    },
  },
  "inference-resolved": {
    kind: "inference-resolved",
    resolution: {
      turnId: "event:Turn:0001",
      model: {
        providerId: "event:Provider:0001",
        modelId: "event:Model:0001",
      },
      reasoning: { kind: "effort", effort: "high" },
      resolvedBy: "agent",
      resolvedAt: NOW,
    },
  },
  "user-message-recorded": {
    kind: "user-message-recorded",
    protocolMessageId: "native-user-message-1",
  },
  "agent-message-finalized": {
    kind: "agent-message-finalized",
    messageId: "event:TurnMessage:0001",
    content: [
      { kind: "text", text: "Final response" },
      {
        kind: "attachment",
        attachmentId: "event:Attachment:0001",
        mediaType: "image",
        mimeType: "image/png",
        displayName: "result.png",
      },
    ],
  },
  "tool-invocation-finalized": {
    kind: "tool-invocation-finalized",
    toolInvocationId: "event:ToolInvocation:0001",
    protocolToolCallId: "native-tool-1",
    title: "Read a file",
    status: "completed",
    sanitizedSummary: "Read completed",
  },
  "interaction-requested": {
    kind: "interaction-requested",
    interactionId: "event:TurnInteraction:0001",
    request: {
      kind: "input",
      sanitizedPrompt: "Choose a target",
      responseSchema: {
        type: "object",
        properties: { target: { type: "string" } },
      },
    },
  },
  "interaction-resolved": {
    kind: "interaction-resolved",
    interactionId: "event:TurnInteraction:0001",
    interactionKind: "input",
    resolution: { kind: "input-timed-out", agentOutcome: "no-input" },
  },
  "usage-finalized": {
    kind: "usage-finalized",
    usage: { scope: "turn", totalTokens: 14 },
  },
  terminal: {
    kind: "terminal",
    result: { outcome: "completed" },
    partialOutputAvailable: false,
  },
} satisfies Record<TurnEventPayload["kind"], unknown>;

const driverPayloadFixtures = {
  "user-message-recorded": {
    kind: "user-message-recorded",
    protocolMessageId: "native-user-message-1",
  },
  "agent-message-chunk": {
    kind: "agent-message-chunk",
    protocolMessageId: "native-message-1",
    text: "A protected response chunk",
  },
  "agent-progress-chunk": {
    kind: "agent-progress-chunk",
    text: "Working",
  },
  plan: payloadFixtures.plan,
  "tool-invocation-update": {
    kind: "tool-invocation-update",
    protocolToolCallId: "native-tool-1",
    title: "Read a file",
    status: "in-progress",
    sanitizedSummary: "Reading authorized workspace content",
  },
  "agent-message-finalized": {
    kind: "agent-message-finalized",
    protocolMessageId: "native-message-1",
    text: "Final response",
  },
  "tool-invocation-finalized": {
    kind: "tool-invocation-finalized",
    protocolToolCallId: "native-tool-1",
    title: "Read a file",
    status: "completed",
    sanitizedSummary: "Read completed",
  },
  "interaction-requested": {
    kind: "interaction-requested",
    protocolInteractionId: "native-interaction-1",
    request: {
      kind: "input",
      sanitizedPrompt: "Choose a target",
      responseSchema: { type: "string" },
    },
  },
  terminal: {
    kind: "terminal",
    terminal: { outcome: "completed" },
    partialOutputAvailable: false,
  },
} satisfies Record<AgentDriverTurnEventPayload["kind"], unknown>;

function assertIssue(
  operation: () => unknown,
  code: CodecDecodeError["issues"][number]["code"],
  path: readonly (string | number)[],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CodecDecodeError);
    assert.equal(error.issues[0]?.code, code);
    assert.deepEqual(error.issues[0]?.path, path);
    return true;
  });
}

test("all current Turn event payload variants decode through an exhaustive table", () => {
  assert.deepEqual(
    [...TURN_EVENT_PAYLOAD_KINDS].sort(),
    Object.keys(payloadFixtures).sort(),
  );
  for (const [kind, fixture] of Object.entries(payloadFixtures)) {
    assert.equal(decodeTurnEventPayload(fixture).kind, kind);
  }
});

test("remote mTLS actors decode at persisted Turn event boundaries", () => {
  const cancellation = decodeTurnEventPayload({
    kind: "state-transition",
    from: { status: "queued" },
    to: {
      status: "cancelling",
      attemptId: "event:AgentDispatchAttempt:0001",
      requestedAt: NOW,
      requestedBy: { kind: "system", component: "remote-ingress" },
      reason: "withdrawn-by-requester",
    },
  });
  assert.equal(cancellation.kind, "state-transition");

  const resolution = decodeTurnEventPayload({
    kind: "interaction-resolved",
    interactionId: "event:TurnInteraction:0001",
    interactionKind: "input",
    resolution: {
      kind: "input-by-originator",
      resolver: {
        actor: {
          kind: "authenticated-principal",
          principalId: "event:Principal:0001",
          identityBindingId: "event:IdentityBinding:0001",
          method: "mtls-client",
          assurance: "normal",
          requestId: "event:AuthenticationRequest:0001",
          authenticatedAt: NOW,
        },
        authorization: {
          basis: "turn-requester",
          decision: "allowed",
          reason: "turn-requester",
          evaluatedAt: NOW,
        },
      },
      responseId: "event:TurnInteractionResponse:0001",
    },
  });
  assert.equal(resolution.kind, "interaction-resolved");
});

test("persisted Turn event codec validates its exact envelope and canonical encoding", () => {
  const event = decodeTurnEvent({
    id: "event:TurnEvent:0001",
    turnId: "event:Turn:0001",
    sequence: 1,
    visibility: "requester",
    occurredAt: NOW,
    payload: payloadFixtures.terminal,
  });
  assert.equal(event.payload.kind, "terminal");
  assert.equal(
    encodeCanonicalTurnEvent(event),
    `{"id":"event:TurnEvent:0001","occurredAt":"${NOW}","payload":{"kind":"terminal","partialOutputAvailable":false,"result":{"outcome":"completed"}},"sequence":1,"turnId":"event:Turn:0001","visibility":"requester"}`,
  );
  assertIssue(
    () =>
      decodeTurnEvent({
        id: "event:TurnEvent:0001",
        turnId: "event:Turn:0001",
        sequence: 1,
        visibility: "requester",
        occurredAt: NOW,
        payload: payloadFixtures.terminal,
        durability: "durable",
      }),
    "unknown-field",
    ["durability"],
  );
});

test("approval event structures preserve only one-operation selectable options", () => {
  const request = decodeTurnEventPayload({
    kind: "interaction-requested",
    interactionId: "event:TurnInteraction:0002",
    request: {
      kind: "approval",
      toolInvocationId: "event:ToolInvocation:0002",
      title: "Run formatter",
      advertisedAgentOptions: [
        {
          protocolOptionId: "allow",
          protocolKind: "once",
          sanitizedLabel: "Allow once",
          advertisedDisposition: "allow-once",
        },
        {
          protocolOptionId: "always",
          protocolKind: "always",
          sanitizedLabel: "Always allow",
          advertisedDisposition: "allow-persistent",
        },
      ],
      options: [
        {
          id: "event:TurnInteractionOption:0001",
          sanitizedLabel: "Allow once",
          normalizedDecision: "allow-once",
          agentResponse: {
            kind: "select-advertised-option",
            option: {
              protocolOptionId: "allow",
              protocolKind: "once",
              sanitizedLabel: "Allow once",
              advertisedDisposition: "allow-once",
            },
          },
        },
      ],
    },
  });
  assert.equal(request.kind, "interaction-requested");

  assertIssue(
    () =>
      decodeTurnEventPayload({
        kind: "interaction-requested",
        interactionId: "event:TurnInteraction:0002",
        request: {
          kind: "approval",
          toolInvocationId: "event:ToolInvocation:0002",
          title: "Run formatter",
          advertisedAgentOptions: [],
          options: [
            {
              id: "event:TurnInteractionOption:0001",
              sanitizedLabel: "Always",
              normalizedDecision: "allow-once",
              agentResponse: {
                kind: "select-advertised-option",
                option: {
                  protocolOptionId: "always",
                  protocolKind: "always",
                  sanitizedLabel: "Always",
                  advertisedDisposition: "allow-persistent",
                },
              },
            },
          ],
        },
      }),
    "invalid-format",
    ["request", "options", 0, "agentResponse", "option", "advertisedDisposition"],
  );

  const advertisedPersistent = {
    protocolOptionId: "always",
    protocolKind: "always",
    sanitizedLabel: "Always allow",
    advertisedDisposition: "allow-persistent",
  };
  for (const selected of [
    {
      protocolOptionId: "missing",
      protocolKind: "once",
      sanitizedLabel: "Allow once",
      advertisedDisposition: "allow-once",
    },
    {
      ...advertisedPersistent,
      sanitizedLabel: "Allow once",
      advertisedDisposition: "allow-once",
    },
  ]) {
    assertIssue(
      () =>
        decodeTurnEventPayload({
          kind: "interaction-requested",
          interactionId: "event:TurnInteraction:0002",
          request: {
            kind: "approval",
            toolInvocationId: "event:ToolInvocation:0002",
            title: "Run formatter",
            advertisedAgentOptions: [advertisedPersistent],
            options: [
              {
                id: "event:TurnInteractionOption:0001",
                sanitizedLabel: "Allow once",
                normalizedDecision: "allow-once",
                agentResponse: {
                  kind: "select-advertised-option",
                  option: selected,
                },
              },
            ],
          },
        }),
      "invalid-format",
      ["request", "options", 0, "agentResponse", "option"],
    );
  }
});

test("workspace links use normalized sandbox paths rather than generic strings", () => {
  const payload = {
    kind: "agent-message-finalized",
    messageId: "event:TurnMessage:0001",
    content: [
      {
        kind: "workspace-resource-link",
        resourceId: "event:WorkspaceResource:0001",
        sandboxPath: "/workspace/project/readme.md",
      },
    ],
  };
  assert.equal(decodeTurnEventPayload(payload).kind, "agent-message-finalized");
  assertIssue(
    () =>
      decodeTurnEventPayload({
        ...payload,
        content: [{ ...payload.content[0], sandboxPath: "/workspace/../secret" }],
      }),
    "invalid-format",
    ["content", 0, "sandboxPath"],
  );
  assertIssue(
    () =>
      decodeTurnEventPayload({
        ...payload,
        content: [{ ...payload.content[0], mimeType: "text/plain; charset=utf-8" }],
      }),
    "invalid-format",
    ["content", 0, "mimeType"],
  );
});

test("first-slice attachment blocks are image-only and never carry source paths", () => {
  const content = {
    kind: "attachment",
    attachmentId: "event:Attachment:0001",
    mediaType: "image",
    mimeType: "image/png",
    displayName: "result.png",
  };
  assert.equal(
    decodeTurnEventPayload({
      kind: "agent-message-finalized",
      messageId: "event:TurnMessage:0001",
      content: [content],
    }).kind,
    "agent-message-finalized",
  );
  for (const invalidContent of [
    { ...content, mediaType: "audio", mimeType: "audio/mpeg" },
    { ...content, mimeType: "image/svg+xml" },
    { ...content, displayName: "/home/user/result.png" },
    { ...content, displayName: "C:\\Users\\user\\result.png" },
  ]) {
    assert.throws(
      () =>
        decodeTurnEventPayload({
          kind: "agent-message-finalized",
          messageId: "event:TurnMessage:0001",
          content: [invalidContent],
        }),
      CodecDecodeError,
    );
  }
});

test("operational driver metadata rejects secret, host-path, and schema leakage", () => {
  for (const payload of [
    {
      ...driverPayloadFixtures["agent-message-chunk"],
      protocolMessageId: "sk-abcdefghijklmnop1234",
    },
    {
      ...driverPayloadFixtures["tool-invocation-update"],
      title: "Read /home/user/.ssh/id_rsa",
    },
    {
      ...driverPayloadFixtures["interaction-requested"],
      request: {
        kind: "input",
        sanitizedPrompt: "Choose a target",
        responseSchema: {
          type: "object",
          properties: { password: { type: "string" } },
        },
      },
    },
  ]) {
    assert.throws(
      () => decodeDriverTurnEventPayload(payload),
      CodecDecodeError,
    );
  }
  for (const sanitizedSummary of [
    "cwd:/home/user/project",
    "cwd:C:\\Users\\user",
    "see;/etc/shadow",
    "//server/share",
    "\\Windows\\System32",
    "uri:file:///etc/shadow",
    "Bearer abc",
    "Basic abc",
    "https://user:pass@example.com/docs",
    "See https://user:pass@example.com/docs",
    "https://user:pa;ss@example.com/docs",
    "https://user:pa,ss@example.com/docs",
    "https://user:pa(ss@example.com/docs",
  ]) {
    assert.throws(
      () =>
        decodeDriverTurnEventPayload({
          ...driverPayloadFixtures["tool-invocation-update"],
          sanitizedSummary,
        }),
      CodecDecodeError,
    );
  }
  assert.doesNotThrow(() =>
    decodeDriverTurnEventPayload({
      ...driverPayloadFixtures["tool-invocation-update"],
      sanitizedSummary: "See https://platform.openai.com/docs/api-reference",
    }),
  );
});

test("persisted inference resolution must identify its enclosing Turn", () => {
  assertIssue(
    () =>
      decodeTurnEvent({
        id: "event:TurnEvent:0001",
        turnId: "event:Turn:0001",
        sequence: 1,
        visibility: "internal",
        occurredAt: NOW,
        payload: {
          ...payloadFixtures["inference-resolved"],
          resolution: {
            ...payloadFixtures["inference-resolved"].resolution,
            turnId: "event:Turn:0002",
          },
        },
      }),
    "invalid-format",
    ["payload", "resolution", "turnId"],
  );
});

test("event decimal costs normalize negative zero at the persisted boundary", () => {
  const event = decodeTurnEventPayload({
    kind: "usage-update",
    usage: { scope: "turn", cost: { amount: -0, currency: "USD" } },
  });
  assert.equal(event.kind, "usage-update");
  if (event.kind !== "usage-update") throw new Error("unreachable");
  assert.equal(event.usage.cost?.amount, 0);
  assert.equal(Object.is(event.usage.cost?.amount, -0), false);
});

scenarioCase({
  scenarioId: "V2-S09",
  caseId: "driver-event-exact-bounds",
  title: "driver events reject oversized content and untrusted envelope fields",
  run: () => {
    assertIssue(
      () =>
        decodeDriverTurnEventPayload({
          kind: "plan",
          entries: [
            {
              content: "x".repeat(4_097),
              status: "pending",
              priority: "low",
            },
          ],
        }),
      "too-long",
      ["entries", 0, "content"],
    );
    assertIssue(
      () =>
        decodeDriverTurnEventPayload({
          ...driverPayloadFixtures["agent-progress-chunk"],
          visibility: "session-readers",
        }),
      "unknown-field",
      ["visibility"],
    );
    assertIssue(
      () =>
        decodeDriverTurnEventPayload({
          ...driverPayloadFixtures["tool-invocation-update"],
          sanitizedSummary:
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        }),
      "forbidden-secret",
      ["sanitizedSummary"],
    );
    assert.equal(
      decodeDriverTurnEventPayload({
        ...driverPayloadFixtures["agent-message-finalized"],
        text: "The user asked about Authorization: Bearer placeholders",
      }).kind,
      "agent-message-finalized",
    );
  },
});

scenarioCase({
  scenarioId: "V2-S10",
  caseId: "driver-event-cannot-select-hitch-state",
  title: "driver event decoding excludes Hitch-authored state and audience metadata",
  run: () => {
    assert.ok(DRIVER_TURN_EVENT_KINDS.includes("agent-message-chunk"));
    for (const kind of [
      "state-transition",
      "inference-resolved",
      "interaction-resolved",
    ] as const) {
      assertIssue(
        () => decodeDriverTurnEventPayload(payloadFixtures[kind]),
        "unsupported-discriminant",
        ["kind"],
      );
      assert.equal(decodeTurnEventPayload(payloadFixtures[kind]).kind, kind);
    }
    assertIssue(
      () =>
        decodeDriverTurnEvent({
          observedAt: NOW,
          payload: driverPayloadFixtures.terminal,
          visibility: "requester",
        }),
      "unknown-field",
      ["visibility"],
    );
  },
});

scenarioCase({
  scenarioId: "V2-S20",
  caseId: "native-event-projection-exhaustive",
  title: "native streaming, tool, usage, interaction, and terminal projections are explicit",
  run: () => {
    for (const kind of DRIVER_TURN_EVENT_KINDS) {
      const decoded = decodeDriverTurnEventPayload(driverPayloadFixtures[kind]);
      assert.equal(decoded.kind, kind);
    }
    assert.equal(
      decodeTurnEventPayload(payloadFixtures["agent-message-chunk"]).kind,
      "agent-message-chunk",
    );
    assert.equal(
      decodeTurnEventPayload(payloadFixtures["tool-invocation-finalized"]).kind,
      "tool-invocation-finalized",
    );
  },
});

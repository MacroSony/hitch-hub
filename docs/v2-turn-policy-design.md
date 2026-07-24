# Hitch v2 turn and dispatch policy

Date: 2026-07-23

Status: accepted domain design; runtime codecs and services are not implemented.

## Boundary

A Hitch `Turn` is the immutable, durable request to perform work in one Hitch
session. ACP, Pi RPC, and future protocols are projections behind an
`AgentDriver`; their request, session, message, and tool IDs never replace Hitch
domain IDs.

`TurnPolicySnapshot` is separate from:

- `ExecutionPolicySnapshot`, which governs sandbox, filesystem, network,
  processes, tools, and resource limits
- live installation hard ceilings, which may narrow an old snapshot during
  admission or dispatch but may never broaden it

`SessionSpec` pins one exact turn-policy snapshot. Configuration-use grants
target the stable `TurnPolicyId` and follow its future published revisions.

## Fixed invariants

These are not configurable:

- Every accepted request receives a durable Hitch `TurnId`.
- Turn requests and input snapshots are immutable after admission.
- At most one turn actively controls an agent session.
- Every producer supplies an origin-scoped idempotency key.
- Authorization is checked at admission and again before queued work starts.
- Required authority and live installation ceilings are rechecked at every
  privileged boundary while work is active.
- Every provider request consumes a durable, finite per-Turn request/token
  reservation before upstream I/O.
- Terminal results never change.
- Turn completion and connector delivery are separate state machines.
- A prompt that may have reached an agent is never replayed automatically.
- Queued prompts remain inside Hitch; only the queue head reaches a driver.
- Raw reasoning and unsanitized tool input/output are not durable turn events.

## Policy snapshot

The append-only `TurnPolicySnapshot` configures:

- busy behavior and maximum queue depth
- a v1-style dynamic active-work deadline and interaction timing
- approval and structured-input handling
- retry attempts that are provably before agent acceptance
- finite provider-request, total-token, and per-request output-token ceilings
- progress delivery and sanitized checkpoint behavior

Initial defaults:

- one active turn per session
- bounded FIFO with at most three private pending turns
- no automatic cancellation of active work on a new message
- no replay after possible agent acceptance
- finite request/token budgets, narrowed by live installation ceilings
- approval timeout means denial
- finalized messages and terminal facts are durable
- raw reasoning and raw tool input/output are never durable

## Lifecycle and prompt acceptance

```text
queued
  |
  v
dispatching
  |
  v
submitted-unconfirmed
  |-- explicit acknowledgement --> accepted --> running
  |-- first attributable event ----------------> running
  |-- terminal response ------------------------> terminal
  `-- worker/connection loss -------------------> terminal/unknown
```

Transport write success means only that bytes reached a pipe or socket. It does
not prove that the agent parsed, recorded, or began the prompt.

Acceptance evidence is limited to:

- an explicit acknowledgement correlated to the dispatched prompt request
- a turn-attributable user-message record, agent message/progress, plan, tool
  invocation, interaction request, or running state event, when the driver
  guarantees causal attribution to that exact Hitch Turn
- the terminal response correlated to the dispatched prompt request

Session title, configuration, background usage, process liveness, elapsed time,
and heuristic content matching are not acceptance evidence.

ACP v1 keeps `session/prompt` open until the turn stops. `session/update`
notifications provide inferred acceptance evidence, and the prompt response is
terminal evidence. ACP v1 message IDs are optional, agent-generated, and not
safe as Hitch idempotency or replay keys.

ACP v2 draft prompt acceptance can map to Hitch `accepted`. ACP v2 also permits
background and out-of-turn session updates, so a session-level `running` update
maps to this Turn only when the driver provides an explicit correlation or
causal guarantee. An uncorrelated update is never acceptance evidence.

## Recovery and replay

| Last durable fact | Recovery |
|---|---|
| queued | dispatch normally |
| dispatch failed before write | retry within the before-acceptance limit |
| submitted but unconfirmed | do not replay; reconcile or mark unknown |
| explicitly accepted | resume/reconnect; do not replay |
| running | resume/reconnect; do not replay |
| terminal | no replay |

Exact reconciliation requires an agent/driver capability that can query a
durable turn handle. History or content matching is never exact reconciliation.
When exact reconciliation is unavailable after possible acceptance, the turn
ends as `unknown/worker-lost-after-dispatch`. Reconciliation finishes before
that immutable terminal result is recorded; later evidence is retained as an
audit anomaly and never rewrites the result. A user may explicitly retry it as
a new turn after being warned that side effects could be duplicated.

## FIFO and queue controls

The queue is owned and persisted by Hitch:

```text
Hitch queue -> queue head -> AgentDriver -> ACP/Pi
```

Cancelling queued work never calls the agent. The persisted queue contains an
optional active Turn ID and an oldest-first bounded list of pending Turn IDs.
Claiming the head atomically moves it from pending to active and records its
dispatching state transition. Queued cancellation atomically removes the pending
ID, records the Turn's immutable cancelled result and terminal state, and
appends its durable state/terminal events.

Queue-control authority:

- a requester may cancel their own queued turn
- a session participant may control only their own queued turns
- a session operator or owner may cancel any queued turn
- a content-blind administrator may cancel/clear queued work without reading it
  through `turn.admin.cancel`
- authority loss automatically cancels affected queued work
- once claiming/dispatch begins, queued cancellation fails; active cancellation uses
  session-control authority

Cancellation is addressed to an immutable Turn ID and succeeds only while that
Turn remains pending. A retry that observes the resulting terminal cancellation
returns `already-cancelled`, distinguishing a lost successful response from a
claim race. Editing queued work means cancelling and submitting a new Turn at
the tail. Preserving a queue position during replacement is deferred because
that feature requires the stable-slot revision model described in
`v2-deferred-design.md`.

Portable controls:

- list queue
- cancel by Turn ID or short display ID
- cancel the active turn separately

CLI commands, IM commands, and connector-native buttons are projections of the
same application-service operations. Queue views reveal prompt content only
when the viewer has `turn.read` through requester or session access.

## Idempotency

The uniqueness scope is the origin endpoint plus `TurnIdempotencyKey`.

Examples:

- connector account and external message ID
- local-client endpoint and request ID
- future schedule ID and occurrence ID

A duplicate submission returns the original receipt. It never creates a second
Turn or changes queue order.

## Timing

Turn policy keeps the v1-style dynamic deadline needed by long agentic
workflows:

- the Turn starts with `initialActiveWorkMs`
- each distinct tool invocation adds `toolExtensionMs`
- the resulting active-work budget cannot exceed `maximumActiveWorkMs`
- each approval or structured-input request has `interactionWaitMs`

Active-work accounting pauses during a human interaction. There is no separate
fixed wall-clock cap in v2.0: useful tool activity can extend a Turn up to its
configured active-work maximum. An interaction deadline resolves the interaction
as denial/no-input; it is not by itself a terminal turn timeout, so the agent may
recover. Stall detection and the supervisor's bounded cancellation/cleanup grace
are operational safeguards rather than session-policy knobs in the first slice.
Agent and tool stalls still produce explicit, auditable timeout reasons.

The provider broker admits no new inference request while active-work
accounting is paused for approval or input. Its gate reopens only when the same
Turn returns to `running`.

## Approval and input

Agent permission requests are interaction events, not authorization decisions:

```text
agent request
  -> Hitch execution policy
       -> deny
       -> pre-authorized
       -> ask a principal with session.approve
```

An agent-provided persistent option such as "always allow" never creates a
Hitch grant and is never returned to the agent as a one-time Hitch approval.
Durable authority changes use the normal elevated administration path. Session
participants and operators cannot approve unless separately granted the
approver role. Sensitive approval details should use a private approver endpoint
rather than an untrusted delivery surface.

Cancelling a turn cancels all outstanding interactions. Approval timeout means
denial; the agent may recover from that denial or finish the turn.

Each interaction has a durable `TurnInteraction` record. An approval request
stores a sanitized title/description, its tool-invocation ID, and the complete
agent-advertised option list: opaque ID, original protocol kind, and
driver-normalized semantic disposition. A separate selectable list contains
only safe one-operation allow/deny choices. An input request stores its
sanitized prompt and optional response schema; submitted response content is
retained separately under content access controls.

Every resolution records its provenance:

- execution-policy decisions reference the exact execution-policy snapshot
- human approval records authenticated principal/binding/request evidence, the
  successful authorization basis, supporting grant when applicable, selected
  normalized option, and the agent option returned
- requested input may be answered only by the authenticated originator and
  records the same authorization evidence plus a protected response reference
- timeout and turn cancellation are explicit system resolutions

Agent-provided options are projections only, and their wire semantics are not
changed by relabeling. A Hitch `allow-once` response may directly select only an
option the agent advertised with one-operation allow semantics; one-operation
denial follows the same rule. ACP v1 `allow_always` and `reject_always` are
therefore retained for audit but filtered from direct selection, while
`allow_once` and `reject_once` are safe direct mappings.

A driver may instead expose a selectable mediated response only when it
provides an auditable mediation ID and guarantees one-tool-invocation scope
without returning the persistent option to the agent. If there is no safe
one-time allow mapping, Hitch cannot approve. If it also cannot express a safe
one-time denial, Hitch cancels the Turn as
`unsafe-agent-permission-options`; it never falls back to a persistent option.

## Revocation during active work

Revocation fails closed rather than relying on the immutable admission snapshot:

- disabling the requester, revoking their identity binding, or revoking the
  grant/role required to prompt or execute initiates active cancellation
- suspending/revoking the origin endpoint binding initiates active cancellation
- revoking a required configuration-use grant, provider credential binding, or
  installation hard-ceiling permission blocks new broker/tool operations and
  initiates active cancellation
- an administrator's blind stop/cancel uses the same cancelling state without
  granting content access

Once cancellation begins, new privileged broker/tool operations fail, pending
interactions resolve as cancelled, and later interaction responses are rejected.
The driver receives cancellation and may emit bounded final events during a
supervisor-defined grace period; the supervisor forcibly terminates the worker
when the grace expires.

Each provider request has a durable reservation attributed to its Turn,
CredentialLease, WorkerLease, and fencing token. The reservation transaction is
the request's authorization point. A reservation is released only when no
upstream I/O occurred; otherwise final provider usage is charged, or the full
reservation is charged when usage is unavailable. Before the queue can dispatch
the next Turn, all old-Turn requests are settled/released/charged and in-flight
streams are aborted or drained.

Delivery always performs its own current authorization and binding checks,
including after a Turn has completed. A revoked/suspended binding or lost
recipient authority suppresses delivery and records a delivery failure without
changing the terminal Turn result.

## Events, visibility, and delivery

Canonical turn events include:

- state transitions
- immutable inference resolution
- user-message recording
- agent message chunks and finalized messages
- transient progress
- plan snapshots
- sanitized tool invocation status
- interaction request and resolution
- provider request/token reservations and usage/cost observations
- terminal result

Hitch assigns every event ID and sequence after validation. Optional protocol
message and tool-call IDs are correlation metadata only.

Callers submit one `TurnEvent` shape without a durability selector. The
persistence boundary exhaustively derives storage handling from payload kind:

- message/progress chunks are transient and cannot be marked durable
- plans, active sanitized tool status, and incremental usage are checkpoints
- inference resolution, finalized messages/tool status/usage, complete
  interaction requests and resolutions, terminal results, and state transitions
  are durable and cannot be marked transient

Inference reservations and their aggregate ledger are durable records rather
than driver-selected event payloads. Their repository transaction also appends
the inference-resolution event for the first agent-selected request.

Turn completion does not depend on outbound delivery. Delivery rechecks the
origin binding and current authority, follows its response policy, and records
its own retry/expiry result without rewriting the Turn result.

## Deferred shared context

V2.0 admits turns only through private bindings, so `TurnInputSnapshot` contains
only the triggering content. Shared endpoint audience, activation, context, and
response semantics remain recorded in `v2-deferred-design.md` and will return to
the active model only with an end-to-end authorization implementation.

## ACP translation

The preferred ACP v1 mapping is:

| Hitch | ACP v1 |
|---|---|
| queue head | one `session/prompt` request |
| content blocks | capability-filtered ACP `ContentBlock[]` |
| submitted-unconfirmed | prompt written, no attributable update |
| running evidence | causally attributable `session/update` |
| message/tool correlation | optional opaque ACP IDs |
| terminal result | `PromptResponse.stopReason` plus Hitch-only failures |
| active cancellation | `session/cancel` and supervisor cleanup grace |
| approval request | `session/request_permission`, subordinated to Hitch policy |

Queued turns have no ACP representation because they have not been dispatched.
This keeps queue cancellation deterministic and works equally for ACP, Pi RPC,
and other drivers.

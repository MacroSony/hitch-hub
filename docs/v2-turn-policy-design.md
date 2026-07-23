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
- `EndpointBindingPolicySnapshot`, which governs shared-chat audience,
  activation, captured context, and response routing
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
- Terminal results never change.
- Turn completion and connector delivery are separate state machines.
- A prompt that may have reached an agent is never replayed automatically.
- Queued prompts remain inside Hitch; only the queue head reaches a driver.
- Group context contributors never lend authority to the triggering requester.
- Raw reasoning and unsanitized tool input/output are not durable turn events.

## Policy snapshot

The append-only `TurnPolicySnapshot` configures:

- busy behavior and maximum queue depth
- active-work, wall-clock, stall, interaction, and cancellation timing
- approval and structured-input handling
- retry attempts that are provably before agent acceptance
- progress delivery and sanitized checkpoint behavior

Initial defaults:

- one active turn per session
- bounded FIFO with at most three private pending turns
- shared endpoint policy may narrow the queue to one
- an optional replace-newest-own-pending admission mode may supersede only the
  highest-ordinal queued turn from the same requester, never another
  principal's turn
- no automatic cancellation of active work on a new message
- no replay after possible agent acceptance
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

Cancelling or replacing queued work never calls the agent.

`TurnQueueEntry` is a stable FIFO slot with a monotonic session-local ordinal.
It points to the current immutable Turn. Replacing a queued turn:

1. atomically verifies the expected queue-entry revision, `queued` state, and
   exact `currentTurnId`
2. terminates the old Turn as `cancelled/superseded`
3. creates and fully reauthorizes a new immutable Turn
4. sets `supersedesTurnId`
5. updates the queue entry to the new Turn while preserving its ordinal

The original bounded group-context snapshot is retained when replacing only
the triggering prompt. A caller that wants newer context cancels and submits a
new turn at the end of the queue.

Queue-control authority:

- a requester may cancel or replace their own queued turn
- a session participant may control only their own queued turns
- a session operator or owner may cancel any queued turn
- no principal may replace another principal's turn; controllers cancel it and
  submit a new turn under their own identity
- a content-blind administrator may cancel/clear queued work without reading it
  through `turn.admin.cancel`
- authority loss automatically cancels affected queued work
- once claiming/dispatch begins, replacement fails; active cancellation uses
  session-control authority

Every queue mutation compares the expected revision, `queued` state, and
`currentTurnId` in one transaction. Thus a delayed command for `T1` cannot
cancel or replace `T2` after the stable slot has been updated. A race that has
already claimed the turn returns `turn-already-started`; a stale replacement
returns a revision/current-turn conflict.

Cancel and replace commands also carry an operation-level idempotency key scoped
to the actor and queue entry. Retrying a successfully applied mutation returns
the original result; reusing that key with a different command payload is
rejected. The idempotency record is checked before the current precondition on a
retry. Replacement creates its new Turn and input snapshot in the same
transaction as the compare-and-swap, so retry cannot create another replacement.
`TurnQueueEntry.revision` increments on replacement, claim, and close, and queue
views expose it for portable UI controls.

Portable controls:

- list queue
- cancel by Turn ID or short display ID
- replace an owned queued turn
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

Turn policy uses distinct clocks:

- active work: agent processing time, extended by distinct tool invocations up
  to a hard maximum
- wall clock: absolute lifetime that never pauses
- agent stall: no valid agent progress
- tool stall: no progress for an active tool invocation
- interaction wait: deadline for resolving an approval or requested input
- cancellation grace: final events and cleanup after cancellation

Active-work accounting pauses during a human interaction. Wall-clock accounting
does not. An interaction deadline resolves the interaction as denial/no-input;
it is not by itself a terminal turn timeout, so the agent may recover. After
cancellation, final driver events remain acceptable until a cancelled terminal
result or grace expiry; grace expiry lets the supervisor terminate the worker.

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
Durable authority changes use the normal elevated administration path. Group
participants and operators cannot approve unless separately granted the
approver role. Sensitive approval details should use a private approver endpoint
rather than a shared group response.

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
- suspending/revoking the origin endpoint binding or replacing its binding
  policy initiates active cancellation
- revoking a required configuration-use grant, provider credential binding, or
  installation hard-ceiling permission blocks new broker/tool operations and
  initiates active cancellation
- an administrator's blind stop/cancel uses the same cancelling state without
  granting content access

Once cancellation begins, new privileged broker/tool operations fail, pending
interactions resolve as cancelled, and later interaction responses are rejected.
The driver receives cancellation and may emit bounded final events during the
configured grace period; the supervisor forcibly terminates the worker when the
grace expires.

Delivery always performs its own current authorization and binding checks,
including after a Turn has completed. A revoked/suspended binding or lost
recipient authority suppresses delivery and records a delivery failure without
changing the terminal Turn result.

## Events, visibility, and delivery

Canonical turn events include:

- state transitions
- user-message recording
- agent message chunks and finalized messages
- transient progress
- plan snapshots
- sanitized tool invocation status
- interaction request and resolution
- usage/cost observations
- terminal result

Hitch assigns every event ID and sequence after validation. Optional protocol
message and tool-call IDs are correlation metadata only.

Durability is constrained by payload kind in the domain types:

- message/progress chunks are transient and cannot be marked durable
- plans, active sanitized tool status, and incremental usage are checkpoints
- finalized messages/tool status/usage, complete interaction requests and
  resolutions, terminal results, and state transitions are durable and cannot
  be marked transient

Turn completion does not depend on outbound delivery. Delivery rechecks the
origin binding and current authority, follows its response policy, and records
its own retry/expiry result without rewriting the Turn result.

## Group context

Admission captures an immutable `TurnInputSnapshot` containing:

- the triggering message
- exact bounded context messages
- principal attribution, source message ID, and timestamp for each contributor

Only audience-authorized messages may enter this snapshot. The triggering
principal is the sole requester and source of turn authority. If the shared
binding or its policy snapshot changes while the turn is queued, the queued turn
is cancelled before dispatch.

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
| active cancellation | `session/cancel` and cancellation grace |
| approval request | `session/request_permission`, subordinated to Hitch policy |

Queued turns have no ACP representation because they have not been dispatched.
This keeps queue cancellation/replacement deterministic and works equally for
ACP, Pi RPC, and other drivers.

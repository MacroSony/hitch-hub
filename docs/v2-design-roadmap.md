# Hitch v2 pre-implementation design roadmap

Date: 2026-07-24

This document records the remaining design gates after the initial v2 session,
identity, authorization, endpoint, and binding model. The goal is to settle the
cross-component contracts that would otherwise force expensive rewrites, not to
fully specify every future product feature before implementation begins.

The canonical first executable product and acceptance boundary is
[`v2-first-slice.md`](./v2-first-slice.md). V1 is a frozen maintenance baseline;
the first slice is a clean structured Pi RPC path through a private local CLI,
not a v1 dispatch refactor, PTY path, or ACP integration.

## Design order

### 1. Turn and dispatch model (MVP contract modeled)

Define the Hitch-native unit of work independently of any agent protocol:

- immutable turn request, actor, origin, content, attachments, and inference
  choice
- admission, queueing, concurrency, idempotency, and duplicate delivery
- running, waiting, cancellation, timeout, completion, and failure transitions
- canonical agent events with storage-derived durability
- approval and elicitation lifecycles
- private-origin replies and authorization rechecks

ACP is the preferred translation target, but ACP request IDs, prompt lifetimes,
session updates, and stop reasons do not become Hitch domain identifiers or
policy.

The accepted design is recorded in
[`v2-turn-policy-design.md`](./v2-turn-policy-design.md).

### 2. Execution security and credential boundary (MVP contract modeled)

Define how an immutable `SessionSpec` becomes a revalidated launch plan:

- host-resource resolution into sandbox mounts
- provider/model and extension reauthorization
- session-scoped broker protocol and credential lifetime
- per-Turn request/token reservation and drain-before-handoff behavior
- credential revocation at every privileged boundary
- launch-time mount identity, destination-shadowing, and network-mode checks
- explicit rejection of raw-credential, ambient-discovery, or ungranted
  extension requirements
- network behavior and fail-closed sandbox guarantees

The accepted design is recorded in
[`v2-execution-security-design.md`](./v2-execution-security-design.md).

### 3. Minimal agent runtime boundary (MVP contract modeled)

Derive only the `AgentDriver` operations required by the first vertical slice:

- capability discovery needed to validate a configured profile
- runtime start, resume, close, and opaque resume handles
- durable submission arming, protocol prompt submission, correlated acceptance,
  and canonical event streaming
- approval, elicitation, cancellation, and terminal-result handling
- explicit pinned declarative resources and exact granted extensions
- Pi RPC mapping first, with the boundary shaped for later ACP and PTY drivers

The worker supervisor, not an agent driver, owns process launch, sandboxing,
broker-capability injection, environment construction, lease fencing, and
cleanup.

The accepted design is recorded in
[`v2-agent-runtime-provider-design.md`](./v2-agent-runtime-provider-design.md).

### 4. Private connector and delivery slice

Define the connector-neutral ingress and egress records:

- authenticated sender and normalized endpoint identity
- private endpoint and reply signals
- message IDs, deduplication, edits, deletion, and attachment limits
- connector capability discovery and response-mode fallback
- ordered delivery, retries, expiry, and idempotency

All connectors and the CLI must call the same dispatch application service.

### 5. Persistence, recovery, and audit slice

Define:

- repository contracts and transaction boundaries
- runtime codecs for the revisions, grants, and snapshots used by the slice
- mutable lifecycle records and durable turn events
- worker leases and crash recovery
- revocation propagation and retention ownership
- audit envelopes, actor attribution, and content redaction
- clean-schema initialization and destructive cutover safeguards

V2 storage is a replacement, not a migration target:

- the new application owns one canonical schema with normal domain table names,
  not `v2_*` compatibility tables
- there is no v1 importer, dual read/write path, compatibility view, or
  automatic rollback
- development and vertical-slice tests use isolated disposable data roots
- production cutover explicitly resets the old Hitch-managed database, runtime
  state, delivery state, audit data, and agent session state before initializing
  the new schema
- startup rejects a legacy or unknown schema and tells the operator to run the
  explicit reset; it never silently destroys data merely because a new binary
  was started

The reset operation must resolve and validate the exact configured Hitch data
root, require an installation marker, and remove only the enumerated
Hitch-managed artifacts. External workspaces and user-supplied configuration are
never reset. Operators who want an archive must create it outside Hitch before
cutover; Hitch itself retains or imports no legacy records.

### 6. Application-service slice

Implement the commands needed for a private turn uniformly across CLI, IM, and
future API adapters:

- session and configuration loading
- turn dispatch, interaction response, queued/active cancellation, and
  administrative stop

## Intentionally deferred

These do not block the first v2 implementation:

- shared endpoint bindings, group context, and endpoint-participant grants
- same-position queued-turn replacement and its stable-slot concurrency model
- configurable stall detection and cancellation grace
- OIDC and remote CLI login
- authenticated-but-unenrolled group guests
- team-owned sessions
- schedules and proactive subscriptions
- ACP v2 wire support
- remote agent transport
- alternative sandbox engines
- enforced egress proxying
- management UI

## Implementation threshold

Implementation begins with the vertical slice fixed in
[`v2-first-slice.md`](./v2-first-slice.md). Agent runtime, launch planning,
private connector ingress, persistence, and application-service interfaces
should be introduced only when that slice consumes them. It must exercise:

- immutable `SessionSpec` loading and live reauthorization
- private turn admission, idempotency, bounded FIFO, and cancellation by Turn ID
- Pi launch through the clean v2 sandbox boundary with worker networking denied,
  ported model-tool confinement, and one egress-constrained secure Pi
  native-library inference sidecar
- prompt acceptance evidence, safe recovery, and immutable terminal results
- approval safety and independently authorized delivery

The minimal agent runtime, explicit resource-loading, and transport-pluggable
inference control contracts are accepted in
[`v2-agent-runtime-provider-design.md`](./v2-agent-runtime-provider-design.md).
The Pi `ModelRuntime` sidecar feasibility gate is satisfied by
[`spikes/pi-native-sidecar`](../spikes/pi-native-sidecar/README.md). It fixes
the Pi 0.82.0 first fixture and proves native DeepSeek and OpenAI Codex
transport, credential isolation, structured events and usage, cancellation,
request replay denial, and constrained sidecar egress. The first vertical-slice
implementation may begin.

Future-facing contracts move into `v2-deferred-design.md` until implementation
evidence justifies promoting them into the active model.

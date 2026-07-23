# Hitch v2 pre-implementation design roadmap

Date: 2026-07-23

This document records the remaining design gates after the initial v2 session,
identity, authorization, endpoint, and binding model. The goal is to settle the
cross-component contracts that would otherwise force expensive rewrites, not to
fully specify every future product feature before implementation begins.

## Design order

### 1. Turn and dispatch model (modeled)

Define the Hitch-native unit of work independently of any agent protocol:

- immutable turn request, actor, origin, content, attachments, and model choice
- admission, queueing, concurrency, idempotency, and duplicate delivery
- running, waiting, cancellation, timeout, completion, and failure transitions
- canonical agent events and durable versus ephemeral output
- approval and elicitation lifecycles
- group-context capture and activation
- origin replies, proactive delivery, and authorization rechecks

ACP is the preferred translation target, but ACP request IDs, prompt lifetimes,
session updates, and stop reasons do not become Hitch domain identifiers or
policy.

The accepted design is recorded in
[`v2-turn-policy-design.md`](./v2-turn-policy-design.md).

### 2. Agent runtime boundary

Derive `AgentDriver` from the accepted Hitch turn contract:

- capability discovery and negotiation
- structured versus PTY interaction modes
- runtime start, resume, close, and opaque resume handles
- turn submission and canonical event streaming
- approval, elicitation, cancellation, and terminal-result handling
- ACP v1, Pi RPC, and PTY driver mappings

The worker supervisor, not an agent driver, owns process launch, sandboxing,
credential injection, environment construction, and cleanup.

### 3. Execution security and credential boundary

Define how an immutable `SessionSpec` becomes a revalidated launch plan:

- host-resource resolution into sandbox mounts
- provider/model and extension reauthorization
- session-scoped broker protocol and credential lifetime
- credential rotation and revocation
- compatibility policy for agents that require raw provider credentials
- extension capability projection
- network behavior and fail-closed sandbox guarantees

### 4. Connector and delivery contract

Define the connector-neutral ingress and egress records:

- authenticated sender and normalized endpoint identity
- private, group, channel, thread, mention, reply, and command signals
- message IDs, deduplication, edits, deletion, and attachment limits
- connector capability discovery and response-mode fallback
- ordered delivery, retries, expiry, and idempotency

All connectors and the CLI must call the same dispatch application service.

### 5. Persistence, recovery, and audit

Define:

- repository contracts and transaction boundaries
- append-only revisions, grants, and policy snapshots
- mutable lifecycle records and durable turn events
- worker leases and crash recovery
- revocation propagation and retention ownership
- audit envelopes, actor attribution, and content redaction
- v1-to-v2 migration and rollback boundaries

The preferred migration direction is separate v2 tables plus an explicit
importer, leaving the v1 schema intact while v2 stabilizes.

### 6. Application-service boundary

Define the commands used uniformly by CLI, IM, and future API adapters:

- principal enrollment and identity linking
- role and resource-grant management
- profile, workspace, policy, and extension publication
- session creation, forking, binding, archive, and quarantine
- turn dispatch, interaction response, cancellation, and administrative stop

## Intentionally deferred

These do not block the first v2 implementation:

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

Implementation may begin after the turn/dispatch, agent-runtime, and execution
security boundaries have accepted contracts. Connector, persistence, and
application-service design should then proceed as part of the first vertical
slice rather than as independent implementations.

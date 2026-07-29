# Hitch v2 first-slice implementation plan

Date: 2026-07-25

Status: accepted task catalog and dependency reference

This document turns the accepted v2 contracts and the successful Pi native
sidecar spike into commit-sized implementation work. It does not reopen the
product scope in [`v2-first-slice.md`](./v2-first-slice.md), and it does not
reuse the frozen v1 runtime as a compatibility layer.

Current task state, reviewed execution order, and blockers live in
[`v2-status.md`](./v2-status.md). The waves below group capabilities and
dependencies; they are not a live status board or a requirement to postpone
all integration until the final wave.

## Delivery rules

- New implementation lives under `src/v2/`. It may study v1 code, but imports
  no v1 application, persistence, connector, or runtime service.
- `src/v2/model/` remains the compile-only domain boundary. Missing first-slice
  records are added deliberately before repositories encode them.
- Every task includes deterministic tests. Security and recovery tests are not
  deferred to a final hardening pass.
- Every security-sensitive state change emits its allowlisted audit envelope in
  the same transaction as the authoritative fact; later tasks do not bolt audit
  records onto completed workflows.
- First-slice executable codecs reject deferred discriminants even when the
  broader compile-only model describes them.
- Real provider calls remain opt-in and run only after deterministic sidecar,
  broker, and sandbox tests pass.
- No migration, dual-write, compatibility table, automatic reset, or production
  v1 cutover is implemented in this slice.
- One implementer owns a bounded task with explicit files. An independent
  reviewer performs a read-only security/correctness review. Corrections and
  repository-wide verification happen before the task is committed.

## Module ownership

| Area | Modules | Owns |
|---|---|---|
| Domain and codecs | `src/v2/model/`, `src/v2/codecs/` | First-slice records, untrusted decoding, canonical encodings, cross-record invariants |
| Bootstrap | `src/v2/bootstrap/` | Versioned configuration fixture, deterministic publication projection |
| Persistence | `src/v2/persistence/` | Canonical SQLite schema, transactions, repositories, recovery queries |
| Application | `src/v2/application/` | Authorization-aware use cases and transaction orchestration |
| Local connector | `src/v2/connectors/local/` | Private socket, framing, connector-derived identity and origin |
| Attachments | `src/v2/attachments/` | Private copy, MIME/hash/size validation, model projection |
| Launch planning | `src/v2/runtime/launch-plan/` | Pure resource and reviewed command projection |
| Supervisor | `src/v2/runtime/supervisor/`, `src/v2/sandbox/` | Mount verification, Bubblewrap, fencing, lifetime and cleanup |
| Pi driver | `src/v2/drivers/pi-rpc/` | Pi JSONL protocol, prompt acceptance, event normalization, safe interactions |
| Native bridge | `src/v2/bridges/pi-native/` | Typed bridge protocol and generated reviewed extension |
| Broker and sidecar | `src/v2/broker/`, `src/v2/sidecars/pi-native/` | Live authority, durable forwarding, credential custody, native invocation |
| Turn coordinator | `src/v2/application/turn-worker/` | Dispatch state machine, event materialization, cancellation and recovery |
| Delivery | `src/v2/delivery/` | Independently authorized durable responses |
| CLI | `src/v2/cli/`, `src/v2/main.ts` | Structured socket client and service entry point |
| Test support | `src/v2/test-support/`, `src/v2/acceptance/` | Disposable roots, deterministic clocks/IDs, fakes and fault injection |

The dependency direction is:

```text
CLI / LocalConnector
  -> Application services
  -> Codecs + repositories + Turn coordinator + Delivery
  -> Supervisor + Pi driver + Broker
  -> generated bridge + trusted Pi sidecar
```

Adapters never accept caller-selected principal IDs, endpoint ownership,
`SessionSpec`, authorization outcomes, host paths, provider origins, raw
credentials, or event durability.

## Task catalog and capability waves

### Wave 0: close the executable contract spine

#### V2-001A — Complete executable first-slice records

Owns: `src/v2/model/` only.

Add the minimal records currently referenced by the accepted scenarios but not
yet modeled:

- installation metadata and live hard ceilings;
- immutable attachment metadata and private blob reference;
- authentication-request evidence retention;
- terminal response projection and independent delivery lifecycle;
- allowlisted audit envelope;
- protected resume-handle metadata and recovery outcome;
- durable normalized inference request fingerprint, forwarding-attempt evidence,
  and restart-safe uniqueness scope;
- service/schema identity needed to reject legacy or unknown roots.

Keep secret material, canonical host paths, raw prompts, raw reasoning, and raw
tool input/output out of these records. Update the compile-only invariant notes
and typecheck fixtures.

Done when the types express every persistence bullet in
`v2-first-slice.md` without adding deferred product features.

Scenarios: 1, 12, 16–19.

#### V2-001B1 — Define application commands and atomic units of work

Owns: new compile-only application/persistence port files and exports under
`src/v2/model/` only.

Define exact first-slice-only:

- connector commands/results and an attached response-event stream;
- trusted authentication-context construction and live authorization;
- production `Clock` and `IdSource` ports;
- transaction-scoped units of work for every atomic boundary;
- bootstrap publication, session creation, Turn admission/claim/cancellation,
  submission arming/outcome, acceptance, interactions, worker/credential
  leases, inference reservation/forwarding/settlement, terminalization, queue
  handoff, delivery outbox, and startup recovery;

These are semantic operations, not generic CRUD repositories. External
process, driver, sidecar, and delivery I/O never runs inside a database
transaction.

Scenarios: 1–19.

#### V2-001B2 — Define external runtime and storage ports

Owns: new compile-only runtime/storage port files and exports under
`src/v2/model/` only.

Define:

- attachment staging, finalization, rollback, and orphan cleanup;
- ephemeral launch-authorization assembly/consumption;
- supervisor, Pi driver, broker, sidecar, and delivery interfaces.

Scenarios: 7–21.

#### V2-001C — Establish the incremental acceptance harness

Owns: initial `src/v2/test-support/`, `src/v2/acceptance/scenarios.ts`, and the
v2 deterministic test command.

Add deterministic implementations of the production `Clock` and `IdSource`
ports, disposable data-root support, scenario identifiers 1–21, and empty/fake
port fixtures. Production code never imports test support. Every later task
adds its own scenario tests to this harness; V2-015 does not become the first
time cross-component behavior is exercised.

Scenarios: test infrastructure for 1–21.

### Wave 1: executable foundation

Codec work and database-root primitives may run in parallel after
V2-001A–B2 and V2-001C.

#### V2-002A — Primitive and boundary codecs

Owns: primitive/canonical JSON/audit/event codecs and their corpus tests.

Implement strict branded IDs, RFC3339 timestamps, integrity digests, trusted
origins, canonical JSON, bounded strings/arrays, positive safe integer limits,
MIME types, secret/path rejection, and allowlisted audit/event boundaries.

#### V2-002B — Exact first-slice configuration decoder

Owns: `src/v2/bootstrap/configuration.ts`,
`src/v2/bootstrap/fixture-v1.ts`, and tests.

Decode only Pi RPC, a private local endpoint, one exact resolved model, one
`native-library-sidecar` connection with Hitch credential custody, denied
worker network, disabled native retries, and pinned agent-loop-preserving
resources/grants. Explicitly reject ACP/other drivers, agent-selected models,
native-wire, agent-native, Hitch-authored provider adapters, multiple exposed
connections, and every other deferred/lower-assurance discriminant.

Exact numeric defaults live in this fixture and nowhere else.

#### V2-002C — Cross-record validation and publication projection

Owns: revision/record codecs, cross-record validators,
`src/v2/bootstrap/publication-projection.ts`, and tests.

Implement record codecs for profiles, workspace/policy/resource revisions,
provider connections/model manifests, credential-binding metadata,
`SessionSpec`, and the publication projection.

Cross-record validation must reject:

- duplicate or conflicting provider/resource/grant entries;
- profile, `SessionSpec`, connection, model, bridge, catalog, or custody drift;
- a default model outside its exact connection allowance;
- unsupported reasoning or image limits;
- non-finite or non-positive policy values;
- installation ceilings that widen the pinned snapshot;
- secret-bearing values, request-selected origins, host paths, commands,
  ambient loaders, or arbitrary headers in secret-free projections.

Deterministic tests may instantiate separate DeepSeek and OpenAI Codex
configurations; the running first slice exposes only the one selected
configuration.

Scenarios: 1–3, 7, 9–10, 12–15, 19–20.

#### V2-003A — Database-root and transaction primitives

Owns: `src/v2/persistence/database.ts`, `root.ts`, `transaction.ts`, and
persistence errors.

Use Node 24 `DatabaseSync` at an explicitly configured disposable v2 data root.
Validate and create the installation marker and open one `hitch.sqlite`, but do
not stamp a final schema or create domain tables yet. Provide explicit
transaction/fault-injection primitives.

Enable foreign keys, a finite busy timeout, WAL, and explicit transactions.
No startup migration or reset exists.

Scenarios: 1, 18.

#### V2-003B — Complete canonical schema manifest and initialization

Owns: `src/v2/persistence/schema.ts`, `initialize.ts`, and schema tests.
Repositories never create or silently alter tables.

After V2-001A–B2 and V2-002B–C fix every executable record and transactional
port, define all first-slice tables, constraints, indexes, and schema metadata
once. Stamp and validate SQLite `application_id`, `user_version`, and singleton
metadata. A new root initializes atomically; v1, unknown, partial, mismatched,
older, or newer roots fail without mutation.

The schema remains an explicitly versioned pre-release manifest until the
walking skeleton and repository/coordinator integration validate it. Before
that freeze gate, a required schema correction returns to the schema owner,
updates the manifest/digest/tests deliberately, and may recreate only
disposable v2 roots. After the freeze gate, any DDL change requires a new
schema version; no later repository owns ad hoc DDL.

### Wave 2: durable bootstrap and independent runtime seams

V2-004 is the data spine. V2-005, V2-006A, and V2-007 can proceed against the
Wave 1 contracts with disjoint ownership.

#### V2-004 — Bootstrap publication and foundational repositories

Owns: bootstrap-publication, identity/access, catalog, and allowlisted audit
repository implementations only. Session/Turn repositories belong to V2-009.

Consume the V2-003B schema and implement the deterministic publication
transaction for the installation, bootstrap owner, local identity binding,
role/use grants, workspace/profile/policy revisions, resource/extension
snapshots, provider connection/model manifest, and credential-binding metadata.

Semantically identical configuration returns the same records. A semantic
change appends a revision or snapshot and never mutates one pinned by a
`SessionSpec`.

Scenarios: 1–3, 7, 19.

#### V2-005 — Pure Pi launch/resource planning

Owns: `src/v2/runtime/launch-plan/`.

Resolve only already-authorized sandbox paths and reviewed Pi flags. Disable
ambient extensions, skills, templates, themes, project context, hot reload,
shell/process tools, and worker networking; add only pinned resources and exact
extension grants. Reserve protected destinations for workspace, state, runtime,
bridge socket, and resources.

This module performs no spawn, canonical host-path resolution, authorization,
or credential work.

Scenarios: 7, 13–14, 20.

#### V2-006A — Typed native bridge and deterministic sidecar port

Owns: `src/v2/bridges/pi-native/`, `src/v2/sidecars/pi-native/`, their tests.

Port the successful spike into typed modules:

- strict versioned frames and bounded JSONL;
- content-addressed reviewed bridge extension;
- Pi 0.82.0/package/catalog/bridge manifest codecs;
- frozen catalog and injected credential store;
- serialized OAuth refresh;
- text/reasoning/tool/image/usage/error/cancellation representation;
- forced `maxRetries: 0` and SSE;
- no request-selected destination or secret/body logging.

This task exposes a trusted `invoke()` seam. It does not decide Turn authority,
accept raw worker capabilities, or own durable reservations.

Subassignments, each reviewed and committed separately:

1. V2-006A1: bridge frame codecs and reviewed extension generator;
2. V2-006A2: deterministic sidecar/artifact/catalog/credential-store behavior;
3. V2-006A3: native event, OAuth, error, cancellation, retry, and replay matrix.

Scenarios: deterministic portions of 14–15 and 20.

#### V2-006B — Production Pi artifact and sidecar integration

Owns: production artifact verification and sidecar-process integration files;
does not change the V2-006A bridge frames.

After V2-E01 selects the process/network topology, replace `PATH` discovery
with an explicit trusted artifact root, verify every pinned Pi/native/bridge
artifact against the connection revision at launch, and apply the selected
egress boundary to the sidecar process.

Scenarios: 14–15, 20–21.

#### V2-007 — Pi RPC driver

Owns: `src/v2/drivers/pi-rpc/`.

Implement profile sanitization, RPC framing, `prepareTurn`, armed prompt
submission, explicit write outcomes, correlated prompt acknowledgement,
bounded normalized events, safe once-only interaction responses, cancellation,
live-runtime-only reconciliation, and close.

The driver receives only supervisor-owned I/O. It allocates no Hitch IDs,
persists nothing, and receives no host paths, credential, or launch authority.

Scenarios: 8–11, 20.

### Wave 3: private application and secure process boundary

#### V2-008 — Private local connector

Owns: `src/v2/connectors/local/` and framing tests.

Create `<data-root>/run/hitch.sock` only after verifying the data-root marker,
non-symlink path components, service-account ownership, parent mode `0700`, and
socket mode `0600`. Use one versioned bounded frame protocol.

For the single-owner slice, the kernel-enforced owner-only socket boundary is
the authentication evidence: every accepted connection maps to the bootstrap
owner's active local identity binding. The client supplies no principal,
endpoint owner, grant, or authorization result. Root and other same-service-UID
processes are already inside the documented host trust boundary.

`SO_PEERCRED` is therefore not required for this slice. It becomes necessary
only when later work admits multiple operating-system users.

This task depends on the V2-001B1 application command port plus the
V2-004-published identity/binding. It does not call repositories directly.

Scenarios: 2, 16–17.

#### V2-009 — Session creation, attachment intake, and Turn admission

Owns: application session/Turn services, attachment store, and the
session/attachment/Turn/input/queue repository methods fixed by V2-001B.

Implement:

- live authorization and exact `SessionSpec` creation;
- private endpoint/binding creation;
- connector-owned image open, MIME sniff, bounded private copy and hash;
- origin-scoped idempotent Turn admission;
- model resolution before admission;
- live-state query methods consumed later by dispatch authorization;
- one active plus three queued Turns;
- compare-and-remove queued cancellation;
- active cancellation intent without worker launch.

Session, immutable `SessionSpec`, lifecycle/runtime rows, private endpoint, and
active private binding are one transaction. Attachment staging is finalized
with admission or rolled back/orphan-cleaned. Admission, idempotency, capacity,
input snapshot, queue insertion, and receipt are one transaction.

Subassignments, each reviewed and committed separately:

1. V2-009A: live authorization, session creation, and private binding;
2. V2-009B: attachment staging/private store/finalization;
3. V2-009C: Turn admission, idempotency, FIFO, and cancellation intent.

Scenarios: 2–7, 12.

#### V2-010A — Bubblewrap primitives, mount verification, and worker leases

Owns: `src/v2/runtime/supervisor/`, `src/v2/sandbox/`, and only the
`WorkerLease` repository.

Immediately before launch, re-resolve every source and reject symlinks, aliases,
destination overlap, protected-path shadowing, or identity drift. Implement a
session-monotonic worker fence, denied-network deterministic sandbox launch,
lifetime container, readiness, descendant cleanup, and sidecar/worker cleanup
ports.

Confirm descendant cleanup and old-sandbox death before issuing a successor
lease. An unconfirmed old sandbox quarantines the session.

Subassignments, each reviewed and committed separately:

1. V2-010A1: pure mount verification and deterministic Bubblewrap renderer;
2. V2-010A2: worker lifecycle, fencing repository, quarantine, and cleanup.

Scenarios: deterministic portions of 7–8, 13–14, 18.

#### V2-E01 — Select and implement production sidecar egress

Owns: a short accepted ADR, the egress implementation and adversarial tests,
and the fail-closed launch contract consumed by V2-006B/V2-010B.

Select and implement an enforceable sidecar egress boundary. The spike's
audited global `fetch` guard proves the two pinned Pi paths but is not, by
itself, production containment.

The selected mechanism must deny unregistered origins, redirects, proxy
authority changes, private/link-local destinations, and DNS/address changes
while preserving TLS hostname validation and Pi's required proxy behavior.
This is a focused implementation decision for the trusted Pi sidecar, not a
general-purpose agent egress proxy or a reopening of provider serialization.

Done means the process topology, artifacts, launch failure behavior, proxy/DNS
rules, and deterministic escape tests are fixed. V2-001A through V2-010A may
proceed where their stated dependencies allow while this task is resolved.

#### V2-010B — Secure worker/sidecar launch integration

Owns: launch composition only; it does not own lease or broker repositories.

Require the published connection, active Turn, current worker fence,
V2-E01-enforced sidecar, V2-006B artifact verification, and V2-011-issued
broker capability/redaction registration before launching the worker. The
supervisor owns sidecar readiness, lifetime, shutdown, and cleanup.

Scenarios: 7–8, 13–15, 18, 20.

### Wave 4: durable inference and Turn orchestration

#### V2-011 — Credential broker and forward-once reservations

Owns: `src/v2/broker/`, `CredentialLease`, capability-verifier,
reservation/forwarding/usage repositories. It does not own `WorkerLease`.

The broker, not the sidecar socket handler, accepts the worker capability.
It derives the current Turn from trusted lease state, validates live authority,
gate state, fence, connection/model/reasoning, ceilings, and request
fingerprint. The crash boundaries are:

1. One transaction rechecks authority/budget and creates an `authorized`
   reservation.
2. A separate compare-and-swap transaction changes the exact reservation to
   `forwarding` and mints one opaque one-shot forward authorization.
3. The sidecar invocation occurs outside SQLite. An uncertain handoff is never
   retried automatically under that authorization.
4. A separate transaction settles observed usage, conservatively charges
   missing/uncertain forwarded usage, or releases only work proven unforwarded.

Persist only constant-time capability verifiers. Register redaction before
launch. Reject stale/replayed capabilities and authorizations. Drain or abort
old-Turn requests before handoff. Immediately before reserving/forwarding,
recompute accumulated image history and reject requests exceeding the exact
model manifest's count, MIME, per-image, or total-byte limits.

Subassignments, each reviewed and committed separately:

1. V2-011A: capability authentication, redaction, live gate, and credential
   lease;
2. V2-011B: resolution, image-history check, reservation, and forwarding CAS;
3. V2-011C: one-shot invocation, settlement/charge, cancellation, and drain.

Scenarios: 7, 14–15, 18–20.

#### V2-012 — Turn coordinator, event materialization, and recovery

Owns: `src/v2/application/turn-worker/`, Turn state/event/interaction/recovery
repositories.

Implement atomic queue-head claim and live reauthorization, one durable
`AgentDispatchAttemptId`, `dispatching` → `submission-armed` →
`submitted-unconfirmed` → accepted/running/terminal transitions, trusted Hitch
ID allocation, payload-derived durability/visibility, safe interactions,
active-work timing, cancellation, terminal barrier, and queue handoff.

Apply execution policy before creating any user-visible interaction. Expose
only safe one-operation allow/deny mappings and cancel when the driver cannot
express a safe denial. Assemble the ephemeral supervisor launch authorization
from trusted live state and pass it to V2-010B; neither the connector nor the
driver may construct it. Revalidate the accumulated image projection against
the selected model before requesting broker reservation.

Named atomic operations must guarantee:

- interaction creation + waiting transition + durable event;
- interaction resolution/provenance + driver response authorization + running
  or cancelling transition + durable event;
- terminal state + immutable result + finalized messages + terminal events;
- delivery-outbox creation in that same terminalization transaction;
- settled/released/charged old-Turn reservations and zero in-flight requests as
  a predicate before clearing the active Turn or promoting the next queue head.

After restart, possibly submitted work is never replayed heuristically. Prove
the old worker is dead, use exact live reconciliation when available, otherwise
record `unknown/worker-lost-after-dispatch`. Release only reservations proven
not forwarded; charge unknown forwarded usage.

Subassignments, each reviewed and committed separately:

1. V2-012A: queue claim, dispatch attempt, submission, and acceptance;
2. V2-012B: trusted events, execution policy, and interaction mediation;
3. V2-012C: timing, cancellation, terminalization, and delivery outbox;
4. V2-012D: reservation barrier, recovery, quarantine, and queue handoff.

Scenarios: 6–11, 15, 18–19.

### Wave 5: delivery, CLI, and acceptance

#### V2-013 — Independent delivery and result query

Owns: delivery-attempt/query repository methods, delivery worker, and result
query service. V2-012 owns terminal-result/final-message/outbox creation.

Consume the immutable result/outbox created atomically by V2-012. Recheck
current private binding and recipient authority before each send. Retry,
expire, suppress, or fail delivery without changing the Turn result. Recover
unfinished deliveries independently at startup.

Scenarios: 16–17, 19.

#### V2-014A — Structured local protocol and CLI shell

Owns: the versioned service/client framing, `src/v2/cli/`, and the initial
`src/v2/main.ts` command shell.

Implement the private structured request/response protocol and the `serve`,
`session create`, `prompt`, and `turn show` client surfaces early enough to
exercise V2-004/V2-008/V2-009 through a test-owned deterministic fake
coordinator. The CLI generates a cryptographically random idempotency key by
default and never opens SQLite or launches Pi.

This walking-skeleton composition is test-only and makes no secure production
runtime claim. Its test-owned fake coordinator may not write terminal or
delivery state owned by V2-012/V2-013. Production startup must fail closed
until V2-014B supplies every required runtime dependency.

Scenarios: incremental portions of 1–6 and 16.

#### V2-014B — Production service composition and complete CLI

Owns: final `src/v2/main.ts` composition and the remaining CLI operations.

Implement `serve`, `session create`, `prompt`, `turn show`, `turn cancel`,
`session stop`, `interaction approve`, and `interaction deny`. The CLI
continues to open neither SQLite nor Pi directly.

Compose startup recovery for queued Turns, quarantined/unknown workers,
reservations, and delivery; the CLI itself never performs recovery.

Scenarios: 1–8, 11, 16–17.

#### V2-015 — Acceptance and fault-injection matrix

Owns: `src/v2/acceptance/` and opt-in real smoke wiring.

Finish cross-component filesystem/mount adversarial fixtures, concurrent
transaction tests, and crash injection before/after every external boundary.
Scan database/audit fixtures for forbidden prompt, reasoning, tool, credential,
capability, and host-path material. Earlier tasks already own their unit and
scenario tests.

Run all 21 scenarios. DeepSeek and OpenAI Codex are separate opt-in
configurations using the same production sidecar/sandbox path.

## Capability dependency graph

```text
V2-001A ─ V2-001B1 ─ V2-001B2 ─ V2-001C
    ├─────────── V2-002A ─ V2-002B ─ V2-002C ─┬─ V2-005 ─ V2-010A ─┐
    └─────────── V2-003A ─────── V2-003B ─ V2-004 ─ V2-009 ────────┤
                                               └─ V2-008 ─ V2-014A │
V2-003B ────────────────────────────────────────> V2-010A           │
V2-001B2 + V2-002A ────────────────────── V2-007 ───────────────────┤
V2-002A/B ──────────────────────────────── V2-006A ─ V2-E01 ─ V2-006B
                                                                    │
V2-004 + V2-006B + V2-009 + V2-010A ─────────────── V2-011 ────────┤
V2-006B + V2-010A + V2-011 ───────────────────────── V2-010B ───────┤
                                                                    v
                                                                 V2-012
                                                                    │
                                                               V2-013
                                                                    │
                                                               V2-014B

Every task adds acceptance tests ──────────────────────────────> V2-015
```

Each completed assignment receives:

- one independent security/correctness review;
- for cross-module tasks V2-009 through V2-015, a second integration and
  acceptance-coverage review;
- correction and repository-wide verification before commit.

File-disjoint work may proceed in parallel, but the reviewed delivery order is
maintained in [`v2-status.md`](./v2-status.md). Runtime Gate E is an independent
security assignment and blocks V2-006B, V2-010B, and V2-011 regardless of
parallel progress elsewhere.

## Acceptance coverage

| Scenario | Primary tasks |
|---:|---|
| 1 | V2-001A–C, V2-002B–C, V2-003A–B, V2-004, V2-014A–B |
| 2 | V2-004, V2-008–009 |
| 3 | V2-002B–C, V2-004, V2-009 |
| 4–5 | V2-009 |
| 6 | V2-009, V2-010A–B, V2-011–012, V2-014A–B |
| 7 | V2-004–005, V2-009–012 |
| 8 | V2-007, V2-010A–B, V2-012 |
| 9–10 | V2-002A/C, V2-007, V2-012 |
| 11 | V2-007, V2-012, V2-014B |
| 12 | V2-002A–C, V2-006A–B, V2-009, V2-011–012 |
| 13 | V2-005, V2-009, V2-010A–B |
| 14 | V2-005, V2-006A–B, V2-010A–B, V2-011 |
| 15 | V2-006A–B, V2-E01, V2-011–012 |
| 16–17 | V2-008, V2-012–013, V2-014A–B |
| 18 | V2-003A–B, V2-009–013, V2-014B, V2-015 |
| 19 | V2-002A–C, V2-004, V2-008–013, V2-014B, V2-015 |
| 20 | V2-002A–C, V2-006A–B, V2-007, V2-010A–B, V2-011, V2-015 |
| 21 | V2-006A–B, V2-007, V2-010A–B, V2-011, V2-014B, V2-015 |

## Deferred work

Do not add API placeholders for:

- PTY, ACP, remote/HTTP/IM connectors, multi-user enrollment, shared endpoints,
  delegation, schedules, management UI, or unattended producers;
- session reconfiguration/forking, model switching/pickers, agent-selected
  models, or multiple simultaneously exposed connections;
- free-form input UX, outbound media, path discovery, user MCP servers,
  extension package/config management, or background extension inference;
- native wire gateways, agent-native profiles, Hitch-authored provider codecs,
  alternative sandbox engines, or a general-purpose egress proxy;
- v1 import, migration, dual-write, reset/cutover, or automatic rollback.

## Current execution decision

The contract and codec foundation is implemented. Current working-tree tasks
must be reviewed independently, Runtime Gate E should begin immediately, and
the next application work should build the deterministic V2-004/V2-008/V2-009/
V2-014A walking skeleton before the secure runtime is integrated.

V2-E01 must still select, implement, and prove production sidecar egress before
V2-006B, V2-010B, or V2-011 can be declared secure. See
[`v2-status.md`](./v2-status.md) for the exact current state and next task.

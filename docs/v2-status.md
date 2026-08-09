# Hitch v2 implementation status

Date: 2026-08-09

Status: active source of truth for v2 task state, execution order, and blockers

The accepted product boundary is now
[`v2-multi-user-agentic-mvp.md`](./v2-multi-user-agentic-mvp.md). Detailed
historical task ownership remains in
[`v2-implementation-plan.md`](./v2-implementation-plan.md), interpreted through
the new consolidated seven-slice sequence. This file records what is actually
committed, what exists only in the working tree, what should happen next, and
what is blocked.

## Current snapshot

- V1 is a frozen maintenance baseline. It remains the only production-capable
  user-facing Hitch system.
- V2 now has a committed, explicitly development-only walking skeleton:
  trusted startup configuration, `src/v2/main.ts`, a separate structured CLI,
  the real owner-private socket, bootstrap/authentication, session creation,
  Turn admission, private image staging, a no-op FIFO claim, and authorized
  nonterminal `turn show`. Production `serve` remains fail-closed; V2-M07 now
  owns production composition. There is still no Pi driver, secure
  supervisor/broker composition, terminal coordinator, recovery, or delivery
  worker.
- The accepted target changed on 2026-08-09 from the superseded single-owner
  first slice to a private single-installation, multi-user agentic MVP. Remote
  principals authenticate through certificate-bound mTLS on an
  operator-controlled private network; sessions remain private and owner-only;
  each principal receives a fixed workspace and at most one fresh Bubblewrap
  worker at a time. The MVP deliberately omits shared sessions, OIDC, remote
  administration, production attachments, rich interactions, persistent
  workers, automatic retry/recovery, push delivery, provider breadth, and
  exhaustive final-acceptance work.
- The committed executable schema and walking-skeleton composition still
  enforce one active bootstrap owner and local-socket authentication. They are
  valid foundation evidence, not an implementation of the new multi-user
  boundary. V2-M01 must revise the pre-release schema and executable contracts
  before downstream application/runtime integration encodes the singleton
  assumption more deeply.
- The committed v2 foundation covers the domain model, application/runtime
  ports, deterministic test harness, strict codecs, exact bootstrap
  configuration and publication projection, database-root primitives, and the
  canonical first-slice schema. It now also includes pure Pi launch planning,
  the bounded native-bridge frame contract, and the content-addressed reviewed
  Pi extension generator. V2-004a adds production time/identifier sources and
  the exact schema-aware bootstrap foundation row projection. V2-004b adds
  atomic, idempotent foundation/audit publication with a fail-closed durable
  row ledger. V2-004c adds process-local connector/service trust, atomic local
  authentication evidence, and transaction-scoped live identity, grant,
  configuration-resource, and stable-reference reads. V2-008a adds the closed,
  versioned local request/response/event protocol object codecs, including
  bounded canonical image transfer and authority-injection rejection, plus the
  strict LF-terminated JSONL wire framing. V2-008b adds the owner-only Unix
  socket lifecycle: canonical run-directory and socket identity validation,
  proven-stale recovery, bounded concurrent connections, authenticated
  one-request framing with LF-terminator detection, an optional absolute
  request deadline, and bounded idempotent shutdown. V2-009A adds atomic
  private session creation: live identity revalidation, reference resolution,
  current-revision and first-slice policy selection, fixed-order
  configuration-use rechecks, exact SessionSpec pinning, private endpoint
  binding, and creation/denial audit in one transaction. V2-009B adds the
  private attachment staging store: a one-shot intake vault between the
  connector and the store, magic-byte MIME sniffing, sha256-hashed bounded
  private copies under the root-owned `attachments` directory, minted
  Attachment provenance, and exact finalization/rollback of staged blobs.
  Durable `private_blobs`/`attachments` rows are written by V2-009C Turn
  admission; orphan recovery claims remain with the startup-recovery slice.
- V2-009C adds Turn admission and cancellation intent: owner-scoped session
  resolution, binding/lifecycle recheck, exact idempotent replay by
  `(endpoint_id, idempotency_key)` with conflict fail-closed denial, pinned
  `max_queued_turns` capacity, immutable input snapshots plus durable
  attachment rows, resolved-model inference resolution, FIFO queue insertion
  and receipts, compare-and-remove queued cancellation with terminal
  response/delivery/audit, and active cancellation intent recorded on the
  runtime projection without touching worker authority.
- V2-008c and V2-014A are committed. The real two-process
  test covers bootstrap, `session create`, `prompt`, `turn show`, durable
  restart, text-Turn idempotency, one-active/three-queued FIFO capacity, and
  fail-closed production startup. The fake advances only the first FIFO head
  to `dispatching`; it writes no terminal result, delivery, assistant message,
  worker lease, or provider state.
- The V2-009C review follow-up is committed and
  hardens replay ordering, attachment authentication provenance, invalid-ID
  cancellation, system cancellation attribution, and queue timestamps.
- `npm run typecheck`, `npm run build`, and `npm run test:v2` pass against the
  current working tree. The v2 suite currently has 275 passing tests.
- V2-E01 is committed after two-pass independent review. The Pi sidecar
  receives an empty Bubblewrap network namespace, an exact three-entry
  environment, and a fixed
  loopback-to-pathname-UDS adapter; a host relay pins exact public DNS answers,
  admits only registered CONNECT authorities, verifies exact TLS ClientHello
  SNI before dialing numeric IPs or a pinned numeric-CONNECT operator proxy,
  and pairs with a locked redirect-denying fetch preload. Relay lifecycle,
  logical capacity, DNS deadlines, and one-use launch identity are explicit.
  The real namespace capability test passes on this Linux host. Runtime Gate E
  is committed as the containment boundary; V2-006B/V2-010B still own its
  verified production composition.
- V2-006A2 is independently reviewed and committed. The deterministic Pi
  sidecar now has an exact Pi/package/bridge manifest, a single frozen catalog
  whose bridge digest covers the complete model policy, regenerated A1
  artifact verification, a provider-scoped credential store with read-only
  API keys and a V2-011-owned resource-wide atomic OAuth update port, and a
  model-aware trusted invoke seam behind a non-forgeable E01 fetch-boundary
  proof.
- V2-006A3 is independently reviewed and committed. The trusted invoke seam
  now maps the actual Pi 0.82 native event lifecycle into bounded A1 frames,
  applies the effective first-slice output cap, validates cumulative content
  and terminal digests, observes atomic OAuth replacement without exposing
  credentials, forces zero retries and SSE, rejects process-local replay
  before native execution, and implements exact cancellation and iterator
  cleanup without leaking provider errors. V2-006B still owns trusted
  filesystem artifacts and production process integration and is now ready.

## Status legend

| State | Meaning |
| --- | --- |
| Committed | Implemented, reviewed, verified, and present in Git history |
| Review candidate | Present only in the working tree; must be reviewed and committed independently |
| Ready | Dependencies are available and work may begin |
| Waiting | A normal implementation dependency is incomplete |
| Blocked | A named decision or security gate prevents a secure completion claim |

## Committed foundation

| Task | State | Evidence |
| --- | --- | --- |
| V2-001A — executable first-slice records | Committed | `206c547` |
| V2-001B1 — application commands and atomic units of work | Committed | `8c623eb` |
| V2-001B2 — external runtime and storage ports | Committed | `064861e` |
| V2-001C — incremental acceptance harness | Committed | `5ed4fbc` |
| V2-002A — primitive and boundary codecs | Committed | `8d68c41` |
| V2-002B — exact first-slice configuration decoder | Committed | `a33dd20` |
| V2-002C — cross-record validation and publication projection | Committed | `b91b18a` |
| V2-003A — database-root and transaction primitives | Committed | `9b722ec` |
| V2-003B — canonical schema and initialization | Committed | `e42be93` |
| V2-004a — repository mappings, production clock, and cryptographic IDs | Committed | `886085d`, `ae3b7a6` |
| V2-004b — idempotent bootstrap publication and audit | Committed | `90c6c8b` |
| V2-004c — local authentication and live authorization reads | Committed | `aeba780`, `603e14d`, `8099425` |
| V2-005 — pure Pi launch/resource planning | Committed | `42eb481` |
| V2-006A1 — typed bridge frames and reviewed extension generator | Committed | `6a37464`, `b0fabd8` |
| V2-006A2 — deterministic sidecar, artifact, catalog, and credential store | Committed | `17e1419` |
| V2-006A3 — native event, OAuth, error, cancellation, retry, and replay matrix | Committed | `2c7e17c` |
| V2-008a — bounded private local protocol codecs | Committed | `6a9538d`, `7240b2c` |
| V2-008b — secure Unix socket lifecycle and authenticated framing | Committed | `6b6615e` |
| V2-009A — session creation and private binding | Committed | `8198b3f`, `b54e477` |
| V2-009B — attachment staging and private storage | Committed | `62f06f9`, `55ddf6d` |
| V2-009C — Turn admission, FIFO, idempotency, and cancellation intent | Committed | `b397ddc` |
| V2-009C review follow-up | Committed | `bf90bcf` |
| V2-008c — authenticated application dispatch | Committed | `b7b55b1` |
| V2-014A — development CLI walking skeleton | Committed | `7140382` |
| V2-E01 — production sidecar egress containment | Committed | `404e5a3` |

## Working-tree review candidates

| Candidate | State | Scope |
| --- | --- | --- |
| Multi-user agentic MVP plan consolidation | Review candidate | Canonical MVP boundary and deferrals, documentation hierarchy, consolidated V2-M01–M07 mapping, live status/order, and superseded single-owner marker; no runtime code |

Passing deterministic tests remains necessary but does not by itself move
future work to `Committed`; each bounded substep still requires review,
verification, and its own commit.

## Remaining task inventory

| Task | State | Next dependency or gate |
| --- | --- | --- |
| V2-M01 — multi-principal contract and schema | Ready | Next assignment; revise singleton executable boundaries before schema freeze |
| V2-M02 — mTLS ingress and local administration | Waiting | V2-M01 certificate-binding and principal contracts |
| V2-M03 — multi-user application enforcement | Waiting | V2-M01 and V2-M02 trusted authentication context |
| V2-M04 — minimal Pi driver and ephemeral sandbox | Ready | Pure driver/mount work may proceed without singleton-owner assumptions |
| V2-M05 — sidecar, one-shot broker, and launch composition | Waiting | V2-M01, V2-M04, V2-006B, and the committed E01/V2-006A foundation |
| V2-M06 — thin coordinator and durable query | Waiting | V2-M03 through V2-M05 |
| V2-M07 — production composition and private-alpha gate | Waiting | V2-M01 through V2-M06 |
| V2-006B — verified production artifact and sidecar integration | Ready | Consumed by V2-M05; V2-E01 and V2-006A are committed |
| Original full V2-011 through V2-015 breadth | Deferred | Reduced MVP subsets are owned by V2-M05 through V2-M07; see the canonical deferral list |

## Reviewed execution order

The dependency graph in the implementation plan remains useful, but delivery
should expose integration problems earlier than the original wave ordering.

1. The CLI walking skeleton is implemented and committed in independently
   bounded steps:

   ```text
   V2-004a -> V2-004b -> V2-004c
     -> V2-008a -> V2-008b
     -> V2-009A -> V2-009B -> V2-009C
     -> V2-008c -> V2-014A
     -> two-process restart/idempotency/FIFO verification
   ```

   V2-004a includes the production `Clock` and cryptographic `IdSource`.
   V2-014A owns trusted startup configuration, daemon shutdown, the CLI
   process, and the explicitly development-only no-op coordinator. The whole
   chain is committed and passing its two-process test.
2. V2-E01 is independently reviewed, verified, and committed in `404e5a3`.
   Its runtime proofs are now available to V2-006B/V2-010B; those integrations
   remain required before a secure production sidecar/runtime claim.
3. The walking skeleton target is:

   ```text
   CLI client
     -> private local protocol
     -> bootstrap and authentication
     -> session creation
     -> Turn admission
     -> test-owned deterministic no-op coordinator
     -> durable receipt and nonterminal query projection
   ```

   This checkpoint validates protocol composition, bootstrap/admission
   transactions, and application ports. It is not a secure production-runtime
   claim.
   The gate requires separate daemon and CLI processes over the real private
   socket and SQLite; bootstrap, `session create`, `prompt`, and `turn show`;
   durable restart, origin-scoped idempotency, and one-active/three-queued FIFO
   behavior; rejection of unsafe roots and oversized/malformed frames; and no
   caller-selected principal, origin, `SessionSpec`, or authorization result.
   The fake writes neither terminal/delivery state nor an assistant response.
4. Complete V2-M01 before schema freeze: multiple active human principals,
   certificate identity bindings, `admin`/`member`, private owner-only
   endpoints, fixed per-principal workspaces, and execution capacity.
5. Complete V2-M02 and V2-M03: private-network mTLS ingress, local-only user
   administration, and cross-principal application enforcement. No runtime is
   connected until the two-principal denial matrix passes.
6. Complete V2-M04 and V2-M05: the minimal Pi driver, one fresh bounded
   Bubblewrap worker per Turn, verified E01 sidecar, one-shot broker authority,
   and secure launch composition.
7. Complete V2-M06: claim, execute, cancel, terminalize, fail closed on
   uncertain active work, and expose only owner-authorized polling through
   `turn show`.
8. Complete V2-M07: production mTLS composition, focused security/operational
   verification, private-alpha guidance, and one opt-in real-provider smoke.

## Acceptance status

The existing deterministic registry still records partial foundation coverage
for 16 of the original 21 single-owner scenarios, and the current suite remains
required. It does not define completion of the revised MVP.

V2-M01 must add a focused multi-user acceptance registry or update the existing
one without falsely marking historical cases complete. The canonical MVP gate
requires certificate-to-principal integrity, cross-principal denial,
content-blind administration, live revocation, workspace/sandbox isolation,
resource ceilings, one-shot provider invocation, cleanup, uncertain-send
non-replay, and one two-principal end-to-end sandboxed agent Turn. Exhaustive
crash permutations, provider/OS breadth, soak/load work, and the complete
original 21-scenario matrix are explicitly deferred.

A green `npm run test:v2` verifies the implemented foundation; it does not mean
that the multi-user MVP is accepted.

## Open implementation decisions

| Decision | Required outcome |
| --- | --- |
| Production sidecar egress | Resolved and committed in `404e5a3`; [`v2-sidecar-egress-adr.md`](./v2-sidecar-egress-adr.md) defines the empty sidecar network namespace, fixed pathname-UDS CONNECT relay, exact SNI, locked redirect seam, and downstream composition obligations |
| Multi-user schema pivot | V2-M01 removes the single-active-human executable constraint before schema freeze and adds certificate-bound principals, private owner-only endpoints, fixed workspaces, and per-principal capacity in one installation |
| Pi artifact coexistence | V1's verified Pi 0.80.10 and v2's pinned Pi 0.82.0 use explicit trusted artifact roots rather than one ambiguous `PATH` installation |
| SQLite runtime support | Either pin and continuously test the accepted Node 24 `DatabaseSync` runtime or replace it before production if its experimental behavior is unacceptable |
| Remote authentication | Resolved for the MVP as Hitch-validated mTLS client certificates over an operator-controlled private network; OIDC, public exposure, signup, invitations, and reverse-proxy identity headers are deferred |
| User administration | Resolved as local administrator-only create/disable and certificate bind/revoke commands; no remote administration or management UI |
| Session audience | Resolved as private owner-only sessions and Turns; sharing, delegation, teams, groups, and cross-principal context are rejected |
| Agent surface | Resolved as a fresh Bubblewrap worker per Turn with `read`, `write`, `edit`, and `ls` inside one fixed principal workspace; shell, worker networking, MCP, packages, ambient discovery, and user extensions are rejected |
| Runtime recovery | Resolved for the MVP as no worker reuse, resume, automatic provider retry, or heuristic replay; possibly submitted or active work after interruption becomes explicit `unknown/worker-lost` |
| Result delivery | Resolved for the MVP as owner-authorized `turn show` polling; attached streaming and independent push delivery are deferred |
| Grant re-issuance lifecycle | Resolved for the first slice: configuration-use grant replacement is an operator transaction that deletes the revoked row and inserts its successor together; `readConfigurationUse` intentionally hard-fails on active-plus-revoked ambiguity, and out-of-band revocation intentionally conflicts with the next bootstrap publication's digest check. A grant-management service redesigns this post-slice |
| MVP configuration cardinality | One installation, multiple active humans, one provider connection/model, fixed policy/profile revisions, one workspace root per principal, one worker per principal, three pending Turns per principal, and one operator-wide concurrency ceiling |
| Publication provenance depth | Resolved under the trusted-local-DB threat model: `assertPublishedRow` proves PK-existence plus bootstrap audit chain, not current row content; content drift is detected fail-closed at re-publication, mutable state columns remain the intended revocation channel, and launch-time integrity verification (V2-010) owns artifact/grant digest enforcement |
| Attachment durability ordering | Resolved for the first slice: a returned stage is durable (file and directory fsynced) before the Turn-admission transaction may commit rows referencing it; finalization promotes via no-clobber `linkSync` and verifies content on every repeat/crash-window path; startup recovery must treat "rows plus final file, no stage" as idempotent success |
| Connector-declared attachment MIME | Deferred: staging derives MIME solely from sealed bytes today, so the port's `mime-content-mismatch` reason is unreachable; it is reserved for a future connector-declared MIME the store would verify against the sniffed type |
| First-slice response delivery parameters | Resolved pending a published delivery policy: cancelled-turn deliveries use pinned `maximum_attempts = 3` and a 300-second deadline (`FIRST_SLICE_RESPONSE_DELIVERY`); a future delivery-policy record replaces the constants |
| Cancellation intent idempotency | Resolved: repeating active cancellation against an already-cancelling Turn returns `not-active` (intent already recorded), and queued cancellation of a terminal-cancelled Turn returns `already-cancelled`; neither emits duplicate audit |
| Idempotency-key or origin-message conflict | Resolved fail-closed: reusing an idempotency key with different content, or an origin message with a different key, is denied without new state or audit (no conflict variant exists on the admission result union) |
| Production attachments | Deferred from the MVP; committed local staging remains foundation code, while remote production submission accepts text only |

## MVP completion gate

The private multi-user agentic MVP is complete only when:

- at least two certificate-bound principals operate in one canonical Hitch
  installation and cannot cross identity, session, Turn, workspace, result, or
  runtime boundaries;
- each principal can execute a text Turn through a fresh denied-network
  Bubblewrap Pi worker against only that principal's fixed workspace;
- one verified credential-isolated sidecar invocation produces a durable
  terminal result retrievable only by the owner after disconnect;
- revocation, capacity denial, cancellation, cleanup, uncertain submission,
  restart non-replay, and the cross-principal matrix pass focused deterministic
  tests;
- production startup rejects incomplete mTLS, schema, artifact, egress,
  workspace, credential, and resource-limit configuration; and
- every required slice is reviewed and committed, the existing suite remains
  green, and operator guidance matches the executable private-alpha boundary.

## Product follow-up

After the MVP is exercised by a small trusted population, evidence decides
whether the next milestone is richer single-user agent behavior, OIDC/public
access, durable recovery/delivery, user-managed credentials, or collaboration.
None is silently part of this MVP. The explicit deferral list in
[`v2-multi-user-agentic-mvp.md`](./v2-multi-user-agentic-mvp.md) controls.

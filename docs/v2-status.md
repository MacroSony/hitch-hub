# Hitch v2 implementation status

Date: 2026-08-03

Status: active source of truth for v2 task state, execution order, and blockers

The accepted product boundary remains
[`v2-first-slice.md`](./v2-first-slice.md). Task definitions and detailed
dependencies remain in
[`v2-implementation-plan.md`](./v2-implementation-plan.md). This file records
what is actually committed, what exists only in the working tree, what should
happen next, and what is blocked.

## Current snapshot

- V1 is a frozen maintenance baseline. It remains the only production-capable
  user-facing Hitch system.
- V2 now has a committed, explicitly development-only walking skeleton:
  trusted startup configuration, `src/v2/main.ts`, a separate structured CLI,
  the real owner-private socket, bootstrap/authentication, session creation,
  Turn admission, private image staging, a no-op FIFO claim, and authorized
  nonterminal `turn show`. Production `serve` remains fail-closed until
  V2-014B; there is still no Pi driver, secure supervisor/broker composition,
  terminal coordinator, recovery, or delivery worker.
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
  current branch. The v2 suite currently has 220 passing tests.
- Production sidecar egress containment, Runtime Gate E, is unresolved. The
  feasibility spike's in-process network guard is not production containment.

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
| V2-008a — bounded private local protocol codecs | Committed | `6a9538d`, `7240b2c` |
| V2-008b — secure Unix socket lifecycle and authenticated framing | Committed | `6b6615e` |
| V2-009A — session creation and private binding | Committed | `8198b3f`, `b54e477` |
| V2-009B — attachment staging and private storage | Committed | `62f06f9`, `55ddf6d` |
| V2-009C — Turn admission, FIFO, idempotency, and cancellation intent | Committed | `b397ddc` |
| V2-009C review follow-up | Committed | `bf90bcf` |
| V2-008c — authenticated application dispatch | Committed | `b7b55b1` |
| V2-014A — development CLI walking skeleton | Committed | `7140382` |

## Working-tree review candidates

None. Passing deterministic tests remains necessary but does not by itself
move future work to `Committed`; each bounded substep still requires review,
verification, and its own commit.

## Remaining task inventory

| Task | State | Next dependency or gate |
| --- | --- | --- |
| V2-E01 — production sidecar egress | Ready, current security-critical task | Walking skeleton is exercised; accepted ADR and adversarial containment tests are required |
| V2-006A2 — deterministic sidecar, artifact, catalog, and credential store | Ready | V2-006A1 is committed |
| V2-006A3 — native event, OAuth, error, cancellation, retry, and replay matrix | Waiting | V2-006A2 |
| V2-006B — production artifact and sidecar integration | Blocked | V2-E01 plus V2-006A |
| V2-007 — Pi RPC driver | Ready | V2-001B2 and V2-002A are committed |
| V2-008c — local connector/application dispatch adapter | Committed | `b7b55b1` |
| V2-014A — first-slice CLI shell over the local socket | Committed | `7140382` |
| V2-010A1 — mount verification and Bubblewrap rendering | Ready | V2-003B and V2-005 are committed |
| V2-010A2 — worker lifecycle, fencing, quarantine, and cleanup | Waiting | V2-010A1 |
| V2-010B — secure worker/sidecar launch composition | Blocked | V2-E01, V2-006B, V2-010A, and broker readiness |
| V2-011A–C — credential broker and forward-once reservations | Blocked | V2-E01, V2-004, V2-006B, V2-009, and V2-010A |
| V2-012A–D — Turn coordinator, event materialization, and recovery | Waiting | Driver, supervisor, broker, and application repositories |
| V2-013 — independent delivery and result query | Waiting | V2-012 terminalization/outbox |
| V2-014B — production service composition and complete CLI | Waiting | V2-010B through V2-013 |
| V2-015 — complete acceptance and fault-injection matrix | Waiting | Every task contributes cases; final claim follows V2-014B |

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
2. Begin V2-E01 independently and do not make a secure sidecar/runtime claim
   until its ADR and adversarial tests pass.
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
4. Complete V2-006A2/A3, V2-007, and V2-010A while Runtime Gate E is being
   resolved.
5. Complete V2-006B, V2-011, and V2-010B only after E01 fixes the production
   sidecar topology and containment boundary.
6. Integrate V2-012, then V2-013 and V2-014B.
7. Complete V2-015 and make the full acceptance command fail until all 21
   scenarios are explicitly accepted.

## Acceptance status

The deterministic suite has registered partial cases for 16 of 21 scenario
IDs:

`V2-S01`–`V2-S07`, `V2-S09`, `V2-S10`, `V2-S12`–`V2-S15`, and
`V2-S18`–`V2-S20`.

The following scenarios have no registered implementation case yet:

`V2-S08`, `V2-S11`, `V2-S16`, `V2-S17`, and `V2-S21`.

All registered scenarios remain `in-progress` by design. A green
`npm run test:v2` verifies the implemented foundation; it does not mean that
the first slice is accepted.

## Open implementation decisions

| Decision | Required outcome |
| --- | --- |
| Production sidecar egress | V2-E01 selects one enforceable process/network topology and proves origin, redirect, proxy, DNS, and private-address denial |
| First schema validation | Keep the committed pre-release schema revisable until the walking skeleton and repository/coordinator integration validate it |
| Pi artifact coexistence | V1's verified Pi 0.80.10 and v2's pinned Pi 0.82.0 use explicit trusted artifact roots rather than one ambiguous `PATH` installation |
| SQLite runtime support | Either pin and continuously test the accepted Node 24 `DatabaseSync` runtime or replace it before production if its experimental behavior is unacceptable |
| Post-slice product path | Select the first chat connector and define minimum v1 parity plus retirement/coexistence criteria |
| Grant re-issuance lifecycle | Resolved for the first slice: configuration-use grant replacement is an operator transaction that deletes the revoked row and inserts its successor together; `readConfigurationUse` intentionally hard-fails on active-plus-revoked ambiguity, and out-of-band revocation intentionally conflicts with the next bootstrap publication's digest check. A grant-management service redesigns this post-slice |
| First-slice configuration cardinality | Resolved as intended posture: exactly one installation, active principal, execution/turn policy, profile provider allowance, and per-provider credential binding are hard integrity requirements (schema-enforced or session-creation-enforced) until multi-policy/multi-provider support arrives as one deliberate schema-plus-command package |
| Publication provenance depth | Resolved under the trusted-local-DB threat model: `assertPublishedRow` proves PK-existence plus bootstrap audit chain, not current row content; content drift is detected fail-closed at re-publication, mutable state columns remain the intended revocation channel, and launch-time integrity verification (V2-010) owns artifact/grant digest enforcement |
| Attachment durability ordering | Resolved for the first slice: a returned stage is durable (file and directory fsynced) before the Turn-admission transaction may commit rows referencing it; finalization promotes via no-clobber `linkSync` and verifies content on every repeat/crash-window path; startup recovery must treat "rows plus final file, no stage" as idempotent success |
| Connector-declared attachment MIME | Deferred: staging derives MIME solely from sealed bytes today, so the port's `mime-content-mismatch` reason is unreachable; it is reserved for a future connector-declared MIME the store would verify against the sniffed type |
| First-slice response delivery parameters | Resolved pending a published delivery policy: cancelled-turn deliveries use pinned `maximum_attempts = 3` and a 300-second deadline (`FIRST_SLICE_RESPONSE_DELIVERY`); a future delivery-policy record replaces the constants |
| Cancellation intent idempotency | Resolved: repeating active cancellation against an already-cancelling Turn returns `not-active` (intent already recorded), and queued cancellation of a terminal-cancelled Turn returns `already-cancelled`; neither emits duplicate audit |
| Idempotency-key or origin-message conflict | Resolved fail-closed: reusing an idempotency key with different content, or an origin message with a different key, is denied without new state or audit (no conflict variant exists on the admission result union) |
| Image-bearing CLI retry identity | Open before production: a fresh image stage mints a fresh Attachment ID, so an after-restart retry cannot yet reproduce the exact admitted attachment identity even when bytes and idempotency key match; V2-014A proves restart-idempotency for text Turns and first-submission image durability, while a stable pre-admission replay resolution is still required for image retries |

## First-slice completion gate

The first slice is complete only when:

- the production CLI can execute the full accepted local private-session path;
- E01 containment, artifact verification, Bubblewrap, credential brokerage,
  forwarding uniqueness, cancellation, recovery, and delivery all pass their
  deterministic adversarial tests;
- all 21 acceptance scenarios are explicitly complete, with real provider
  smokes remaining opt-in;
- no required implementation exists only as unreviewed working-tree files;
- the schema is frozen only after the end-to-end walking skeleton and
  repository/coordinator integration validate it; and
- the documentation map, this tracker, and current operator guidance agree.

## Product follow-up

The first slice proves the local architecture; it is not yet the chat-native
product replacement. The next product milestone must select one existing chat
connector, define the minimum v1 parity required for it, and establish explicit
v1 retirement or coexistence criteria. That follow-up remains outside the
accepted first-slice scope.

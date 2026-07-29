# Hitch v2 implementation status

Date: 2026-07-29

Status: active source of truth for v2 task state, execution order, and blockers

The accepted product boundary remains
[`v2-first-slice.md`](./v2-first-slice.md). Task definitions and detailed
dependencies remain in
[`v2-implementation-plan.md`](./v2-implementation-plan.md). This file records
what is actually committed, what exists only in the working tree, what should
happen next, and what is blocked.

## Current snapshot

- V1 is a frozen maintenance baseline. It remains the only executable
  user-facing Hitch system.
- V2 has no executable service path yet. There is no v2 application service,
  local connector, Pi driver, supervisor, broker, delivery worker, CLI, or
  `main.ts`.
- The committed v2 foundation covers the domain model, application/runtime
  ports, deterministic test harness, strict codecs, exact bootstrap
  configuration and publication projection, database-root primitives, and the
  canonical first-slice schema. It now also includes pure Pi launch planning,
  the bounded native-bridge frame contract, and the content-addressed reviewed
  Pi extension generator.
- There are no uncommitted v2 review candidates.
- `npm run typecheck` and `npm run test:v2` pass against the current committed
  source plus this status reconciliation. The v2 suite currently has 135
  passing tests.
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
| V2-005 — pure Pi launch/resource planning | Committed | `42eb481` |
| V2-006A1 — typed bridge frames and reviewed extension generator | Committed | `6a37464`, `b0fabd8` |

## Working-tree review candidates

None. Passing deterministic tests remains necessary but does not by itself
move future work to `Committed`; each bounded substep still requires review,
verification, and its own commit.

## Remaining task inventory

| Task | State | Next dependency or gate |
| --- | --- | --- |
| V2-E01 — production sidecar egress | Ready, security-critical | Start now; accepted ADR and adversarial containment tests are required |
| V2-004a — repository mappings, production clock, and cryptographic IDs | Ready, current | V2-003B is committed |
| V2-004b — idempotent bootstrap publication and audit | Waiting | V2-004a |
| V2-004c — local authentication and live authorization reads | Waiting | V2-004b |
| V2-006A2 — deterministic sidecar, artifact, catalog, and credential store | Ready | V2-006A1 is committed |
| V2-006A3 — native event, OAuth, error, cancellation, retry, and replay matrix | Waiting | V2-006A2 |
| V2-006B — production artifact and sidecar integration | Blocked | V2-E01 plus V2-006A |
| V2-007 — Pi RPC driver | Ready | V2-001B2 and V2-002A are committed |
| V2-008a — bounded private local protocol codecs | Waiting | V2-004c application inputs |
| V2-008b — secure Unix socket lifecycle and authenticated framing | Waiting | V2-004c identity binding |
| V2-008c — local connector/application dispatch adapter | Waiting | V2-009 application services |
| V2-009A — session creation and private binding | Waiting | V2-004c authorization and V2-008a command shapes |
| V2-009B — attachment staging and private storage | Waiting | V2-003B and storage ports |
| V2-009C — Turn admission, FIFO, idempotency, and cancellation intent | Waiting | V2-009A/B |
| V2-010A1 — mount verification and Bubblewrap rendering | Ready | V2-003B and V2-005 are committed |
| V2-010A2 — worker lifecycle, fencing, quarantine, and cleanup | Waiting | V2-010A1 |
| V2-010B — secure worker/sidecar launch composition | Blocked | V2-E01, V2-006B, V2-010A, and broker readiness |
| V2-011A–C — credential broker and forward-once reservations | Blocked | V2-E01, V2-004, V2-006B, V2-009, and V2-010A |
| V2-012A–D — Turn coordinator, event materialization, and recovery | Waiting | Driver, supervisor, broker, and application repositories |
| V2-013 — independent delivery and result query | Waiting | V2-012 terminalization/outbox |
| V2-014A — structured local protocol and CLI shell | Waiting | V2-008 and the session/Turn application seam |
| V2-014B — production service composition and complete CLI | Waiting | V2-010B through V2-013 |
| V2-015 — complete acceptance and fault-injection matrix | Waiting | Every task contributes cases; final claim follows V2-014B |

## Reviewed execution order

The dependency graph in the implementation plan remains useful, but delivery
should expose integration problems earlier than the original wave ordering.

1. Implement the CLI walking skeleton in independently reviewed commits:

   ```text
   V2-004a -> V2-004b -> V2-004c
     -> V2-008a -> V2-008b
     -> V2-009A -> V2-009B -> V2-009C
     -> V2-008c -> V2-014A
     -> two-process restart/idempotency/FIFO verification
   ```

   V2-004a includes the missing production `Clock` and cryptographic
   `IdSource`. V2-014A owns trusted startup configuration, daemon shutdown, the
   CLI process, and an explicitly test/development-only no-op coordinator.
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

The deterministic suite has registered partial cases for 11 of 21 scenario
IDs:

`V2-S01`, `V2-S07`, `V2-S09`, `V2-S10`, `V2-S12`, `V2-S13`, `V2-S14`,
`V2-S15`, `V2-S18`, `V2-S19`, and `V2-S20`.

The following scenarios have no registered implementation case yet:

`V2-S02`–`V2-S06`, `V2-S08`, `V2-S11`, `V2-S16`, `V2-S17`, and `V2-S21`.

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

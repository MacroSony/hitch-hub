# Hitch documentation map

This directory separates current product behavior, active implementation
status, accepted design contracts, and historical context. A document's role
matters when two files appear to disagree.

## Source-of-truth order

1. [`../README.md`](../README.md) describes the current v1 user-facing
   behavior and operating commands.
2. [`v2-status.md`](./v2-status.md) is the authoritative v2 task status,
   execution order, and blocker tracker.
3. [`v2-multi-user-agentic-mvp.md`](./v2-multi-user-agentic-mvp.md) is the
   accepted v2 product scope, explicit deferral list, and MVP completion
   boundary.
4. [`v2-implementation-plan.md`](./v2-implementation-plan.md) defines task
   ownership, dependencies, and completion criteria. It is a task catalog, not
   a live status board.
5. [`v2-first-slice.md`](./v2-first-slice.md) preserves the superseded
   single-owner product boundary that produced the committed walking-skeleton
   foundation.
6. The accepted design documents define component contracts and security
   invariants. They do not establish current implementation progress.

When status or ordering text elsewhere is stale, `v2-status.md` wins. When a
proposed implementation widens or contradicts the MVP,
`v2-multi-user-agentic-mvp.md` wins.

## Current documents

| Document | Role |
| --- | --- |
| [`v2-status.md`](./v2-status.md) | Active v2 status, reviewed order, blockers, and acceptance progress |
| [`v2-multi-user-agentic-mvp.md`](./v2-multi-user-agentic-mvp.md) | Canonical single-install multi-user agentic MVP scope, consolidated sequence, deferrals, and completion gate |
| [`v2-implementation-plan.md`](./v2-implementation-plan.md) | Detailed task ownership catalog, interpreted through the consolidated MVP sequence |
| [`v2-first-slice.md`](./v2-first-slice.md) | Superseded single-owner scope retained as committed-foundation history |
| [`v2-walking-skeleton.md`](./v2-walking-skeleton.md) | Development-only V2-014A daemon/CLI operator guide and limitations |
| [`v2-sidecar-egress-adr.md`](./v2-sidecar-egress-adr.md) | V2-E01 production Pi sidecar network topology, DNS, proxy, and redirect decision |
| [`../implementation_steps.md`](../implementation_steps.md) | Remaining v1 maintenance and attended-rollout checklist |
| [`completed-work.md`](./completed-work.md) | Dated v1 implementation and verification archive |

## Accepted v2 design contracts

| Document | Subject |
| --- | --- |
| [`v2-turn-policy-design.md`](./v2-turn-policy-design.md) | Turn admission, dispatch, interaction, cancellation, recovery, and delivery semantics |
| [`v2-execution-security-design.md`](./v2-execution-security-design.md) | Trust boundary, credential broker, live authorization, and launch authority |
| [`v2-agent-runtime-provider-design.md`](./v2-agent-runtime-provider-design.md) | Agent driver, Pi runtime, native sidecar, and inference transport |
| [`v2-deferred-design.md`](./v2-deferred-design.md) | Deliberately excluded future behavior |
| [`hub-tools-mcp.md`](./hub-tools-mcp.md) | V1 hub-tool/MCP design and implemented media-tool direction |

## Historical context

These files are useful background but do not control current implementation
order:

| Document | Historical role |
| --- | --- |
| [`../plan.md`](../plan.md) | Original broad product and v1 architecture roadmap |
| [`security-sandbox-automation-roadmap.md`](./security-sandbox-automation-roadmap.md) | V1 security, sandbox, trigger, and scheduling roadmap |
| [`v2-design-roadmap.md`](./v2-design-roadmap.md) | Pre-implementation v2 design-gate checklist |
| [`v2-acp-cli-discussion.md`](./v2-acp-cli-discussion.md) | Archived ACP/CLI architecture discussion |
| [`../spikes/pi-native-sidecar/README.md`](../spikes/pi-native-sidecar/README.md) | Completed feasibility-spike evidence and its deliberate limits |

## Maintenance rules

- Record live task state only in `v2-status.md`.
- Keep task completion criteria in `v2-implementation-plan.md`.
- Keep design documents descriptive; link to the status tracker instead of
  embedding progress claims that will age.
- Treat `completed-work.md` and rollout notes as dated evidence, not proof of a
  deployment's current configuration.
- Update this map when a document changes role or a new authoritative document
  is added.

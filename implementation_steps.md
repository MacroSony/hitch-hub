# Implementation Steps

This file is the short active tracker. Completed checkpoint history lives in
[docs/completed-work.md](docs/completed-work.md), the outbound media/tool design lives in
[docs/hub-tools-mcp.md](docs/hub-tools-mcp.md), and the focused roadmap recording the completed
principal/state/Bubblewrap foundation plus the planned dispatch, trigger, safety-gate, and scheduling work lives
in [docs/security-sandbox-automation-roadmap.md](docs/security-sandbox-automation-roadmap.md).

For the broad architecture roadmap, see [plan.md](plan.md). For the current user-facing surface, see
[README.md](README.md).

Status legend:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs a decision

## Current Direction

The reliability, durable delivery, principal ownership, private runtime state, and Linux Bubblewrap milestones are implemented. Remote Pi sessions now default to required sandboxing, while explicit direct execution remains an unsafe configuration-only mode.

The next production change should extract one internal session-dispatch path before adding triggers or schedules. Chat handling already has the semantics that unattended work will need; those semantics should be centralized instead of duplicated.

## Next Iteration: Unified Session Dispatch

Goal: make chat and future trigger producers call one owned, re-authorized prompt runner without changing current chat behavior.

Checklist:

- [ ] Define a typed `runSessionPrompt` request/result contract carrying authenticated producer context, session ID, text/attachments, origin/delivery context, and idempotency metadata. A caller-supplied principal ID must never constitute authorization.
- [ ] Move immutable session-owner verification, current-authority checks, active-turn ownership, worker start/reuse, timeout/cancellation, event consumption, delivery correlation, and audit correlation behind that contract.
- [ ] Revalidate the persisted execution-policy/mount snapshot at dispatch; do not silently replace it with current defaults.
- [ ] Keep chat commands and interactive approvals on the existing surface while routing ordinary prompts through the service.
- [ ] Preserve the current reject-while-busy behavior for chat; do not design trigger queue semantics inside this refactor.
- [ ] Add equivalence tests proving chat prompts retain final text, tool/media delivery, timeout recovery, and per-principal sandbox selection.
- [ ] Only after this boundary is stable, design the durable trigger inbox and its `skip`/`queue-one`/`replace` policy.
- [ ] Keep unattended producers and schedules disabled until CPU/memory/PID, temporary-storage/output, credentials/network, and unattended-extension safeguards have explicit enforced limits or an approved fail-closed profile.

## Completed Iteration: Sandbox and Multi-User Foundation

Goal: make principal ownership and filesystem boundaries enforceable before expanding unattended or shared use.

- [x] Define execution policies, principals, authorization contexts, mount plans, and explicit unsafe direct mode.
- [x] Resolve Telegram/WeChat identities to one principal and persist private session ownership.
- [x] Canonicalize principal roots and reject symlink/path escape.
- [x] Persist private per-principal Pi config/session state and per-session worker/tool state.
- [x] Replace worker environment inheritance with a small allowlist and block channel credentials/host-control variables.
- [x] Add Direct and Bubblewrap launchers with fail-closed selection and exact mount reconstruction.
- [x] Translate execution-policy tools into Hitch-owned Pi flags and keep `bash` consistent with the process capability.
- [x] Under Bubblewrap, support a read-only system Pi config for exactly one principal; require Hitch-scoped config for multiple principals.
- [x] Hide Hitch data beneath a workspace with persisted tmpfs masks through both workspace aliases.
- [x] Preserve the sandboxed `hitch.send_media` bridge and explicit writable media export mounts.
- [x] Verify installed Pi extensions, descendant cleanup, unsafe-policy tightening, and two-principal route/mount isolation.

Rollout note (2026-07-16): the implementation is committed but the live WeChat process was intentionally not restarted. Existing sessions with old direct or unmasked mount metadata will be quarantined and should be recreated on the first sandboxed restart.

## Completed Iteration: Runtime Reliability

Goal: prevent channel delivery failures or stale agent streams from leaving a session indefinitely marked as running.

Checklist:

- [x] Make `agent_turn_timeout_ms` an authoritative wall-clock deadline even when Pi does not close its event stream.
- [x] Move outbound text onto an ordered per-target delivery queue with bounded send attempts.
- [x] Apply the same bounded send deadline to explicit media delivery.
- [x] Give every active session turn an in-memory owner/turn ID so late events and overlapping prompts cannot mutate a newer turn.
- [x] Expand `!status` with active-turn age/deadline, worker liveness, delivery queue health, and channel receive health.
- [x] Persist text delivery successes/failures in the audit log.
- [x] Add a regression flow covering an ignored abort, a send client that ignores cancellation, an overlapping prompt, a late stale event, and recovery on a new turn.
- [x] Run live WeChat failure/recovery verification; after the 2026-07-12 restart, 85/85 audited text deliveries succeeded across 31 turns, with bounded recovery after four turn deadlines.
- [x] Put text and media on one per-target delivery queue so mixed WeChat bursts cannot race through separate outer queues.
- [x] Start send deadlines when an item reaches the front of the queue instead of consuming its budget while waiting.
- [x] Add configurable WeChat send pacing, failure cooldown, and failure-only tool status delivery for lower-volume live usage.
- [x] Fail the remainder of a broken WeChat batch quickly and reopen delivery on fresh inbound activity.
- [x] Preserve explicitly interrupted Pi output as a labeled partial result when it arrives during bounded deadline cancellation.
- [x] Stop and audit idle workers after a configurable timeout so inactive sessions do not retain Pi processes indefinitely.
- [x] Split turn/process audit semantics into `turn.*` and `worker.*` events and correlate text delivery with delivery/session/turn IDs.
- [x] Honor Pi's retry-aware RPC lifecycle: keep `agent_end` candidates private while `willRetry` is true and publish the final response only after `agent_settled`.
- [x] Replace the ambiguous `Pi completed.` fallback with explicit terminal errors or no partial body for an empty aborted turn.
- [x] Keep the agent media outbox pump alive for the worker lifetime so retry continuations and delayed MCP calls cannot be stranded between turn consumers.
- [x] Surface explicit `hitch.send_media` start/result status in failure-only mode and correlate artifact audit rows with their session/turn.
- [x] Add a retry/media regression using `error -> willRetry -> send_media -> successful agent_end -> agent_settled`.

## Completed Iteration: Operability and Delivery Evidence

Goal: turn the now-bounded runtime into a service that can explain, survive, and recover from live channel failures without relying on a tmux scrollback.

Recommended scope:

- [x] Add graceful `SIGINT`/`SIGTERM` shutdown so channel receive loops stop, active workers are aborted, queued audit writes drain, and restart state is deterministic.
- [x] Add a sample user-level systemd service with restart-on-failure and a documented health/startup check; keep tmux as a development option.
- [x] Audit channel-health transitions with de-duplication/rate limiting instead of logging every repeated poll error.
- [x] Give outbound text and media deliveries IDs and session/turn correlation; persist their full lifecycle (`queued`, `sending`, `sent`, `failed`, `expired`) so missing replies can be traced after the process exits.
- [x] Add `!health` diagnostics for channel state, delivery backlog, last inbound/send activity, process uptime, startup recovery, and recent failure counts.
- [x] Add deterministic WeChat/runtime tests for `ret=-2`, expired context tokens, queue expiry, polling recovery, and cancellation during CDN upload.
- [x] Add configurable terminal-delivery retention and size-bounded audit-log rotation before per-message delivery auditing is used continuously.

Rollout note (2026-07-15): commit `27ba1a0` is live in the tmux-managed WeChat hub for soak testing. The durable-ledger changes are intentionally being held for the next restart so the live test has one stable code boundary.

Exit criteria:

- A killed or crashed hub restarts automatically and reports a clear recovery state.
- Every accepted outbound message has a durable terminal delivery state or an explicit expiry.
- Repeated WeChat transport failures produce one useful health transition instead of an unbounded terminal-only error stream.
- An operator can distinguish agent, delivery, and channel failures without shell access.

## Previous Iteration: Minimal `send_media` Tool

Goal: replace implicit outbound-media path discovery with one explicit, blocking hub-owned media send operation.

Scope:

- Keep current Telegram, WeChat, Pi RPC, and smoke-test behavior working.
- Add an internal `HubToolService.sendMedia()` first; do not bind the core design to MCP internals.
- Expose one minimal media-send operation for agents and humans.
- Route delivery only to the current session/chat target; tools must not accept arbitrary chat IDs.
- Block until the channel upload succeeds, fails, or times out, then return a structured result.
- Make text path auto-discovery opt-in fallback behavior, not the primary outbound media mechanism.

Checklist:

- [x] Document completed implementation checkpoints separately.
- [x] Document explicit hub-tools/MCP design.
- [x] Add config for explicit outbound export roots, separate from broad `allowed_roots`.
- [x] Add a normalized `send_media` request/result model:
  - input: `path`, optional `caption`, optional `kind`
  - output: `status`, `deliveryId`, `platform`, optional `message`
- [x] Add internal `HubToolService.sendMedia()` validation:
  - realpath is inside an outbound export root or hub-managed artifact dir
  - file exists and is a regular file
  - MIME is sniffed instead of trusting extension alone
  - size is under `media.max_outbound_bytes`
  - human fallback routes only to the current chat target
  - delivery status is audited
- [x] Add user-visible failure reporting when artifact upload fails.
- [x] Add `!send <absolute-path>` as a human fallback using the same service.
- [x] Add an agent bridge for Pi:
  - preferred final shape: MCP `hitch.send_media`
  - interim option: local CLI/outbox shim authenticated to the active session
- [x] Add active session/turn scoping for agent-initiated media sends.
- [x] Add hub MCP transport exposing only the session-scoped `hitch.send_media` tool for the first MCP milestone.
- [x] Expose MCP prompt guidance through `hitch.outbound_media` so MCP-capable agents can learn when to call `hitch.send_media`.
- [ ] Add Pi-native MCP server list wiring when Pi exposes a stable MCP client configuration surface, or add a small Pi extension adapter if needed.
- [x] Gate current final-text path scanner behind `media.auto_discovery`.
- [x] Default auto-discovery to off.
- [x] Add smoke tests for:
  - explicit media send success
  - path outside export root rejected
  - oversized media skipped with user-visible failure
  - channel send failure audited and surfaced
  - auto-discovery disabled by default
  - MCP `hitch.send_media` outbox/result protocol
  - MCP `hitch.outbound_media` prompt discovery

## Open Decisions

- [!] MCP process shape: one hub MCP server with short-lived session tokens, or one per-session MCP server/process.
- [x] Transport for first bridge: session-scoped JSONL outbox and result file.
- [x] Agent-initiated `send_media` is processed by a session-scoped pump for the lifetime of the active worker.
- [!] Whether Pi will consume MCP prompts automatically from a native MCP server list, or whether Hitch needs a Pi extension adapter to fetch/apply the prompt.
- [!] Whether non-image file sends should be supported by the first `send_media` tool or require a stronger opt-in than images.

## Design Decision: Agent Config Ownership

Hitch defaults to principal-private Hitch-scoped agent configuration. A single-principal operator may explicitly select system-level configuration when preserving an existing local Pi identity is more important than writable config isolation. The product boundary is that Hitch is a remote control and session hub around local agents, not a replacement config/auth/plugin manager for those agents.

Default ownership:

- Hitch owns Telegram/WeChat credentials, chat/user authorization, allowed roots, default cwd, session lifecycle, approval routing, media caching, artifact delivery policy, and remote command handling.
- The agent owns provider auth, default model/provider selection, plugins, extensions, MCP servers, and other native agent preferences.
- Hitch may pass launch-time overrides such as `--model` or `--provider`, but should not permanently rewrite native agent configuration.

Config scope policy:

- Under sandboxed execution, `config_scope: system` mounts one explicitly resolved Pi config read-only while storing sessions privately under Hitch. It is appropriate for the current single-principal personal deployment and is rejected with multiple principals or `unsafe_allow_all`; unsafe direct execution does not enforce that read-only mount boundary.
- `config_scope: hitch` gives every principal separate writable Pi config/session directories. It is the required mode for multi-user operation, smoke tests, isolated bot profiles, and future controlled automation.
- Under sandboxed execution, neither mode exposes the full home directory. Provider environment variables remain opt-in through `env_allowlist`.

This keeps the mental model simple: Hitch is the transport, authorization, cwd, session, approval, media, and artifact-delivery layer; the selected agent remains the source of truth for agent-specific behavior.

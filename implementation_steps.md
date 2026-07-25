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

The reliability, durable delivery, principal ownership, private runtime state, Linux Bubblewrap, credential guard, and guarded native media milestones are implemented. The live single-principal profile is ready for a restricted workspace soak; explicit direct execution remains an unsafe configuration-only mode.

V1 is now a frozen maintenance baseline. Do not perform the previously planned
v1 unified-dispatch refactor or add triggers, schedules, channels, or backends to
it. The canonical v2 implementation scope is
[docs/v2-first-slice.md](docs/v2-first-slice.md), with the remaining design order
in [docs/v2-design-roadmap.md](docs/v2-design-roadmap.md).

The immediate v2 implementation gate is a focused Pi native-library sidecar
spike. It must prove that the exact pinned Pi `ModelRuntime` can reuse saved
provider auth, OAuth refresh, streaming, cancellation, and usage behind a
credential-free worker bridge with registered-origin egress. Hitch-authored
provider protocol adapters are now fallback transports rather than the default
implementation path.

## Immediate Rollout: Restricted Sandbox and Multi-User Preparation

- [~] The live systemd-managed WeChat profile now uses `credential_isolation: required`, one exact read/write workspace, no policy mounts or shell, and native `hitch_send_media`; a fresh chat-originated session and attended soak remain.
- [~] Automated real-provider acceptance verifies workspace create/read/edit/list, outside-path and symlink rejection, native media delivery, and post-media final text. Chat-originated abort, worker restart, and fresh-session behavior remain for the attended soak.
- [x] Attest the installed Pi path resolver against the credential guard at each guarded worker startup and fail closed on semantic drift; Pi 0.80.10 is the current verified baseline.
- [ ] Before adding a second principal, switch from `config_scope: system` to `config_scope: hitch`, keep `credential_isolation: required`, provision a distinct provider identity for each principal out of band, and create fresh sessions. Do not share the system Pi config or old transcripts across principals.
- [ ] Treat a shared provider key as an explicitly accepted boundary for the attended single-principal soak only. Require scoped/revocable per-principal credentials or a host-side provider broker before unattended execution; a broker is required before any claim that workers do not possess provider credentials.
- [ ] Keep group-shared sessions disabled until owner/admin/approval authority is designed and tested independently from private multi-user routing.

Rollout note (2026-07-19): the clean branch was published, CI and one aggregate `npm run check` path were added, and guarded startup now attests the installed Pi resolver (verified with Pi 0.80.10). The live WeChat hub moved from tmux to an enabled user service, survived a deliberate main-process `SIGKILL` with a five-second restart and zero interrupted deliveries, quarantined all owned pre-guard sessions, and returned to healthy. A private rollback copy of the pre-guard config, Hitch state, and system Pi config was verified before the transition. The restricted real-provider flow exercised `ls`, `write`, `read`, `edit`, and `hitch_send_media`, observed two blocked reads (`/agent-config` and a symlink escape), delivered the edited immutable artifact snapshot, and cleaned up its fixture. A fresh session created through WeChat is still required before the soak is complete.

## Completed Iteration: Credential and Guarded Media Containment

- [x] Add fail-closed `credential_isolation` policy validation and a private, read-only provisioned Pi guard runtime.
- [x] Disable caller-supplied extensions, skills, templates, themes, approval flags, shell/process tools, and command-backed credential values in required mode.
- [x] Restrict built-in file tools to the mounted workspace while matching Pi's `@`, tilde, `file://`, Unicode-space, and symlink path behavior.
- [x] Keep the Pi config writable for controller lock/state needs while blocking model tool access to `/agent-config`, `/agent-sessions`, `/state`, `/hitch`, `/proc`, and unmounted host paths.
- [x] Scope outbound agent media to the active mount plan and global export roots, send an immutable private snapshot, and remove it after channel delivery.
- [x] Add native guarded `hitch_send_media` with authenticated bridge startup attestation, sanitized results, and failure-only status visibility.
- [x] Reject guarded media startup without its session bridge and keep bridge variables out of guarded workers that do not enable media.
- [x] Add direct guard, real installed-Pi/Bubblewrap, media snapshot, retry/final-message, path-confusion, and credential-command regressions.

Residual boundary: provider credentials still exist in Pi's controller process/config mount. This containment prevents model-facing tools from reaching them; it does not replace a provider broker or protect against a compromised Pi/controller runtime.

## Superseded V1 Proposal: Unified Session Dispatch

Status: frozen; retained only as historical context. Its required semantics are
captured by the clean v2 Turn/application-service design instead of being added
to the v1 hub.

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
- [x] Under Bubblewrap, support a writable system Pi config for exactly one principal; require Hitch-scoped config for multiple principals.
- [x] Hide Hitch data beneath a workspace with persisted tmpfs masks through both workspace aliases.
- [x] Preserve the sandboxed `hitch.send_media` bridge and explicit writable media export mounts.
- [x] Verify installed Pi extensions, descendant cleanup, unsafe-policy tightening, and two-principal route/mount isolation.

Rollout note (updated 2026-07-16): the earlier live Bubblewrap acceptance used the installed Pi extensions and proved mount/process isolation, but that profile is superseded by required credential isolation. The new restricted profile deliberately disables those extensions, narrows the workspace to one exact cwd, exposes only guarded file/media tools, and requires a fresh Pi session for the next media/final-message soak.

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
- [x] Replace one fixed wall-clock turn deadline with a base active-work budget, one-minute per-tool extensions, a hard cap, and separate stall/tool/approval/input clocks.
- [x] Forward finalized visible assistant text before tool calls, but never thinking or failed-attempt drafts; emit sanitized retry notices and de-duplicate a matching final only after confirmed delivery.
- [x] Package the session MCP server independently of the Hitch source tree, install it under the sandbox-visible Pi package mount, and verify packed execution plus the real Bubblewrap boundary.

Rollout note (updated 2026-07-18): commits `be1c69c`, `75b8450`, `da40ebd`, and `b1e9f5a` are live in tmux `hitch:0.0` for attended WeChat testing. The active profile uses a five-minute base, one minute per tool up to thirty minutes, five-minute stall/input/approval deadlines, and a ten-minute tool deadline. WeChat receives timestamped intermediate checkpoint digests, failed tool results, and explicit `hitch.send_media` progress; ordinary successful tool chatter is suppressed, with a ten-second batch window retained for the remaining statuses. Checkpoint digests use ten seconds of quiet, a thirty-second maximum wait during continuous activity, and a three-digest turn cap. The standalone MCP server runs from `/agent-config/npm` with no Hitch repository mount. This remains a single-principal, unguarded-extension soak profile rather than the future multi-user credential-isolated profile.

## Completed Iteration: Checkpoint Digest Delivery

Goal: preserve useful intermediate agent updates without exhausting WeChat delivery capacity or suppressing the final answer.

- [x] Collect finalized pre-tool assistant messages into one timestamped progress digest.
- [x] Reset a ten-second quiet timer for each new checkpoint and force a digest after thirty seconds of continuous checkpoint activity.
- [x] De-duplicate checkpoint text, cap each digest at 1,000 characters, and cap progress at three digests per turn.
- [x] Drop pending progress when a final, retry, timeout, approval, input request, or notification takes priority.
- [x] Always enqueue the authoritative final response even when its text appeared in an earlier progress digest.
- [x] Audit checkpoint collection and digest enqueue trigger/count/delivery correlation.
- [x] Cover quiet batching, maximum-wait flushing, duplicate removal, turn caps, retry/timeout cleanup, failed delivery, and final-message behavior in smoke tests.

## Completed Iteration: Authoritative Delivery Priority

Goal: prevent a failed progress message from consuming the final response or media send behind it.

- [x] Classify checkpoint/tool digests as supersedable progress deliveries.
- [x] Classify final responses, timeout results, approval/input prompts, media failure notices, and hub-routed artifacts as authoritative deliveries.
- [x] Expire queued progress without a channel attempt when a newer authoritative delivery exists.
- [x] Drop still-pending tool-status batches before terminal responses, retries, approvals, and input prompts.
- [x] Let authoritative WeChat deliveries wait through the local failure cooldown, while ordinary messages continue to fail fast.
- [x] Wake cooldown waits on fresh inbound activity or hub shutdown.
- [x] Audit text-delivery priority and persist explicit `superseded` terminal evidence.
- [x] Reproduce an in-flight `ret=-2`, queued progress, cooldown, and successful final delivery in a deterministic smoke test.

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
- [x] Add Pi MCP adapter wiring and a standalone server package that loads from the sandbox-visible agent package directory without mounting Hitch source.
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

- [x] MCP process shape: one lazy stdio server launched by the Pi MCP adapter for a worker, using Hitch's short-lived session token and fixed-target bridge.
- [x] Transport for first bridge: session-scoped JSONL outbox and result file.
- [x] Agent-initiated `send_media` is processed by a session-scoped pump for the lifetime of the active worker.
- [!] Whether Pi will consume MCP prompts automatically from a native MCP server list, or whether Hitch needs a Pi extension adapter to fetch/apply the prompt.
- [x] The first `send_media` tool supports both detected images and ordinary files under the same host path/size/target policy.

## Design Decision: Agent Config Ownership

Hitch defaults to principal-private Hitch-scoped agent configuration. A single-principal operator may explicitly select system-level configuration when preserving an existing local Pi identity is more important than writable config isolation. The product boundary is that Hitch is a remote control and session hub around local agents, not a replacement config/auth/plugin manager for those agents.

Default ownership:

- Hitch owns Telegram/WeChat credentials, chat/user authorization, allowed roots, default cwd, session lifecycle, approval routing, media caching, artifact delivery policy, and remote command handling.
- The agent owns provider auth, default model/provider selection, plugins, extensions, MCP servers, and other native agent preferences.
- Hitch may pass launch-time overrides such as `--model` or `--provider`, but should not permanently rewrite native agent configuration.

Config scope policy:

- Under sandboxed execution, `config_scope: system` mounts one explicitly resolved, host-writable Pi config read/write while storing new sessions privately under Hitch. It is appropriate for a single-principal personal deployment and is rejected with multiple principals or `unsafe_allow_all`. Pi may persistently modify credentials, settings, trust, packages, extensions, and legacy session content inside that explicit mount; unsafe direct execution is unrestricted beyond it.
- `config_scope: hitch` gives every principal separate writable Pi config/session directories. It is the required mode for multi-user operation, smoke tests, isolated bot profiles, and future controlled automation.
- Under sandboxed execution, neither mode exposes the full home directory. Provider environment variables remain opt-in through `env_allowlist`.

This keeps the mental model simple: Hitch is the transport, authorization, cwd, session, approval, media, and artifact-delivery layer; the selected agent remains the source of truth for agent-specific behavior.

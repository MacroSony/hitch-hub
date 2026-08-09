# Security, Sandbox, and Automation Roadmap

Status: historical v1 roadmap. Phases 0-4 and the credential-containment
follow-up are implemented; later v1 phases are frozen. The clean replacement is
governed by the
[`v2 multi-user agentic MVP`](./v2-multi-user-agentic-mvp.md). The superseded
[`v2-first-slice.md`](./v2-first-slice.md) and
[`v2-design-roadmap.md`](./v2-design-roadmap.md) remain historical foundation
context.

This document records the intended order for per-principal authorization, persistent agent state, Linux Bubblewrap isolation, generic proactive triggers, and scheduled agent work. It also reconciles this direction with the older broad roadmap in [`plan.md`](../plan.md).

## Why This Work Comes Together

The features depend on one another:

- Multi-user or multi-chat operation needs a real principal and authorization model.
- A sandbox needs a resolved principal policy to know which host paths become mounts.
- Agents need a persistent writable state directory before a sandbox hides the rest of the host.
- Proactive triggers and schedules increase unattended execution, so they should not be exposed before authorization and isolation are enforceable.
- Scheduled results depend on durable delivery and service supervision; a cron feature is not useful if a channel failure or process restart silently loses the result.

The intended default is **read/write inside explicitly mounted session resources**, not read/write across the host.

## Current Security Reality

The implemented boundary is now:

- inbound Telegram/WeChat identities resolve to one principal with principal-specific chats, canonical roots, capabilities, and execution policy
- sessions are private to their owner; group-shared sessions are not implemented
- remote policies default to a required Bubblewrap sandbox on Linux; unavailable enforcement fails closed
- direct execution accepts only the explicit host-unrestricted unsafe policy
- workers receive an allowlisted environment without channel credentials, SSH/Docker control sockets, or loader-injection variables
- `/workspace`, `/state`, `/agent-config`, `/agent-sessions`, and `/hitch` are reconstructed from persisted, revalidated metadata
- Hitch data nested beneath a workspace is hidden with exact persisted tmpfs masks
- under Bubblewrap, system Pi config is an explicit writable single-principal mount; multi-user profiles use principal-private Hitch config
- required credential isolation disables caller-supplied Pi resources and exposes only guarded workspace file tools plus optional native media delivery
- the guard mirrors Pi's path normalization, blocks model access to config/runtime/session/host paths, rejects command-backed credentials, and attests startup before use
- provider credentials still exist in Pi's controller/config boundary; a provider broker or narrower scoped tokens remain future hardening
- when credential isolation is disabled, Pi extension code remains trusted code inside the namespace; `process: false` removes the model-facing `bash` tool but cannot prevent a trusted extension from launching its own helper

The remaining large gaps are Pi-version normalization compatibility, a provider credential broker/scoped-token strategy, resource quotas, provider-only network isolation, state retention policy, and unattended dispatch/trigger semantics.

## Working Policy Model

The policy should distinguish resources rather than treating cwd as the security boundary.

```ts
interface ExecutionPolicy {
  filesystem: "none" | "read-only" | "workspace-write" | "host-unrestricted";
  mounts: Array<{
    host_path: string;
    sandbox_path: string;
    mode: "ro" | "rw";
  }>;
  tools: string[];
  process: boolean;
  agent_network: "deny" | "allow";
  sandbox: "required" | "preferred" | "disabled";
  limits: {
    timeout_ms?: number;
    memory_bytes?: number;
    max_processes?: number;
  };
}
```

General Hitch-scoped remote default (without required credential isolation):

```yaml
filesystem: workspace-write
tools: [read, write, edit, grep, find, ls]
process: false
agent_network: allow
sandbox: required
```

`bash`/general process execution is a separate privilege and is not implied by file read/write access.

The single-principal system-scope rollout uses the narrower required-credential profile:

```yaml
credential_isolation: required
execution_policy:
  filesystem: workspace-write
  mounts: []
  tools: [read, write, edit, ls, hitch_send_media]
  process: false
  agent_network: allow
  sandbox: required
```

For private multi-user operation, use the same guarded policy with `config_scope: hitch` and provision separate provider identities out of band for each principal.

The `limits` fields are fail-closed contract placeholders today: both launchers reject a policy containing any limit because no resource-limit backend enforces them yet. `host-unrestricted` is accepted only with `sandbox: disabled` and is the explicit unsafe direct policy.

Network policy must distinguish provider transport from model-controlled network tools. Bubblewrap v1 may need to share the host network so Pi can reach its provider; that is not an honest hard `agent_network: deny` receipt while arbitrary shell or network-capable extension tools remain available.

## Persistent Session State

Each session receives a durable private state directory independent of Pi's transcript:

```text
host:    <data_dir>/session-state/principals/<principal-hash>/sessions/<session-hash>/worker/
sandbox: /state
mode:    read-write
```

Implemented sandbox layout:

```text
/state       persistent session-owned read/write data
/workspace   authorized project root, read-only or read-write by policy
/tmp         ephemeral tmpfs
/state/home  empty private sandbox home
```

A daily market assistant can store:

```text
/state/reports/2026-07-16.md
/state/reports/2026-07-17.md
/state/preferences.json
/state/index.json
```

This survives Pi worker restarts and remains queryable with bounded file tools. Pi conversation history may supplement it, but should not be treated as the business record because transcripts grow, compact, and follow backend-specific formats.

## Integrated Implementation Order

### 0. Reliability and minimum operability foundation (complete)

The completed foundation contains the minimum pieces needed to operate sandboxed workers safely:

- graceful `SIGINT`/`SIGTERM` shutdown
- deterministic worker cleanup
- a restart-on-failure user service example
- durable outbound delivery IDs and terminal delivery state

Implementation note (updated 2026-07-16): Phase 0 and the subsequent security commits are complete. They include live delivery validation, graceful shutdown, deterministic worker cleanup, idle-worker eviction, channel-health transition auditing, a user-service example, a durable outbound lifecycle with restart expiry and retention, bounded audit rotation, `!health`, and deterministic WeChat transport tests. The live WeChat-backed Hitch deployment now enforces required Bubblewrap for Pi workers; a controlled installed-Pi prompt passed after the exact trusted system-config mounts were migrated from read-only to read/write.

Additional channel-health diagnostics and state-retention policy can continue in parallel, but proactive scheduling should not ship before the sandbox soak and unattended safety gate are complete.

### 1. Define policy contracts and apply immediate hardening (complete)

- Add `Principal`, `AuthorizationContext`, `ExecutionPolicy`, `MountPlan`, and sandbox capability types.
- Canonicalize selected roots/cwd with `realpath` and reject symlink escape.
- Replace full environment inheritance with an explicit allowlist.
- Never expose Telegram/WeChat credentials, Docker sockets, or SSH agent sockets to workers by default.
- Mark direct launch as `unsafe` and fail closed when a required sandbox is unavailable.
- Keep `default_policy` as a deprecated parser-only compatibility field and enforce the new `execution_policy` model.

Implementation note (2026-07-16): complete. Policy contracts, canonical roots, environment filtering, and explicit unsafe direct mode landed as separate commits.

### 2. Implement per-principal authorization and session ownership (complete)

Resolve every inbound identity to exactly one principal:

```text
(platform, userId) -> principal
principal -> allowed chats, roots, capabilities
session -> ownerPrincipalId, visibility
```

Implemented semantics:

- private-chat sessions are private to their owner
- group sessions remain private to their owner; no chat-shared visibility exists
- roots are resolved from the current principal, never from a global union
- ambiguous or absent identity fails closed where user-level authorization is required

Future schedule creation/execution must retain an owner principal and re-authorize at run time. Future group sharing, if enabled, must separately define owner/admin/approval authority.

The implemented first-slice choice is private owner-only sessions. Group sharing remains disabled until its authority model is designed.

Implementation note (2026-07-16): complete for private sessions. Identity mapping, owner persistence, fail-closed legacy reconciliation, and cross-principal registry checks are implemented. Group-shared visibility remains deliberately disabled rather than partially authorized.

### 3. Add durable per-session state and mount metadata (complete)

- Allocate each session's private state directory.
- Store principal ownership, state path, and effective execution policy in SQLite.
- Keep cleanup/retention ownership separate from Pi session cleanup; concrete retention/quota defaults remain future work.
- Keep `/state` writable by default.
- Mount `/workspace` read-only or read-write according to policy.

Implementation note (2026-07-16): complete. Principal Pi config/session state and session worker/bridge state are durable, private, persisted in SQLite metadata, and revalidated before worker start.

### 4. Introduce `SandboxLauncher` and a Bubblewrap backend (complete)

```text
PiRpcBackend
    -> SandboxLauncher
        -> DirectLauncher       (explicit unsafe/development mode)
        -> BubblewrapLauncher   (Linux remote default)
```

Bubblewrap v1 provides:

- an allowlist-built mount namespace rather than `--ro-bind / /`
- read-only Node/Pi/system runtime mounts
- writable `/state`
- policy-controlled `/workspace`
- empty home and tmpfs `/tmp`
- private PID, IPC, UTS, user, and proc namespaces
- `--new-session`, `--disable-userns`, and `--die-with-parent`
- a cleared, rebuilt environment
- fail-closed startup when sandboxing is required
- attack-oriented tests for host-home visibility, token leakage, write modes, symlinks, and descendant cleanup

Bubblewrap is available and its minimal user-namespace probe succeeds on the current Linux development host. A minimal mount namespace also successfully starts the installed Pi 0.80.6 CLI.

Resource limits are a separate layer: add cgroup v2 or `systemd-run --user` controls after the mount/process isolation MVP.

Implementation note (2026-07-16): complete for the isolation MVP. Pi now launches through fail-closed Direct/Bubblewrap selection; system config, tool flags, media bridge paths, workspace compatibility aliases, hub-data masks, installed extensions, and process-tree cleanup have adversarial coverage. Multi-user routing/mount isolation is verified through locked-down synthetic Telegram identities.

Credential-containment follow-up (2026-07-16): required mode now provisions and attests only Hitch's guard, limits model-facing tools to workspace file operations and an authenticated native media adapter, scans command-backed credential configuration, and validates both raw and Pi-normalized paths. Session media is intersected with active mounts and global export roots and delivered from a private immutable snapshot. The remaining provider credential exposure is explicitly the Pi controller/config boundary, not the model tool surface.

### 5. Frozen v1 proposal: extract a single session-dispatch service

This phase is retained as historical input to the v2 Turn and application
service designs. It is not an active v1 implementation task.

Refactor chat-driven prompt execution into one internal path:

```ts
runSessionPrompt({
  sessionId,
  authorization: authenticatedProducerContext,
  prompt: { text, attachments },
  origin: { source, target, replyContext },
  delivery: deliveryContext,
  idempotencyKey,
});
```

The authenticated producer context, not a caller-supplied principal string, must establish who is asking. Dispatch must load immutable session ownership, verify current authority for the requested origin/target, and derive the effective principal from that check.

It must own:

- session-owner and current-authority re-authorization
- one-active-turn/busy policy
- revalidation of the persisted policy/mount snapshot without silently replacing it from current defaults
- sandbox launch/reuse
- timeout and cancellation
- event consumption
- attachment forwarding and delivery projection
- audit correlation

Chat handlers, proactive agent requests, and schedules must not implement separate worker paths.

### 6. Add a durable generic trigger inbox

Expose one producer-neutral trigger contract backed by SQLite. Producer authentication must be verified before enqueue, and the stored owner is derived from the authorized session rather than trusted from input:

```ts
triggerService.enqueue({
  sessionId,
  authorization: authenticatedProducerContext,
  prompt,
  source,
  idempotencyKey,
  notBefore,
});
```

Potential producers:

- a local `hitch trigger` CLI through a Unix socket or durable inbox
- system cron/systemd timers
- Pi or another agent through a session-scoped capability
- the later built-in scheduler

Define `skip`, `queue-one`, `replace`, and bounded queue policies. The initial unattended-report default should avoid duplicate runs after restart or delay.

This phase may land the durable inbox and tests, but it must not enable cron, agent, or external unattended producers until the next phase's safety gate passes.

### 7. Gate unattended execution with resource and credential safeguards

Before enabling any unattended producer or schedule, require an enforced or explicitly fail-closed unattended profile covering:

- CPU, memory, and PID limits
- temporary-storage and output-size limits
- scoped/revocable per-principal provider credentials, or a host-side provider broker that keeps long-lived provider credentials out of the worker boundary
- extension/tool allowlists suitable for unattended work
- network enforcement receipts that distinguish provider connectivity from agent-controlled access
- complete process-tree termination and status/audit enforcement receipts

At least one of those credential controls must be complete before the first unattended profile is enabled. A shared/system provider credential accepted for the attended single-principal soak is not sufficient. Further provider-only network proxy hardening may continue afterward, but the enabled profile must state and enforce its actual network boundary.

### 8. Add the built-in scheduler as a trigger producer

Only after the generic trigger path is stable, add:

- persisted schedule definitions
- cron expression and timezone
- `nextRunAt`
- restart and missed-run policy
- owner principal and execution-time re-authorization
- enable/disable/delete
- execution history and delivery correlation

Keep this a one-session/one-prompt scheduler. Chains, pipelines, councils, retries across models, and general orchestration remain out of scope.

### 9. Continue resource, network, and credential hardening

Follow-up work beyond the minimum unattended profile:

- per-principal/session quota tuning and retained-state lifecycle policy
- provider-only proxy or host-side provider broker investigation
- credential rotation and narrower provider scopes
- stronger isolation for third-party extension/helper code
- richer enforcement receipts and quota-usage diagnostics

## Historical Remaining Work After the Implemented Foundation

Principal ownership, persistent state, and Bubblewrap are complete. The
following was the proposed v1 merge order before the v2 replacement was chosen:

```text
unified dispatch
  -> trigger inbox
  -> unattended safety gate
  -> scheduler
```

Dispatch contract work can proceed alongside research/prototypes for resource enforcement, but unattended producers stay disabled until both lines converge at the safety gate.

## Sizing

The original estimate for principal isolation and Bubblewrap is retired because those phases are complete. Size the unified-dispatch, trigger-inbox, and unattended-safety slices after the dispatch contract and enforcement backend are chosen; sandbox and failure tests remain the main schedule drivers.

## Conflict Review Against `plan.md`

### 1. Current roadmap ordering: reconciled

This focused roadmap refines `plan.md` with Pi compatibility and guarded Hitch-scoped identity preparation, while preserving its main order: soak the sandboxed single-principal deployment, extract unified dispatch, add a dormant durable trigger inbox, pass an unattended resource/credential gate, and only then enable a scheduler. Channel/backend breadth and group sharing remain later work.

### 2. Write approval default: semantic conflict, resolved by narrower authority

The old security posture says to ask approval for write, shell, and network by default. The new working decision allows write by default **only inside explicit writable mounts** such as `/state` and a policy-approved `/workspace`.

Shell/process and agent-controlled network remain separate privileges. The old wording should eventually be updated because approval is not a substitute for filesystem isolation.

### 3. Agent config ownership: resolved for the isolation MVP

Under Bubblewrap, `config_scope: system` mounts one explicitly resolved, host-writable Pi config root read/write and keeps new Pi sessions in principal-private Hitch state. It is rejected with multiple principals or `unsafe_allow_all`. Pi needs write access for settings/trust lock directories and may also persistently modify credentials, settings, trust decisions, packages, extensions, and legacy sessions inside that root. `config_scope: hitch` gives every principal isolated writable Pi config/session directories and is the required multi-user mode. Neither sandboxed mode mounts the full home directory; explicit unsafe direct execution does not enforce these mount restrictions.

Provider auth is currently supplied by the explicitly mounted writable system config or explicit environment allowlist. Required credential isolation blocks model tools from reading those sources but does not remove credentials from Pi's controller process. Scoped/revocable per-principal credentials or a host-side broker are required before unattended execution rather than treated as an unacknowledged sandbox claim.

### 4. `default_policy`: compatibility field replaced

`default_policy` remains parser-only compatibility input. Typed `execution_policy` values are persisted and Pi tool/process restrictions are translated into Hitch-owned `--tools`/`--no-tools` arguments.

### 5. `allowedRoots`: implementation gap closed

Roots are canonicalized per principal, session cwd is revalidated before worker use, and Bubblewrap mounts only the owned workspace plus explicit policy paths. The flattened global list is retained only for non-principal aggregate configuration uses, not worker authorization.

### 6. Early Docker/container scheduler non-goal: no direct conflict

The old non-goal rejects a Docker/container scheduler and worktree-manager scope. Bubblewrap is a lightweight per-worker execution boundary, not a cluster scheduler or worktree orchestrator. The built-in cron feature is a prompt trigger scheduler, not a container scheduler.

### 7. Public multi-user SaaS non-goal: no conflict

Per-principal local authorization is required for safe Telegram groups and multiple personal chat identities. It does not turn Hitch into a public hosted multi-user service.

### 8. Multi-agent orchestration non-goal: no conflict

The trigger and scheduler design executes one prompt in one owned session. It deliberately excludes chains, councils, pipelines, and automatic model fallback.

### 9. Network policy: unresolved enforcement gap

The original plan proposes `network: deny` and approval-based network policy. Pi provider transport and model-controlled tools currently share one process/network namespace. Bubblewrap can deny all networking, but then Pi cannot contact its provider.

Until a provider broker or constrained proxy exists, network claims must distinguish hard OS isolation from tool-level restriction. Automated profiles should omit `bash` and unapproved network-capable extensions when a hard deny cannot be produced.

## Remaining Decisions

1. Group sessions remain private-owner only in the implemented slice; shared visibility needs an explicit product/authorization design before it is enabled.
2. Provider credentials currently come from the single-principal writable system config or explicit environment allowlist; scoped/revocable credentials remain future hardening.
3. Bubblewrap v1 either shares the host network (`allow`) or denies all network including provider transport (`deny`). A provider-only proxy remains unresolved.
4. State retention, temporary storage, output, memory, CPU, and PID quota defaults remain unresolved.
5. Trigger busy/missed-run defaults should be decided after unified dispatch exposes the existing chat semantics as one service.
6. Unsafe direct mode is configuration-only. No remote chat command can weaken an existing session into direct execution.

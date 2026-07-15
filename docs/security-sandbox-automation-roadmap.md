# Security, Sandbox, and Automation Roadmap

Status: accepted planning note; phase 0 operability work is in progress.

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

The current implementation has useful routing guardrails but no execution sandbox:

- `allowed_roots` limits the cwd accepted by `!new`; it does not constrain Pi's later file or shell access.
- Pi runs as the same OS user and groups as Hitch.
- Pi inherits almost all of Hitch's environment through `{ ...process.env }`.
- Absolute paths accepted by Pi tools can reach anything the Hitch OS user can access.
- The cwd allowlist check is lexical and does not currently canonicalize the selected cwd with `realpath`, so symlink escape must be fixed.
- All configured users' roots are currently flattened into one global root list.
- `agents.pi.default_policy` is parsed but is not an enforcement boundary for built-in Pi tool calls.
- Extension UI approvals are useful interaction plumbing, but they are not a filesystem, process, or network sandbox.

Therefore `direct` execution must be described as unsandboxed even when its cwd passed an allowlist check.

## Working Policy Model

The policy should distinguish resources rather than treating cwd as the security boundary.

```ts
interface ExecutionPolicy {
  filesystem: "none" | "read-only" | "workspace-write";
  mounts: Array<{
    hostPath: string;
    sandboxPath: string;
    mode: "ro" | "rw";
  }>;
  tools: string[];
  process: boolean;
  agentNetwork: "deny" | "allow";
  sandbox: "required" | "preferred" | "disabled";
  limits: {
    timeoutMs: number;
    memoryBytes?: number;
    maxProcesses?: number;
  };
}
```

Initial remote default:

```yaml
filesystem: workspace-write
tools: [read, write, edit, grep, find, ls]
process: false
sandbox: required
```

`bash`/general process execution is a separate privilege and is not implied by file read/write access.

Network policy must distinguish provider transport from model-controlled network tools. Bubblewrap v1 may need to share the host network so Pi can reach its provider; that is not an honest hard `agentNetwork: deny` receipt while arbitrary shell or network-capable extension tools remain available.

## Persistent Session State

Each session should receive a durable private state directory independent of Pi's transcript:

```text
host:    <data_dir>/workspaces/<principal-id>/<session-id>/
sandbox: /state
mode:    read-write
```

Suggested sandbox layout:

```text
/state       persistent session-owned read/write data
/workspace   authorized project root, read-only or read-write by policy
/tmp         ephemeral tmpfs
/home/agent  empty sandbox home unless narrowly populated
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

### 0. Finish the current reliability iteration and minimum operability foundation

Complete the live WeChat failure/recovery validation already in progress, then land the minimum pieces required to operate sandboxed and scheduled workers safely:

- graceful `SIGINT`/`SIGTERM` shutdown
- deterministic worker cleanup
- a restart-on-failure user service example
- durable outbound delivery IDs and terminal delivery state

Implementation note (2026-07-15): the Phase 0 implementation is complete. It now includes live delivery validation, graceful shutdown, deterministic worker cleanup, idle-worker eviction, channel-health transition auditing, a user-service example, a durable outbound lifecycle with restart expiry and retention, bounded audit rotation, `!health`, and deterministic WeChat transport tests. The durable-ledger commit still needs a controlled live rollout after the current `27ba1a0` soak test before Phase 1 begins.

Channel-health diagnostics and retention can continue in parallel, but proactive scheduling should not ship before service restart and delivery outcome behavior are explicit.

### 1. Define policy contracts and apply immediate hardening

- Add `Principal`, `AuthorizationContext`, `ExecutionPolicy`, `MountPlan`, and sandbox capability types.
- Canonicalize selected roots/cwd with `realpath` and reject symlink escape.
- Replace full environment inheritance with an explicit allowlist.
- Never expose Telegram/WeChat credentials, Docker sockets, or SSH agent sockets to workers by default.
- Mark direct launch as `unsafe` and fail closed when a required sandbox is unavailable.
- Decide whether `default_policy` is migrated into the new policy model or removed.

### 2. Implement per-principal authorization and session ownership

Resolve every inbound identity to exactly one principal:

```text
(platform, userId) -> principal
principal -> allowed chats, roots, capabilities
session -> ownerPrincipalId, visibility
```

Initial semantics:

- private-chat sessions are private to their owner
- group sessions may be chat-shared, but abort and approval require owner/admin authority
- roots are resolved from the current principal, never from a global union
- schedule creation and execution retain an owner principal and re-authorize at run time
- ambiguous or absent identity fails closed where user-level authorization is required

The group ownership and sharing rules remain a product decision that must be fixed before schema migration.

### 3. Add durable per-session state and mount metadata

- Allocate each session's private state directory.
- Store principal ownership, state path, and effective execution policy in SQLite.
- Define cleanup/retention separately from Pi session cleanup.
- Keep `/state` writable by default.
- Mount `/workspace` read-only or read-write according to policy.

### 4. Introduce `SandboxLauncher` and a Bubblewrap backend

```text
PiRpcBackend
    -> SandboxLauncher
        -> DirectLauncher       (explicit unsafe/development mode)
        -> BubblewrapLauncher   (Linux remote default)
```

Bubblewrap v1 should provide:

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

### 5. Extract a single session-dispatch service

Refactor chat-driven prompt execution into one internal path:

```ts
runSessionPrompt({
  sessionId,
  principalId,
  prompt,
  source: "chat" | "schedule" | "agent" | "api",
  idempotencyKey,
});
```

It must own:

- re-authorization
- one-active-turn/busy policy
- policy and mount resolution
- sandbox launch/reuse
- timeout and cancellation
- event consumption
- delivery projection
- audit correlation

Chat handlers, proactive agent requests, and schedules must not implement separate worker paths.

### 6. Add a durable generic trigger inbox

Expose one producer-neutral trigger contract backed by SQLite:

```ts
triggerService.enqueue({
  sessionId,
  principalId,
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

### 7. Add the built-in scheduler as a trigger producer

Only after the generic trigger path is stable, add:

- persisted schedule definitions
- cron expression and timezone
- `nextRunAt`
- restart and missed-run policy
- owner principal and execution-time re-authorization
- enable/disable/delete
- execution history and delivery correlation

Keep this a one-session/one-prompt scheduler. Chains, pipelines, councils, retries across models, and general orchestration remain out of scope.

### 8. Harden resource, network, and credential isolation

Follow-up work:

- cgroup CPU, memory, and PID limits
- complete process-tree termination tests
- temporary-storage and output-size limits
- provider-only proxy or host-side provider broker investigation
- scoped/revocable provider credentials
- extension/tool allowlists for unattended profiles
- explicit enforcement receipts in status/audit output

## Parallel Work After Contract Freeze

Once the policy and persistence contracts are agreed, development can proceed in parallel:

```text
A. Principal/ACL and SQLite migrations
B. Bubblewrap launcher and escape tests
C. Dispatch extraction and trigger inbox
```

Recommended merge order:

```text
policy contracts
  -> principal ownership
  -> persistent state
  -> Bubblewrap
  -> unified dispatch
  -> trigger inbox
  -> scheduler
```

## Rough Size and Time

Expected first usable slice covering principal isolation, persistent writable state, Bubblewrap, generic triggers, and a scheduler:

- production TypeScript: approximately 1,800-3,000 lines
- tests: approximately 1,500-2,500 lines
- focused parallel implementation: approximately 2-4 weeks, with sandbox and failure testing determining the schedule more than argument construction

The Linux Bubblewrap MVP alone is expected to add roughly 700-1,200 production lines and 500-900 test lines.

## Conflict Review Against `plan.md`

### 1. Current roadmap ordering: intentional priority change

`plan.md` currently prioritizes operability/delivery evidence, the final Pi media adapter, and then channel/backend breadth. This document keeps the reliability and minimum operability foundation first, but inserts authorization and sandboxing before proactive triggers or additional multi-user exposure.

This is an intentional refinement, not a rejection of the operability work. Durable delivery is a prerequisite for unattended scheduled reports.

### 2. Write approval default: semantic conflict, resolved by narrower authority

The old security posture says to ask approval for write, shell, and network by default. The new working decision allows write by default **only inside explicit writable mounts** such as `/state` and a policy-approved `/workspace`.

Shell/process and agent-controlled network remain separate privileges. The old wording should eventually be updated because approval is not a substitute for filesystem isolation.

### 3. Agent config ownership: unresolved tension

The active tracker recommends `config_scope: system` for normal use so Pi inherits the user's existing auth, extensions, and preferences. A strong sandbox should not expose the full host home, environment, sockets, or arbitrary extension paths.

The likely resolution is two explicit modes:

- trusted interactive/direct mode may use system config with an explicit unsafe label
- remote automated/sandbox mode materializes or mounts a minimal approved Pi config and state set

Exactly how provider auth and selected trusted extensions enter the sandbox remains an open design item. Hitch should not silently claim both full system inheritance and hermetic isolation.

### 4. `default_policy`: implementation gap

The plan describes per-agent policy defaults, but the current field is not enforced for ordinary Pi built-in tool calls. The new policy layer should replace or formally implement this field; retaining an inert security-looking option is misleading.

### 5. `allowedRoots`: implementation gap, not architectural conflict

The original plan intended per-user roots and protection against edits outside cwd. Current roots are flattened globally and constrain only session creation. Principal-scoped mount plans and Bubblewrap implement the original intent more faithfully.

### 6. Early Docker/container scheduler non-goal: no direct conflict

The old non-goal rejects a Docker/container scheduler and worktree-manager scope. Bubblewrap is a lightweight per-worker execution boundary, not a cluster scheduler or worktree orchestrator. The built-in cron feature is a prompt trigger scheduler, not a container scheduler.

### 7. Public multi-user SaaS non-goal: no conflict

Per-principal local authorization is required for safe Telegram groups and multiple personal chat identities. It does not turn Hitch into a public hosted multi-user service.

### 8. Multi-agent orchestration non-goal: no conflict

The trigger and scheduler design executes one prompt in one owned session. It deliberately excludes chains, councils, pipelines, and automatic model fallback.

### 9. Network policy: unresolved enforcement gap

The original plan proposes `network: deny` and approval-based network policy. Pi provider transport and model-controlled tools currently share one process/network namespace. Bubblewrap can deny all networking, but then Pi cannot contact its provider.

Until a provider broker or constrained proxy exists, network claims must distinguish hard OS isolation from tool-level restriction. Automated profiles should omit `bash` and unapproved network-capable extensions when a hard deny cannot be produced.

## Decisions Still Required Before Implementation

1. Group session ownership: chat-shared, owner-only, or configurable visibility.
2. Minimal Pi configuration/auth material mounted into a sandbox.
3. Provider credential strategy when writable tools or shell are enabled.
4. Bubblewrap network v1: shared network with tool restrictions, or a provider proxy requirement.
5. State retention and quota defaults.
6. Trigger busy/missed-run defaults.
7. Whether trusted interactive sessions may explicitly choose unsandboxed direct mode from chat, or only from local configuration.

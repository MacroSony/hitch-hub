# Hitch

Hitch is a lightweight, self-hosted, chat-native control plane for local coding agents.

It lets you connect chat apps such as Telegram or WeChat to local coding agents such as Pi, while keeping sessions, working directories, approvals, and artifacts under a small local hub instead of a full dashboard or IDE.

## Status

Hitch is early. The current implementation focuses on the first useful control path:

- Telegram long polling adapter for text, captions, photos, and documents
- WeChat iLink adapter for QR login, text, and media
- Multiple enabled live channel adapters can run in one hub process
- Local fake adapter for repeatable testing
- Pi RPC backend
- SQLite session and approval registry
- Principal-scoped canonical cwd/root enforcement
- Size-bounded JSONL audit logging and operator health diagnostics
- Pi extension UI approval requests answered through `!approve` / `!deny`
- Configurable default cwd
- SHA-256 inbound media cache for Telegram photos/documents and WeChat media
- Cached images passed to Pi through native RPC image attachments when supported, with local path references kept in the prompt
- Pi RPC model inspection and switching through agent-native `/model`
- Explicit session listing and switching with optional names
- Legacy opt-in outbound Telegram/WeChat upload for local image/file paths mentioned by Pi
- Explicit session-scoped `hitch.send_media` hub tool/MCP path for outbound media, with path auto-discovery disabled by default
- Basic text chunking, summarized tool-output delivery, and timeout handling

See `implementation_steps.md` for the current iteration checklist, `docs/completed-work.md` for finished checkpoint history, and `docs/hub-tools-mcp.md` for the explicit outbound media/tool design.

## Requirements

- Node.js 24 or newer
- npm
- Git
- Pi installed on PATH, or available through the npm shim

On Windows PowerShell, `npm.ps1` may be blocked by execution policy. Use `npm.cmd` directly:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
```

When `HTTP_PROXY`, `HTTPS_PROXY`, or `NO_PROXY` are set, the npm scripts start Node with `--use-env-proxy` so Telegram API calls use the same proxy settings as tools such as curl.

## Setup

Install dependencies:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
```

Create a local `.env` file:

```text
TELEGRAM_BOT_TOKEN=123456:your-token
```

Edit `examples/config.example.yaml` for your machine:

- `default_cwd`: an existing directory where `!new pi` starts by default; it is canonicalized at startup
- `users.*.allowed_roots`: existing directories Hitch may launch workers in; roots are canonicalized at startup
- `users.*.allowed_chat_ids`: optional per-principal chat restriction applied in addition to the channel allowlist
- `users.*.capabilities`: optional hub capabilities; `operator` reveals hub-global recovery/transition diagnostics in `!health`
- `users.*.execution_policy`: optional per-principal override of `agents.pi.execution_policy`; the normalized policy is snapshotted when a session is created, so later policy changes apply to new sessions while existing snapshots continue only if their roots and mounts remain valid
- `channels.telegram.allowed_chat_ids`: Telegram chats allowed to control the hub
- `users.*.telegram_ids`: Telegram users allowed to control the hub
- `channels.wechat.allowed_chat_ids`: WeChat chats/users allowed to control the hub
- `users.*.wechat_ids`: WeChat users allowed to control the hub
- `media.outbound_roots`: existing directories Hitch may explicitly send media from with `!send` or `hitch.send_media`; roots are canonicalized at startup
- `media.auto_discovery`: `false` by default; set `true` only to enable legacy path scanning from Pi final text
- `agents.pi.config_scope`: under sandboxed execution, `system` mounts one normal Pi config read-only for a single principal, while `hitch` gives every principal isolated Pi config/state under `data_dir`
- `agents.pi.system_config_root`: optional system-scope Pi config directory; defaults to `~/.pi/agent` and may not be the home directory itself
- `agents.pi.execution_policy`: filesystem mounts, Pi tool allowlist, `bash`/process capability, network namespace mode, and required sandbox mode; the remote default is workspace write with non-shell built-ins only
- `agents.pi.env_allowlist`: optional environment variable names Pi needs for provider authentication; channel credentials, host-control sockets, loader injection variables, and `HITCH_*` names are rejected
- `delivery.full_tool_output`: `false` to show only tool names and success/failure, or `true` to include full tool result text
- `delivery.tool_status_mode`: `all` for every tool start/result, `failures` to suppress ordinary successful tool chatter while still showing explicit `hitch.send_media` progress, or `none` for no tool-status messages
- `delivery.tool_status_batch_ms`: `0` for immediate tool status messages, or a delay such as `10000` to batch tool start/result messages before the next agent body message
- `delivery.send_timeout_ms`: maximum time for one outbound text/media send attempt after it reaches the front of its queue
- `delivery.queue_ttl_ms`: maximum time an accepted delivery may wait for its send attempt to begin
- `delivery.retention_ms`: how long terminal delivery-ledger rows remain in SQLite; `0` disables pruning
- `audit.max_bytes` and `audit.max_files`: size and retained-file limits for the rotating JSONL audit log
- `agent_turn_timeout_ms`: authoritative wall-clock turn limit; interrupted Pi output received during bounded cancellation is returned as a labeled partial result
- `worker_idle_timeout_ms`: how long an idle agent worker remains loaded before Hitch stops it; `0` disables idle eviction
- `channels.wechat.send_min_interval_ms`: minimum gap between WeChat API sends; `4000` is the conservative default for mixed text/media bursts
- `channels.wechat.failure_cooldown_ms`: cooldown after a failed WeChat send; remaining items fail quickly until the cooldown expires or a fresh inbound message arrives

For a personal setup, copy the example to a local config name such as `config.local.yaml` and keep chat IDs and machine-specific paths out of public commits.
When Telegram is enabled, `allowed_chat_ids` and at least one `users.*.telegram_ids` entry are required. For local-only experiments, `channels.telegram.unsafe_allow_all: true` restores the old allow-all behavior explicitly.
When WeChat is enabled, `allowed_chat_ids` and at least one `users.*.wechat_ids` entry are required. For local-only experiments, `channels.wechat.unsafe_allow_all: true` allows every WeChat sender explicitly.
Each `users` key is a principal ID. An inbound platform/user identity must map to exactly one principal, sessions are private to that principal, and duplicate identity assignments fail closed. Group-shared sessions remain disabled.

## Usage

Start the hub:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev -- --config examples/config.example.yaml
```

Then send commands to the configured chat bot:

```text
!new pi
!new pi AgentHub
!new pi C:\path\to\repo
!status
!health
!sessions
!switch <session-id-or-name>
!cwd
!abort
!send /absolute/path/to/image.png optional caption
!approve <approval-id>
!deny <approval-id>
```

Agent-native slash commands are routed to the active backend:

```text
/model
/model deepseek/deepseek-v4-flash
/models deepseek
/review
```

Unknown `!` commands are rejected by Hitch instead of being forwarded to Pi. Slash commands are treated as agent-native commands. For Pi, Hitch maps `/model` and `/models` to typed Pi RPC calls; other slash commands are forwarded through Pi's command/prompt path. `!model` and `!models` remain compatibility aliases for `/model` and `/models`.

Interactive selection behavior:

- `!sessions` renders a numbered session picker; reply with a number to switch sessions.
- Pi `/model` and `/models [filter]` render a numbered model picker when model choices are available; reply with a number to switch models.
- Picker options use `0` through `9`; `n` advances to the next page and `p` goes back.
- Numeric replies are treated as selections only while a pending picker exists for the same chat/thread/user.

Path behavior:

- `!new pi` uses `default_cwd`
- `!new pi test` resolves to `default_cwd\test`
- `!new pi C:\path\to\repo` uses the absolute path directly
- `!new pi --name api-fix` names the session and switches to it
- cwd values outside allowed roots are rejected

Approval behavior:

- Pi itself does not provide a built-in per-tool approval gate.
- Pi extensions can ask for confirmation through RPC extension UI requests.
- Hitch persists those requests with an expiry, renders an approval ID, and sends the matching `extension_ui_response` back to Pi when `!approve <id>` or `!deny <id>` is received.
- Pi extension select requests are rendered as normal Hitch pickers instead of approval prompts.
- Pi notifications render as chat notifications, not tool results.
- Pi input/editor requests render their prompt or prefilled text in chat and are auto-cancelled until IM text entry/editing is supported.
- Telegram renders approval buttons when possible; text commands remain the fallback.

Media behavior:

- Telegram photos/documents and WeChat media from allowed chats are cached under `data_dir/media/inbound`
- Cached files are deduplicated by SHA-256
- Cached images are passed to Pi through native RPC image attachments when possible; cached non-image files are passed as local path references appended to the prompt
- Inbound and outbound media byte limits are configured under `media`
- Explicit outbound send: `!send <absolute-path> [caption]` uploads a local image/file only when the path is under `media.outbound_roots` or the hub-managed outbound media directory
- Agent tool bridge: active Pi workers receive `HITCH_TOOL_*` environment variables for a session-scoped media-send bridge; its outbox pump stays active for the worker lifetime
- MCP bridge: `npm run mcp:session` exposes `hitch.send_media` and the `hitch.outbound_media` prompt over stdio for agents that can launch a session-scoped MCP server
- MCP-capable agents should load the `hitch.outbound_media` prompt so generated images/files are sent explicitly instead of only mentioned by path
- Current prototype: when `media.auto_discovery: true`, Pi final text path scanning attempts to upload up to five de-duplicated artifacts per turn back to Telegram or WeChat
- Target design: Pi or another agent explicitly calls a hub-owned `hitch.send_media` tool, with MCP as the long-term transport
- Outbound artifact delivery attempts are recorded in the audit log and durable delivery ledger with session/turn correlation when initiated by an active turn

Tool output behavior:

- Tool calls show the tool name and completion status by default.
- Full tool result text is hidden unless `delivery.full_tool_output: true` is configured.
- Tool call/result status messages are sent immediately by default; set `delivery.tool_status_batch_ms` to batch bursts into one message and flush them before final agent text, notifications, approval prompts, or interaction prompts.
- Hidden tool result text is not scanned for outbound artifact upload.

Runtime health behavior:

- Agent turns have an authoritative wall-clock deadline; Hitch marks the turn as an error even if Pi never closes its event stream.
- When Pi returns an explicitly interrupted final during bounded deadline cancellation, Hitch labels and delivers it as a partial result before stopping the worker.
- Idle workers are stopped after `worker_idle_timeout_ms`; their persisted Pi session remains available and is resumed by a new worker on the next prompt.
- Outbound text is persisted before it is accepted, queued per chat, and bounded by `delivery.send_timeout_ms`, so a slow chat API does not block Pi event consumption.
- Text and media share one ordered per-chat queue. A queued item receives its full send deadline when its own attempt begins.
- Accepted text/media deliveries progress through durable `queued`, `sending`, and terminal `sent`/`failed`/`expired` states. Startup expires interrupted nonterminal rows without automatically resending them.
- After a WeChat send failure, the rest of that broken batch fails quickly instead of consuming one full timeout per item; a new inbound message reopens delivery immediately.
- `!status` reports active-turn age/deadline, worker liveness, pending/recent delivery health, and channel receive health.
- `!health` reports process uptime, channel state, last inbound activity, durable delivery counts, and principal-scoped workers/turns. Hub-global transition and startup-recovery totals require the `operator` capability.
- Text delivery attempts are recorded in the audit log without storing message contents.
- Delivery audit records include a delivery ID and, when available, session/turn correlation.
- The SQLite delivery ledger stores lengths and correlation metadata, not text bodies or artifact paths. Terminal rows and audit files have configurable retention limits.
- Channel health is logged and audited on state transitions, suppressing repeated identical polling errors until recovery.

## Service Operation

For a continuously running Linux deployment, copy [examples/hitch-hub.service](examples/hitch-hub.service) to `~/.config/systemd/user/hitch-hub.service`. Adjust `WorkingDirectory` and the config filename if your checkout differs, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now hitch-hub.service
systemctl --user status hitch-hub.service
```

The sample uses restart-on-failure and gives Hitch 45 seconds to handle `SIGTERM`, stop channel receive loops and workers, and drain bounded delivery/audit work. Tmux remains useful for development, but it does not restart a crashed hub.

WeChat behavior:

- First run prints a QR code URL to stderr; scan it with WeChat to connect.
- Credentials, long-poll cursor, and context tokens are stored under `data_dir/wechat`.
- Replies require a context token from an inbound WeChat message, so proactive sends before a user messages the bot may fail.

## Local Testing

Run the type checker:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run typecheck
```

Build:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run build
```

Run the fake adapter smoke test:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:fake
```

Run the Pi RPC protocol smoke test:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:pi-rpc
```

Run the Pi approval bridge smoke test:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:pi-approval
```

Run the media-cache smoke test:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:media-cache
& 'C:\Program Files\nodejs\npm.cmd' run smoke:media-flow
& 'C:\Program Files\nodejs\npm.cmd' run smoke:mcp-session
```

Run the interactive-selection smoke test:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:interaction-flow
```

Run the multi-channel routing smoke test:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:multi-channel
```

Run the runtime and deterministic WeChat reliability smoke tests:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:reliability-flow
& 'C:\Program Files\nodejs\npm.cmd' run smoke:wechat-reliability
```

Check Telegram credentials without printing the token:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:telegram-getme
& 'C:\Program Files\nodejs\npm.cmd' run smoke:telegram-updates
```

Run a local fake command sequence:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "!cwd"
```

## Notes

Hitch intentionally does not expose Pi, Codex, OpenCode, or other agent servers directly. The hub owns chat authorization, cwd binding, session state, and delivery behavior.

Channel behavior:

- When multiple live channels are enabled, Hitch starts all enabled adapters in the same process.
- Outbound replies and artifacts are routed by the inbound event target platform.
- `--fake-message` remains a fake-only smoke-test mode.

Pi config behavior:

- Workers receive a small runtime/proxy environment allowlist. Provider API-key variables must be named explicitly under `agents.pi.env_allowlist`; Telegram credentials and host-control sockets are never inherited.
- Sandboxed Pi workers use Bubblewrap on Linux and fail closed when it is unavailable. Restricted `sandbox: preferred` policies do not fall back to direct execution because direct mode cannot enforce them.
- Under sandboxed execution, `config_scope: system` mounts only the configured Pi directory at `/agent-config` read-only, uses private principal-owned session storage, and is rejected unless exactly one principal is configured without `unsafe_allow_all`. Explicit unsafe direct execution does not enforce that read-only mount boundary.
- `config_scope: hitch` stores Pi config/session state in principal-private directories under `data_dir` and defaults `PI_OFFLINE=1` unless already set.
- Each principal receives private Pi agent/session directories, and each Hitch session receives private worker/tool state under `data_dir/session-state/...`. `/hitch/results` is overlaid read-only to the worker and the sandbox receives an empty private home plus ephemeral `/tmp`.
- The workspace is mounted at `/workspace` and at its canonical host path so trusted Pi/MCP configuration containing an absolute project cwd continues to work; both aliases have the same policy-selected read/write mode.
- If `data_dir` is beneath the workspace, persisted tmpfs masks hide it through both aliases so workers cannot read Hitch's database, audit log, credentials, or other principals' state. Policy mounts and external Pi config roots may not re-expose that directory.
- Explicit policy mounts can expose additional principal-approved paths. For example, a media extension that writes `/tmp/pi-paint-outputs` needs that exact directory as a writable policy mount and as a `media.outbound_roots` entry.
- `execution_policy.tools` is translated into Hitch-owned Pi `--tools`/`--no-tools` arguments. `process: true` must include `bash` (or the sole `"*"` wildcard); `process: false` rejects it. Tool-control flags are not accepted in `default_args`.
- Pi extensions are trusted code inside the namespace and may launch their own helper processes even when the model-facing `bash` tool is disabled. Their processes still share the sandbox mounts, environment, namespaces, and cleanup boundary.
- Execution policy and mount plans are persisted with the session; missing legacy metadata is initialized, while partial, modified, escaped, or no-longer-authorized metadata is quarantined instead of silently regenerated.
- Tightening an old explicit unsafe/direct policy to a sandboxed policy is one-way: the old immutable session is quarantined and must be recreated rather than silently continuing with host access.
- On the first `config_scope: hitch` upgrade, old shared `data_dir/pi` state stops startup until it is backed up and explicitly assigned with `agents.pi.legacy_state_principal`. Old `data_dir/tools/<session-id>` state is moved into the matching private session state.
- Model/provider flags can still be passed through `agents.pi.default_args`, for example `--model openai/gpt-4o`.
- Hitch starts Pi with a stable `--session-id` based on the Hitch session unless `agents.pi.default_args` already includes an explicit Pi session mode such as `--no-session`, `--session`, `--session-id`, `--continue`, `--resume`, or `--fork`.

## Roadmap

- Live WeChat soak testing through the required Bubblewrap boundary
- One internal owned/re-authorized session-dispatch service for chat and future triggers
- Durable generic trigger inbox, initially without unattended producers
- Resource, temporary-storage, output, credential, network, and unattended-extension safeguards before enabling schedules
- A deliberately small scheduler after that unattended-execution gate passes
- Explicit group-sharing authority before any shared session visibility
- Pi-native MCP server list wiring, once Pi exposes a stable MCP client configuration surface
- Richer approval rendering across non-Telegram channels
- Discord adapter
- Additional agent backends

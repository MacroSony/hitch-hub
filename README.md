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
- cwd allowlist checks
- Basic audit logging
- Pi extension UI approval requests answered through `!approve` / `!deny`
- Configurable default cwd
- SHA-256 inbound media cache for Telegram photos/documents and WeChat media
- Cached images passed to Pi through native RPC image attachments when supported, with local path references kept in the prompt
- Pi RPC model inspection and switching through agent-native `/model`
- Explicit session listing and switching with optional names
- Prototype outbound Telegram/WeChat upload for local image/file paths mentioned by Pi
- Planned minimal `hitch.send_media` hub tool/MCP path for outbound media, replacing path auto-discovery as the primary design
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

- `default_cwd`: where `!new pi` starts by default
- `users.*.allowed_roots`: directories Hitch may launch workers in
- `channels.telegram.allowed_chat_ids`: Telegram chats allowed to control the hub
- `users.*.telegram_ids`: Telegram users allowed to control the hub
- `channels.wechat.allowed_chat_ids`: WeChat chats/users allowed to control the hub
- `users.*.wechat_ids`: WeChat users allowed to control the hub
- `media.outbound_roots`: directories Hitch may explicitly send media from with `!send` or future hub tools
- `media.auto_discovery`: `false` by default; set `true` only to enable legacy path scanning from Pi final text
- `agents.pi.config_scope`: `system` to use your normal Pi config, or `hitch` to isolate Pi state under `data_dir`
- `delivery.full_tool_output`: `false` to show only tool names and success/failure, or `true` to include full tool result text
- `delivery.tool_status_batch_ms`: `0` for immediate tool status messages, or a delay such as `10000` to batch tool start/result messages before the next agent body message

For a personal setup, copy the example to a local config name such as `config.local.yaml` and keep chat IDs and machine-specific paths out of public commits.
When Telegram is enabled, `allowed_chat_ids` and at least one `users.*.telegram_ids` entry are required. For local-only experiments, `channels.telegram.unsafe_allow_all: true` restores the old allow-all behavior explicitly.
When WeChat is enabled, `allowed_chat_ids` and at least one `users.*.wechat_ids` entry are required. For local-only experiments, `channels.wechat.unsafe_allow_all: true` allows every WeChat sender explicitly.

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
- Agent tool bridge: active Pi workers receive `HITCH_TOOL_*` environment variables for a session-scoped media-send bridge
- MCP bridge: `npm run mcp:session` exposes `hitch.send_media` and the `hitch.outbound_media` prompt over stdio for agents that can launch a session-scoped MCP server
- MCP-capable agents should load the `hitch.outbound_media` prompt so generated images/files are sent explicitly instead of only mentioned by path
- Current prototype: when `media.auto_discovery: true`, Pi final text path scanning attempts to upload up to five de-duplicated artifacts per turn back to Telegram or WeChat
- Target design: Pi or another agent explicitly calls a hub-owned `hitch.send_media` tool, with MCP as the long-term transport
- Outbound artifact delivery attempts are recorded in the audit log

Tool output behavior:

- Tool calls show the tool name and completion status by default.
- Full tool result text is hidden unless `delivery.full_tool_output: true` is configured.
- Tool call/result status messages are sent immediately by default; set `delivery.tool_status_batch_ms` to batch bursts into one message and flush them before final agent text, notifications, approval prompts, or interaction prompts.
- Hidden tool result text is not scanned for outbound artifact upload.

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

- `config_scope: system` starts Pi like your terminal Pi and leaves `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `PI_OFFLINE` untouched.
- `config_scope: hitch` stores Pi config/session state under `data_dir/pi/...` and defaults `PI_OFFLINE=1` unless already set.
- Model/provider flags can still be passed through `agents.pi.default_args`, for example `--model openai/gpt-4o`.
- Hitch starts Pi with a stable `--session-id` based on the Hitch session unless `agents.pi.default_args` already includes an explicit Pi session mode such as `--no-session`, `--session`, `--session-id`, `--continue`, `--resume`, or `--fork`.

## Roadmap

- Robust live Telegram and WeChat usage testing
- Pi-native MCP server list wiring, once Pi exposes a stable MCP client configuration surface
- Durable delivery tracking and user-visible delivery failures
- Richer approval rendering across non-Telegram channels
- Discord adapter
- Additional agent backends

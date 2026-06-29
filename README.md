# Hitch

Hitch is a lightweight, self-hosted, chat-native control plane for local coding agents.

It lets you connect chat apps such as Telegram to local coding agents such as Pi, while keeping sessions, working directories, approvals, and artifacts under a small local hub instead of a full dashboard or IDE.

## Status

Hitch is early. The current implementation focuses on the first useful control path:

- Telegram long polling adapter for text, captions, photos, and documents
- WeChat iLink adapter for QR login, text, and media
- Local fake adapter for repeatable testing
- Pi RPC backend
- SQLite session and approval registry
- cwd allowlist checks
- Basic audit logging
- Pi extension UI approval requests answered through `!approve` / `!deny`
- Configurable default cwd
- SHA-256 inbound media cache for Telegram photos/documents
- Cached media references passed to Pi prompts as local file paths
- Pi RPC model inspection and switching through agent-native `/model`
- Explicit session listing and switching with optional names
- Best-effort outbound Telegram upload for local image/file paths mentioned by Pi
- Best-effort outbound WeChat upload for local image/file paths mentioned by Pi
- Basic text chunking and timeout handling

See `implementation_steps.md` for the current iteration checklist and checkpoint test results.

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
- `agents.pi.config_scope`: `system` to use your normal Pi config, or `hitch` to isolate Pi state under `data_dir`

For a personal setup, copy the example to a local config name such as `config.local.yaml` and keep chat IDs and machine-specific paths out of public commits.
When Telegram is enabled, `allowed_chat_ids` and at least one `users.*.telegram_ids` entry are required. For local-only experiments, `channels.telegram.unsafe_allow_all: true` restores the old allow-all behavior explicitly.
When WeChat is enabled, `allowed_chat_ids` and at least one `users.*.wechat_ids` entry are required. For local-only experiments, `channels.wechat.unsafe_allow_all: true` allows every WeChat sender explicitly.

## Usage

Start the hub:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev -- --config examples/config.example.yaml
```

Then send commands to the Telegram bot:

```text
!new pi
!new pi AgentHub
!new pi C:\path\to\repo
!status
!sessions
!switch <session-id-or-name>
!cwd
!abort
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
- Telegram renders approval buttons when possible; text commands remain the fallback.

Media behavior:

- Telegram photos/documents and WeChat media from allowed chats are cached under `data_dir/media/inbound`
- Cached files are deduplicated by SHA-256
- Cached images are passed to Pi through native RPC image attachments when possible; cached non-image files are passed as local path references appended to the prompt
- Inbound and outbound media byte limits are configured under `media`
- When Pi mentions existing local image/file paths under `allowed_roots` or `data_dir`, Hitch attempts to upload up to five artifacts back to Telegram or WeChat
- Outbound artifact delivery attempts are recorded in the audit log

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

Pi config behavior:

- `config_scope: system` starts Pi like your terminal Pi and leaves `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and `PI_OFFLINE` untouched.
- `config_scope: hitch` stores Pi config/session state under `data_dir/pi/...` and defaults `PI_OFFLINE=1` unless already set.
- Model/provider flags can still be passed through `agents.pi.default_args`, for example `--model openai/gpt-4o`.

## Roadmap

- Robust Telegram usage testing
- Native Pi image-content input
- Outbound artifact upload and delivery tracking
- Real approval rendering with Telegram buttons
- Discord adapter
- Additional agent backends

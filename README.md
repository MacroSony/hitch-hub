# Hitch

Hitch is a lightweight, self-hosted, chat-native control plane for local coding agents.

It lets you connect chat apps such as Telegram to local coding agents such as Pi, while keeping sessions, working directories, approvals, and artifacts under a small local hub instead of a full dashboard or IDE.

## Status

Hitch is early. The current implementation focuses on the first useful control path:

- Telegram long polling adapter
- Local fake adapter for repeatable testing
- Pi RPC backend
- SQLite session registry
- cwd allowlist checks
- Basic audit logging
- Approval request persistence
- Configurable default cwd
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
- `agents.pi.config_scope`: `system` to use your normal Pi config, or `hitch` to isolate Pi state under `data_dir`

For a personal setup, copy the example to a local config name such as `config.local.yaml` and keep chat IDs and machine-specific paths out of public commits.

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
!cwd
!abort
```

Path behavior:

- `!new pi` uses `default_cwd`
- `!new pi test` resolves to `default_cwd\test`
- `!new pi C:\path\to\repo` uses the absolute path directly
- cwd values outside allowed roots are rejected

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
- Media and file attachment handling
- Real approval rendering with Telegram buttons
- Discord adapter
- Additional agent backends
- Artifact upload and delivery tracking

# Current State

Last verified: 2026-06-27.

Hitch is currently a local TypeScript daemon that connects Telegram or a local fake test channel to Pi running in RPC mode. It is usable for the first control path: create a Pi-backed session in an allowed workspace, send text prompts, receive Pi text/tool/final events back through chat, persist sessions and approval records, and cache inbound Telegram media as local file references.

## Implemented Features

### Runtime and Configuration

- Node.js 24+ TypeScript project using ESM.
- CLI options:
  - `--config <path>` selects a YAML config file. The default is `examples/config.example.yaml`.
  - `--fake-message <text>` can be repeated to run a finite local fake-channel session.
- Optional `.env` loading through `process.loadEnvFile()`.
- YAML config loading and validation with `yaml` and `zod`.
- Relative config paths are resolved relative to the config file directory.
- `~` and `~/...` paths are expanded to the current user's home directory.
- Configured fields include:
  - `data_dir`
  - `default_cwd`
  - `agent_turn_timeout_ms`
  - `users.*.telegram_ids`
  - `users.*.allowed_roots`
  - `channels.fake.enabled`
  - `channels.telegram.enabled`
  - `channels.telegram.bot_token_env`
  - `channels.telegram.allowed_chat_ids`
  - `agents.pi.command`
  - `agents.pi.default_args`
  - `agents.pi.default_policy`

### Channel Adapters

- Fake adapter:
  - Accepts one or more `--fake-message` values.
  - Uses a fixed local fake chat target.
  - Prints outbound messages to stdout.
  - Ends after all fake messages are consumed, then the hub stops active workers.
- Telegram adapter:
  - Uses Bot API `getUpdates` long polling.
  - Receives message text and captions.
  - Captures chat ID, user ID, and Telegram topic/thread ID on inbound events.
  - Filters configured `allowed_chat_ids` before command handling and attachment downloads.
  - Downloads photos and documents from allowed chats when media caching is enabled.
  - Sends outbound text with `sendMessage`.

### Authorization and Path Safety

- Fake-channel events are always authorized.
- Telegram authorization checks:
  - If `channels.telegram.allowed_chat_ids` is non-empty, the chat ID must match.
  - If any configured `users.*.telegram_ids` exist, the Telegram sender user ID must match one of them.
- Workspace roots from all configured users are flattened into one allowed-root list.
- `!new` rejects cwd values outside the allowed roots.
- `!new` rejects cwd values that do not exist or are not directories.
- Path comparisons are case-insensitive on Windows.

### Commands

Implemented hub commands:

- `!new <agent> [cwd]`
  - Only `pi` is currently supported.
  - No cwd uses `default_cwd`.
  - Relative cwd values resolve below `default_cwd`.
  - Absolute cwd values are used directly after normalization and policy checks.
- `!status`
  - Shows the active session ID prefix, agent, status, and cwd.
- `!cwd`
  - Shows the active session cwd.
- `!abort`
  - Aborts the active worker if one exists and marks the session stopped.
- `!approve <approval-id>`
  - Marks a pending persisted approval request as allowed.
- `!deny <approval-id>`
  - Marks a pending persisted approval request as denied.

Prompt behavior:

- Any text that does not start with `!` is sent to the active agent session as a prompt.
- Unknown `!` commands are also treated as prompt text.
- If there is no active session, prompts are rejected with a message telling the user to start one.
- A session with status `running` rejects another prompt until the running turn finishes or is aborted.

### Session Persistence

- Session state is persisted in SQLite at `<data_dir>/hub.sqlite` using Node's `node:sqlite`.
- Stored session fields include platform, chat ID, thread ID, user ID, agent, cwd, backend process ID, status, and timestamps.
- The active session for a chat/thread is the most recently updated non-stopped session.
- Status values currently used are `idle`, `running`, `waiting_approval`, `error`, and `stopped`.

### Pi RPC Backend

- Starts Pi as a child process with configured command and args, normally `pi --mode rpc`.
- On Windows, resolves an npm `.cmd` shim when the configured command has no extension.
- Starts Pi with the session cwd as the process cwd.
- Sets Pi runtime directories under the hub data directory:
  - `PI_CODING_AGENT_DIR=<data_dir>/pi/agent`
  - `PI_CODING_AGENT_SESSION_DIR=<data_dir>/pi/sessions`
- Sets `PI_OFFLINE=1` by default unless the environment already defines `PI_OFFLINE`.
- Writes JSONL prompt and abort messages to Pi stdin.
- Reads JSONL events from Pi stdout.
- Captures stderr as a tail and only includes it when the process exits abnormally.
- Maps Pi events into hub events:
  - `agent_start` / `turn_start` -> running status
  - `message_update` text deltas -> streamed text buffer
  - `agent_end` -> final message
  - `tool_execution_start` -> tool-start chat message
  - `tool_execution_end` -> tool-result chat message when text is present
  - `extension_ui_request` -> approval request unless it is a fire-and-forget UI method
  - `extension_error` -> final error text
  - failed `response` -> final error text
- Ignores fire-and-forget Pi extension UI methods such as `notify`, `setStatus`, `setWidget`, `setTitle`, and `set_editor_text`.

### Inbound Media Cache

- Telegram photos and documents from allowed chats are downloaded through `getFile`.
- For photos, the largest available photo variant is selected.
- Documents with image MIME types are represented as image attachments; other documents are represented as file attachments.
- Inbound files are cached under `<data_dir>/media/inbound`.
- Cache filenames are SHA-256-addressed and keep a safe extension when one can be inferred from filename or MIME type.
- Duplicate content reuses the same cached path.
- Attachment metadata includes source, kind, filename, MIME type, size, local path, SHA-256, and original Telegram file ID when available.
- Cached attachments are passed to Pi as text references appended to the prompt, including local path, filename, MIME type, and SHA-256.

### Delivery, Timeouts, and Audit

- Outbound text is chunked at 3900 characters.
- Agent turns are aborted after `agent_turn_timeout_ms`.
- Audit events are appended as JSONL under `<data_dir>/logs/audit.jsonl`.
- Audited events include session creation, rejected cwd, inbound prompts, worker start, worker completion, worker errors, worker timeout, aborts, and approval decisions.
- Approval requests are persisted in SQLite with raw JSON, status, cwd, title, preview, risk, and timestamps.

### Smoke and Health Scripts

Available npm scripts:

- `npm run dev`
- `npm run typecheck`
- `npm run build`
- `npm run smoke:fake`
- `npm run smoke:media-cache`
- `npm run smoke:pi-rpc`
- `npm run smoke:telegram-getme`
- `npm run smoke:telegram-updates`

## Usage

Install dependencies:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' install
```

Create `.env` when using Telegram:

```text
TELEGRAM_BOT_TOKEN=123456:your-token
```

Edit a config file, usually based on `examples/config.example.yaml`:

```yaml
data_dir: .remote-agent-hub
default_cwd: ..
agent_turn_timeout_ms: 60000

users:
  local:
    telegram_ids: []
    allowed_roots:
      - ..

channels:
  fake:
    enabled: true
  telegram:
    enabled: true
    bot_token_env: TELEGRAM_BOT_TOKEN
    allowed_chat_ids: []

agents:
  pi:
    command: pi
    default_args:
      - --mode
      - rpc
    default_policy: ask
```

Run with Telegram:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev -- --config examples/config.example.yaml
```

Run with local fake messages:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "!cwd"
```

Typical chat commands:

```text
!new pi
!new pi AgentHub
!new pi C:\path\to\repo
!status
!cwd
!abort
!approve <approval-id>
!deny <approval-id>
```

Typical prompt flow:

```text
!new pi AgentHub
Summarize this repository.
```

Media usage:

- Send a Telegram photo or document to the bot after creating an active session.
- Caption text becomes the prompt text.
- If no caption is provided, Hitch asks Pi to inspect the cached local file references.
- Current media delivery to Pi is by local-path text reference, not native Pi image-content blocks.

Run local checks:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run typecheck
& 'C:\Program Files\nodejs\npm.cmd' run build
& 'C:\Program Files\nodejs\npm.cmd' run smoke:fake
& 'C:\Program Files\nodejs\npm.cmd' run smoke:media-cache
& 'C:\Program Files\nodejs\npm.cmd' run smoke:pi-rpc
```

Check Telegram credentials without printing the token:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run smoke:telegram-getme
& 'C:\Program Files\nodejs\npm.cmd' run smoke:telegram-updates
```

## Current Limitations

- Only the Pi backend is implemented.
- Only Telegram and the local fake adapter are implemented.
- `channels.fake.enabled` exists in config but fake mode is selected by passing `--fake-message`.
- `!sessions`, `!switch`, `!cd`, `!compact`, and `!files` are planned but not implemented.
- Approval decisions are persisted and audited, but they are not sent back into Pi as real approval responses.
- Telegram inline approval buttons are not implemented.
- Telegram outbound messages do not currently include thread/topic routing.
- Outbound image/file artifact upload is not implemented.
- Native Pi image-content input is not implemented; cached media is passed as prompt text containing local paths.
- Delivery coalescing, message editing, retry, idempotency, and long-output file fallback are not implemented.
- Media size validation, MIME sniffing, conversion, OCR, and transcription are not implemented.
- User-specific allowed roots are not enforced separately; all configured roots are combined.
- Session switching and session listing are not implemented; the active session is the most recently updated non-stopped session for the chat/thread.
- Discord, WeChat, QQ, Feishu/Lark, Claude, Codex, OpenCode, Gemini, and PTY support remain future work.

## Documentation Freshness

- `README.md` is the setup and quick-usage guide. It has been refreshed to include the current inbound media cache and approval decision commands.
- `implementation_steps.md` is the historical implementation checklist. It matches the current feature level through Checkpoint 5, with Telegram smoke results representing the environment at the time they were run.
- `plan.md` is an aspirational architecture and roadmap document. It intentionally lists planned commands, channels, backends, media behavior, and delivery semantics that are not implemented yet. Use this file as a roadmap, not as a current-state reference.

## Verification on 2026-06-27

Passed:

- `npm.cmd run typecheck`
- `npm.cmd run build`
- `npm.cmd run smoke:fake`
- `npm.cmd run smoke:media-cache`
- `npm.cmd run smoke:pi-rpc`
- `npm.cmd run smoke:telegram-getme`
- `npm.cmd run smoke:telegram-updates`

Notes:

- Direct `npm ...` commands are blocked by the local PowerShell execution policy because they resolve to `npm.ps1`; use `npm.cmd` on this machine.
- Telegram health checks used the configured token environment and did not print the token. `getMe` returned `@piagenthub77_bot` with id `8832939480`; `getUpdates` returned `visible_updates=0`.

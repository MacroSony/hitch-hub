# Implementation Steps

This file tracks the implementation in iterations. Each iteration should be appended or updated as work progresses, with completed items checked off only after they are implemented and verified.

Status legend:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs a decision

## Design Decision: Agent Config Ownership

Hitch should default to using system-level agent configuration. The product boundary is that Hitch is a remote control and session hub around local agents, not a replacement config/auth/plugin manager for those agents.

Default ownership:

- Hitch owns Telegram credentials, chat/user authorization, allowed roots, default cwd, session lifecycle, approval routing, media caching, and remote command handling.
- The agent owns provider auth, default model/provider selection, plugins, extensions, MCP servers, and other native agent preferences.
- Hitch may pass launch-time overrides such as `--model` or `--provider`, but should not permanently rewrite native agent configuration.

Config scope policy:

- `config_scope: system` is the recommended default for normal use. It starts Pi like a terminal-launched Pi and inherits the user's existing system Pi config, auth, sessions, plugins, and preferences.
- `config_scope: hitch` remains useful for smoke tests, demos, isolated bot profiles, and future controlled automation environments where Hitch-owned agent state is intentional.

This keeps the mental model simple: Hitch is the transport, authorization, cwd, session, and approval layer; the selected agent remains the source of truth for agent-specific behavior.

## Iteration 1: Minimal Local Control Path

Goal: prove that the hub can receive a text request, route it to a real agent worker in a chosen workspace, stream the result back through a channel boundary, and record enough state to make the next iteration safe.

Scope:

- One channel path: Telegram or a local fake adapter if Telegram credentials are not configured yet.
- One backend path: Pi RPC.
- One active session at a time.
- Text-only first; image/file handling comes after the Pi RPC event shape is confirmed.
- Safety baseline included from the start: cwd allowlist, user/chat allowlist, approval request model, and audit log skeleton.

Checklist:

- [x] Create the TypeScript project skeleton.
- [x] Add config loading with schema validation.
- [x] Add SQLite session registry with a minimal `HubSession` table.
- [x] Add a local fake channel adapter for repeatable testing without IM credentials.
- [x] Add Telegram adapter shell with long polling, inbound text parsing, and outbound text send.
- [x] Verify the Pi RPC protocol shape by running a controlled local smoke test.
- [x] Implement Pi worker spawn with explicit `cwd`.
- [x] Map inbound text to a Pi prompt/follow-up.
- [x] Map Pi text/final/status events into normalized hub events.
- [x] Implement one-active-turn-per-session enforcement.
- [x] Implement `!new`, `!status`, `!cwd`, and `!abort`.
- [x] Add cwd allowlist checks before worker start.
- [x] Add user/chat allowlist checks before command handling.
- [x] Add approval request data model and persistence, even if no backend approval flow is fully wired yet.
- [x] Add audit log entries for session creation, worker start/stop, inbound prompts, aborts, and approval decisions.
- [x] Add basic delivery chunking for long text responses.
- [x] Document required local environment variables and config in `examples/config.example.yaml`.
- [x] Run a local fake-adapter smoke test.
- [!] Run a Telegram smoke test if credentials are available.

Exit criteria:

- [x] A user can create a Pi-backed session for an allowed cwd.
- [x] A text message reaches Pi and a response is delivered back through the channel adapter.
- [x] Session state survives process restart.
- [x] Unsafe cwd/user/chat inputs are rejected before worker start.
- [x] Long output does not break delivery.
- [x] The implementation leaves a clear path for Iteration 2 media handling and real approvals.

Notes:

- Use `.cmd` shims on Windows when invoking npm-installed CLIs from PowerShell if `.ps1` execution is blocked.
- Keep Pi RPC event handling behind a backend adapter boundary; do not leak Pi-specific event names into hub core.
- Do not add Discord, OpenCode, Claude, Codex, image handling, or web dashboard work in this iteration unless the minimal path is already verified.

### Checkpoint 1: Project Skeleton and Fake Adapter

Committed: `e5be426`

Changes:

- Initialized the Git repository.
- Added TypeScript project configuration and npm scripts.
- Added config loading with schema validation.
- Added SQLite session registry.
- Added fake channel adapter.
- Added command handling for `!new`, `!status`, `!cwd`, and `!abort`.
- Added cwd allowlist enforcement.
- Added audit log skeleton.
- Added Pi RPC backend process boundary.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; returned `No active session.`
- `npm.cmd run dev -- --config examples/config.example.yaml --fake-message "!new pi ."`: passed; created a persisted Pi session.
- `npm.cmd run dev -- --config examples/config.example.yaml --fake-message "!cwd"`: passed after session creation; returned the workspace cwd.
- `npm.cmd run dev -- --config examples/config.example.yaml --fake-message "!new pi C:\Windows"`: passed; rejected cwd outside allowed roots.

### Checkpoint 2: Pi RPC, Telegram Polling, Approvals, and Timeouts

Committed: `f205b38`

Changes:

- Implemented protocol-compliant JSONL parsing for Pi RPC stdout.
- Mapped Pi RPC `prompt`, `message_update`, `agent_end`, tool, and extension UI events into hub events.
- Implemented Telegram `getUpdates` long polling for inbound text messages.
- Added approval request persistence and `!approve` / `!deny` decision recording.
- Added worker start/completion/error/timeout audit events.
- Added basic long-text chunking.
- Added isolated smoke-test config.
- Added configurable agent turn timeout to avoid hanging on provider/auth waits.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; returned `No active session.` using isolated smoke state.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!deny missing"`: passed; returned `No pending approval found for missing.`
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi ." --fake-message "Say only OK."`: passed as an environment-limited prompt smoke; Pi emitted an approval request, the hub persisted/rendered it, then the configured 5000ms turn timeout aborted cleanly.
- Telegram smoke test: skipped because `TELEGRAM_BOT_TOKEN` is absent.
- Live model-answer smoke test: blocked by absent common provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`); the timeout path was verified instead.

### Checkpoint 3: Default Cwd and Extension Notification Cleanup

Committed: `7c879d7`

Changes:

- Added `default_cwd` config.
- Changed `!new <agent>` to use `default_cwd`.
- Changed relative `!new <agent> <path>` requests to resolve below `default_cwd`.
- Kept absolute `!new <agent> <path>` behavior unchanged.
- Rejected missing or non-directory cwd values before worker start.
- Stopped treating fire-and-forget Pi extension UI requests such as `notify` as approvals.
- Moved Pi runtime state under the hub data directory for hub-started Pi workers.
- Stopped sending normal Pi stderr startup chatter to chat.
- Stopped workers when a finite adapter such as the fake adapter finishes, so smoke tests exit cleanly.

Cause of earlier false approval:

- Pi emitted an `extension_ui_request` with `method: "notify"` from the `pi-comfyui-paint` extension.
- The hub incorrectly mapped all extension UI requests to approval requests.
- Fire-and-forget UI methods are now ignored instead of being persisted/rendered as approvals.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi"`: passed; cwd resolved to `C:\Users\James\programming`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi AgentHub"`: passed; cwd resolved to `C:\Users\James\programming\AgentHub`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi AgentHub" --fake-message "Say only OK."`: passed; no false approval was rendered, and the finite fake-adapter process exited cleanly after Pi reported missing provider auth.

## Iteration 2: Public Hygiene and Media MVP

Goal: make the public repository safer to share, add repeatable Telegram health checks, and then begin the media path with cached inbound Telegram attachments.

Scope:

- Keep Telegram + Pi as the only supported runtime pair.
- Keep outbound artifact upload for a later checkpoint unless it falls out naturally from inbound media work.
- Do not add Discord, second agent backends, or dashboard UI in this iteration.

Checklist:

- [x] Replace public example config values with portable placeholders.
- [x] Add Telegram health smoke scripts that do not print bot tokens.
- [x] Fix package-lock project naming after the Hitch rename.
- [x] Record checkpoint test results.
- [x] Add normalized inbound attachment types.
- [x] Add a media cache under `data_dir`.
- [x] Parse Telegram photos/documents from allowed chats.
- [x] Download Telegram files into the media cache with SHA-256 metadata.
- [x] Pass cached image/file references through the hub to Pi prompts.
- [x] Verify text-only behavior still works.

### Checkpoint 4: Public Hygiene and Telegram Health Checks

Committed: `4ad0e37`

Changes:

- Replaced personal paths and chat IDs in public example configs with portable relative defaults.
- Added Telegram `getMe` and `getUpdates` smoke scripts that report only bot metadata and visible update counts.
- Fixed `package-lock.json` package naming after the Hitch rename.
- Updated README usage examples to avoid machine-specific paths.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; returned the existing persisted smoke session at the portable repo cwd.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run smoke:telegram-getme`: passed with network access; Telegram returned bot `@piagenthub77_bot`, id `8832939480`, `can_join_groups=true`.
- `npm.cmd run smoke:telegram-updates`: passed with network access; Telegram returned `visible_updates=0`.

### Checkpoint 5: Inbound Media Cache Foundation

Committed: `2c4fcab`

Changes:

- Added normalized inbound attachment metadata on channel events and agent input.
- Added a media cache under `data_dir/media/inbound` with SHA-256-addressed files and duplicate-content reuse.
- Added Telegram photo/document parsing for allowed chats.
- Added Telegram `getFile` and file download handling into the media cache.
- Passed cached attachment references into Pi prompts as local file paths with filename, MIME, and SHA-256 metadata.
- Added a local media-cache smoke test.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; text-only channel behavior still works.
- `npm.cmd run smoke:media-cache`: passed; duplicate content reused the same SHA-256 cache path under `data_dir/media/inbound`.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run smoke:telegram-getme`: passed with network access; Telegram returned bot `@piagenthub77_bot`, id `8832939480`, `can_join_groups=true`.
- `npm.cmd run smoke:telegram-updates`: passed with network access; Telegram returned `visible_updates=0`.

Notes:

- The first media path passes cached image/file references to Pi as prompt text. Native Pi image-content wiring should be added after verifying the current Pi RPC image message shape against a live media update.
- Outbound artifact upload is intentionally left for the next media checkpoint.

### Checkpoint 6: Pi Config Scope Selection

Committed: this commit

Changes:

- Added `agents.pi.config_scope` with `hitch` and `system` modes.
- Kept `hitch` mode as the isolated behavior that stores Pi state under `data_dir/pi/...`.
- Added `system` mode so Hitch leaves Pi config/session environment variables untouched and uses the normal system Pi configuration.
- Updated example configs and README notes for the new Pi config behavior.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; text-only channel behavior still works with the isolated smoke config.
- `npm.cmd run smoke:pi-rpc`: passed with `examples/config.smoke.yaml`; Pi RPC `get_state` returned `success=true` using `config_scope: hitch`.
- `npm.cmd run smoke:media-cache`: passed; duplicate content reused the same SHA-256 cache path under `data_dir/media/inbound`.
- `npm.cmd run smoke:pi-rpc -- --config examples/config.example.yaml`: passed; Pi RPC `get_state` returned `success=true` using `config_scope: system`. Pi emitted expected sandbox warnings when trying to touch global Pi settings outside the workspace.

### Checkpoint 7: Telegram Resilience and Busy Session Cleanup

Committed: this commit

Changes:

- Added retry/backoff around transient Telegram `fetch` failures for polling, sends, `getFile`, and file downloads.
- Kept fatal Telegram auth/config errors fatal while allowing random network failures to retry without crashing the hub.
- Changed hub event handling to use tracked background tasks, so Telegram can keep receiving `!status` and `!abort` while a Pi turn is active.
- Added safe outbound send handling so a failed error reply does not crash the hub process.
- Added Pi backend liveness checks and removed dead workers after process exit.
- Marked a session idle when the Pi event stream exits without a clean `agent_end`, preventing stale `running` sessions after tool cancellation paths.
- Improved the busy-session response to show when the active turn last updated and point users to `!status` or `!abort`.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; returned the persisted smoke session status.
- `npm.cmd run smoke:media-cache`: passed; duplicate content reused the same SHA-256 cache path under `data_dir/media/inbound`.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run smoke:telegram-getme`: passed with network access; Telegram returned bot `@piagenthub77_bot`, id `8832939480`, `can_join_groups=true`.
- `npm.cmd run smoke:telegram-updates`: passed with network access; Telegram returned `visible_updates=1`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "Say only OK." --fake-message "!abort"`: passed; the hub created a session and processed `!abort` without hanging behind the prompt task.

### Checkpoint 8: Command Routing, Pi Model RPC, and Outbound Artifacts

Committed: this commit

Changes:

- Changed unknown `!` commands to stop at Hitch with an explicit unknown-command error instead of leaking to the active Pi prompt.
- Added real Pi RPC model commands:
  - `!model` shows the current Pi RPC model through `get_state`.
  - `!model <provider>/<model-id>` switches through Pi RPC `set_model`.
  - `/model <provider>/<model-id>` is accepted as a natural alias for `!model`.
  - `!models [filter]` lists available Pi RPC models through `get_available_models`.
- Added a bounded outbound artifact path scanner for Pi final text and tool results.
- Added Telegram outbound artifact upload using `sendPhoto` for common image paths and `sendDocument` for other local files.
- Kept raw shell passthrough unimplemented even though Pi RPC exposes `bash`; this needs an explicit remote safety design before exposing it over Telegram.

Resume and multi-session planning:

- The original plan already includes `!sessions`, `!switch`, per-chat/per-thread sessions, thread/session mapping, and multiple sessions.
- Do not implement resume/multiple sessions in this checkpoint.
- Next design pass should decide whether the default session key is chat, chat thread/topic, explicit session name, or a combination.
- Resume should be implemented as explicit session listing and switching first, not as hidden automatic reuse across unrelated chats.
- Multiple simultaneous sessions should initially use separate Telegram chats/topics or explicit `!switch`, with one active turn per session preserved.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; returned the persisted smoke session status.
- `npm.cmd run smoke:media-cache`: passed; duplicate content reused the SHA-256 cache path under `data_dir/media/inbound`.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!wagawaga"`: passed; returned `Unknown Hitch command: !wagawaga`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "!model"`: passed; routed through Pi RPC `get_state` and returned the isolated smoke model as `unknown/unknown`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "!models unknown"`: passed; routed through Pi RPC `get_available_models` and returned `No models matched.` in the isolated smoke config.
- `npm.cmd run smoke:telegram-getme`: passed with network access; Telegram returned bot `@piagenthub77_bot`, id `8832939480`, `can_join_groups=true`.
- `npm.cmd run smoke:telegram-updates`: passed with network access; Telegram returned `visible_updates=0`.

Manual follow-up needed:

- Live Telegram artifact upload should be tested with a Pi/ComfyUI result that mentions an existing local image path.
- Live `/model <provider>/<model-id>` should be tested against the user's system Pi config because the isolated smoke config intentionally has an `unknown/unknown` model.

### Checkpoint 9: Agent-Native Slash Command Routing

Committed: this commit

Changes:

- Added `agent_command` as a first-class parsed command type.
- Changed all leading `/...` messages to route to the active backend as agent-native commands.
- Kept `!` as the Hitch command namespace, with unknown `!` commands still rejected.
- Kept `!model` and `!models` as compatibility aliases that rewrite to `/model` and `/models`.
- Added `AgentBackend.executeCommand()` so Hitch core does not need to maintain backend-specific slash command knowledge.
- Moved `/model` and `/models` handling from Hitch core into `PiRpcBackend`.
- For Pi, `/model` and `/models` use typed Pi RPC calls. Other slash commands are forwarded through Pi's command/prompt path so Pi extensions, skills, and prompt templates own their behavior.
- Tightened outbound artifact discovery so only existing files under `allowed_roots` or `data_dir` are eligible for upload.

Test results:

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- `npm.cmd run smoke:fake`: passed; returned the persisted smoke session status.
- `npm.cmd run smoke:media-cache`: passed; duplicate content reused the SHA-256 cache path under `data_dir/media/inbound`.
- `npm.cmd run smoke:pi-rpc`: passed; Pi RPC `get_state` returned `success=true`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!wagawaga"`: passed; returned `Unknown Hitch command: !wagawaga`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "/model"`: passed; routed through backend command handling and returned the isolated smoke model as `unknown/unknown`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "/models unknown"`: passed; routed through backend command handling and returned `No models matched.`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "!model"`: passed; compatibility alias rewrote to `/model` and returned the isolated smoke model as `unknown/unknown`.
- `npm.cmd run dev -- --config examples/config.smoke.yaml --fake-message "!new pi" --fake-message "/definitely-hitch-pass-through-smoke"`: passed; routed to Pi's command/prompt path and returned the expected smoke-config provider auth error. The artifact allowlist prevented unrelated global Pi documentation paths in the error text from being uploaded.
- `npm.cmd run smoke:telegram-getme`: passed with network access; Telegram returned bot `@piagenthub77_bot`, id `8832939480`, `can_join_groups=true`.
- `npm.cmd run smoke:telegram-updates`: passed with network access; Telegram returned `visible_updates=0`.

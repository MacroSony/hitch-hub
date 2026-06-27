# Implementation Steps

This file tracks the implementation in iterations. Each iteration should be appended or updated as work progresses, with completed items checked off only after they are implemented and verified.

Status legend:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs a decision

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

Committed: this commit

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

Committed: this commit

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

Committed: pending

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

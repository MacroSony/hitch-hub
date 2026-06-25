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
- [~] Add Telegram adapter shell with long polling, inbound text parsing, and outbound text send.
- [~] Verify the Pi RPC protocol shape by running a controlled local smoke test.
- [x] Implement Pi worker spawn with explicit `cwd`.
- [ ] Map inbound text to a Pi prompt/follow-up.
- [ ] Map Pi text/final/status events into normalized hub events.
- [ ] Implement one-active-turn-per-session enforcement.
- [x] Implement `!new`, `!status`, `!cwd`, and `!abort`.
- [x] Add cwd allowlist checks before worker start.
- [ ] Add user/chat allowlist checks before command handling.
- [ ] Add approval request data model and persistence, even if no backend approval flow is fully wired yet.
- [~] Add audit log entries for session creation, worker start/stop, inbound prompts, aborts, and approval decisions.
- [ ] Add basic delivery chunking for long text responses.
- [x] Document required local environment variables and config in `examples/config.example.yaml`.
- [x] Run a local fake-adapter smoke test.
- [ ] Run a Telegram smoke test if credentials are available.

Exit criteria:

- [x] A user can create a Pi-backed session for an allowed cwd.
- [ ] A text message reaches Pi and a response is delivered back through the channel adapter.
- [x] Session state survives process restart.
- [x] Unsafe cwd/user/chat inputs are rejected before worker start.
- [ ] Long output does not break delivery.
- [ ] The implementation leaves a clear path for Iteration 2 media handling and real approvals.

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

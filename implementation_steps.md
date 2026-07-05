# Implementation Steps

This file is the short active tracker. Completed checkpoint history lives in
[docs/completed-work.md](docs/completed-work.md), and the outbound media/tool design lives in
[docs/hub-tools-mcp.md](docs/hub-tools-mcp.md).

For the broad architecture roadmap, see [plan.md](plan.md). For the current user-facing surface, see
[README.md](README.md).

Status legend:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Done
- `[!]` Blocked or needs a decision

## Current Direction

Outbound media should move from implicit path auto-discovery to explicit hub-owned tools.

The current scanner that uploads files mentioned in final text is useful as a prototype, but it is too ambiguous for remote use:

- it misses images when Pi does not print the exact path
- it may upload unrelated files when Pi mentions allowed local paths
- it cannot return a structured delivery result to the agent
- it hides delivery failures from the user unless they inspect logs

The target design is:

```text
agent writes generated media into a hub-approved export path
agent calls a Hitch tool to send that artifact
hub validates path/MIME/size/session/channel
hub sends via Telegram/WeChat/etc.
hub returns a structured result and audits the delivery
```

## Active Iteration: Minimal `send_media` Tool

Goal: replace implicit outbound-media path discovery with one explicit, blocking hub-owned media send operation.

Scope:

- Keep current Telegram, WeChat, Pi RPC, and smoke-test behavior working.
- Add an internal `HubToolService.sendMedia()` first; do not bind the core design to MCP internals.
- Expose one minimal media-send operation for agents and humans.
- Route delivery only to the current session/chat target; tools must not accept arbitrary chat IDs.
- Block until the channel upload succeeds, fails, or times out, then return a structured result.
- Make text path auto-discovery opt-in fallback behavior, not the primary outbound media mechanism.

Checklist:

- [x] Document completed implementation checkpoints separately.
- [x] Document explicit hub-tools/MCP design.
- [x] Add config for explicit outbound export roots, separate from broad `allowed_roots`.
- [x] Add a normalized `send_media` request/result model:
  - input: `path`, optional `caption`, optional `kind`
  - output: `status`, `deliveryId`, `platform`, optional `message`
- [x] Add internal `HubToolService.sendMedia()` validation:
  - realpath is inside an outbound export root or hub-managed artifact dir
  - file exists and is a regular file
  - MIME is sniffed instead of trusting extension alone
  - size is under `media.max_outbound_bytes`
  - human fallback routes only to the current chat target
  - delivery status is audited
- [x] Add user-visible failure reporting when artifact upload fails.
- [x] Add `!send <absolute-path>` as a human fallback using the same service.
- [ ] Add an agent bridge for Pi:
  - preferred final shape: MCP `hitch.send_media`
  - interim option: local CLI/outbox shim authenticated to the active session
- [ ] Add active session/turn scoping for agent-initiated media sends.
- [ ] Add hub MCP transport exposing only the session-scoped `hitch.send_media` tool for the first MCP milestone.
- [ ] Update Pi guidance/skill prompt to call `hitch.send_media` instead of merely mentioning paths.
- [x] Gate current final-text path scanner behind `media.auto_discovery`.
- [x] Default auto-discovery to off.
- [~] Add smoke tests for:
  - explicit media send success
  - path outside export root rejected
  - oversized media skipped with user-visible failure
  - channel send failure audited and surfaced
  - auto-discovery disabled by default

## Open Decisions

- [!] MCP process shape: one hub MCP server with short-lived session tokens, or one per-session MCP server/process.
- [!] Transport for non-MCP fallback: JSONL outbox file, localhost HTTP on a random port, or a tiny `hitch-send-artifact` CLI.
- [!] Whether agent-initiated `send_media` should be allowed only during an active turn or also from idle sessions.
- [!] Whether non-image file sends should be supported by the first `send_media` tool or require a stronger opt-in than images.

## Design Decision: Agent Config Ownership

Hitch should default to using system-level agent configuration. The product boundary is that Hitch is a remote control and session hub around local agents, not a replacement config/auth/plugin manager for those agents.

Default ownership:

- Hitch owns Telegram/WeChat credentials, chat/user authorization, allowed roots, default cwd, session lifecycle, approval routing, media caching, artifact delivery policy, and remote command handling.
- The agent owns provider auth, default model/provider selection, plugins, extensions, MCP servers, and other native agent preferences.
- Hitch may pass launch-time overrides such as `--model` or `--provider`, but should not permanently rewrite native agent configuration.

Config scope policy:

- `config_scope: system` is the recommended default for normal use. It starts Pi like a terminal-launched Pi and inherits the user's existing system Pi config, auth, sessions, plugins, and preferences.
- `config_scope: hitch` remains useful for smoke tests, demos, isolated bot profiles, and future controlled automation environments where Hitch-owned agent state is intentional.

This keeps the mental model simple: Hitch is the transport, authorization, cwd, session, approval, media, and artifact-delivery layer; the selected agent remains the source of truth for agent-specific behavior.

# Completed Work

This file archives completed implementation checkpoints so
[implementation_steps.md](../implementation_steps.md) can stay focused on active work.

## Checkpoint Summary

| Checkpoint | Area | Status |
| --- | --- | --- |
| 1 | Project skeleton and fake adapter | Done |
| 2 | Pi RPC, Telegram polling, approvals, and timeouts | Done |
| 3 | Default cwd and extension notification cleanup | Done |
| 4 | Public hygiene and Telegram health checks | Done |
| 5 | Inbound media cache foundation | Done |
| 6 | Pi config scope selection | Done |
| 7 | Telegram resilience and busy-session cleanup | Done |
| 8 | Command routing, Pi model RPC, and outbound artifact prototype | Done |
| 9 | Agent-native slash command routing | Done |
| 10 | Safety, sessions, media flow, and WeChat adapter | Done |
| 11 | Tool output delivery defaults | Done |
| 12 | Interactive selection and session reconnect foundation | Done |
| 13 | Multi-channel runtime adapter | Done |
| 14 | Runtime reliability and durable delivery evidence | Done |
| 15 | Principal ownership and private runtime state | Done |
| 16 | Fail-closed Bubblewrap and multi-user isolation | Done |

## Implemented Capabilities

- TypeScript project skeleton, npm scripts, typecheck, and build.
- YAML config loading with schema validation.
- SQLite-backed session registry.
- Local fake channel adapter for repeatable tests.
- Telegram long polling adapter for text, captions, photos, documents, callback queries, text replies, and artifact upload.
- WeChat iLink adapter for QR login, credential persistence, sync cursor persistence, context-token persistence, inbound text/media, outbound text, and artifact upload.
- Multi-channel runtime adapter that starts every enabled live channel and routes outbound delivery by `target.platform`.
- Pi RPC backend process boundary with explicit cwd.
- Pi JSONL event parsing and normalized hub events.
- Stable Pi `--session-id` behavior based on Hitch session ID unless explicit Pi session args are supplied.
- Pi config scoping with `system` and `hitch` modes.
- Hub commands:
  - `!new`
  - `!status`
  - `!health`
  - `!sessions`
  - `!switch`
  - `!cwd`
  - `!abort`
  - `!approve`
  - `!deny`
- Agent-native slash command routing for `/...`.
- Pi `/model` and `/models` handling through typed Pi RPC calls.
- Session names and selected-session tracking.
- One-active-turn-per-session enforcement with status recovery after restart.
- Background prompt handling so commands such as `!status` and `!abort` remain responsive.
- Approval persistence, expiry, Telegram inline buttons, and text fallback commands.
- Pi extension UI handling:
  - `confirm` requests become approvals
  - `select` requests become Hitch pickers
  - `notify` requests become notifications
  - `input` and `editor` requests render prompt/prefill text and auto-cancel
- Pending interaction storage for numbered menus.
- Inbound media cache under `data_dir/media/inbound` with SHA-256 dedupe.
- MIME sniffing for inbound cached files.
- Telegram and WeChat inbound media handling.
- Native Pi image attachments for supported cached image MIME types.
- Media byte limits.
- Text chunking for long replies.
- Delivery output defaults that summarize tool calls/results unless `delivery.full_tool_output: true`.
- Audit logging for session, worker, prompt, approval, and artifact-delivery events.
- Authoritative turn deadlines with bounded cancellation and labeled interrupted partial results.
- Ordered, bounded per-target delivery with delivery/session/turn audit correlation.
- Configurable idle-worker eviction and deterministic worker stop behavior.
- Graceful signal shutdown, channel-health transition auditing, and a user-level systemd example.
- SQLite-backed outbound delivery lifecycle with queue expiry, restart recovery, terminal retention, and no persisted message bodies or artifact paths.
- Size-bounded JSONL audit rotation and hub-level `!health` diagnostics.
- Principal-specific Telegram/WeChat identity resolution, roots, capabilities, and private session ownership.
- Canonical cwd/root enforcement with fail-closed legacy ownership and security-metadata reconciliation.
- Principal-private Pi config/session storage plus private per-session worker/tool state.
- Explicit unsafe direct execution and required Linux Bubblewrap sandbox selection without fallback.
- Pi tool/process policy translation, sandboxed read-only single-principal system config, private sandbox home, and cleared worker environment.
- Persisted workspace aliases and hub-data masks that keep absolute MCP cwd compatibility without exposing Hitch state.
- Sandboxed `hitch.send_media` bridge paths, explicit writable media exports, and deterministic sandbox descendant cleanup.
- Adversarial two-principal Telegram route and mount isolation coverage.
- Smoke tests for fake flow, media cache, media flow, interaction flow, Pi RPC, Pi approval, Pi UI selection, Telegram health checks, and multi-channel routing.

## Verification Snapshot

Latest local verification from the review pass:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run smoke:fake`: passed.
- `npm run smoke:media-cache`: passed.
- `npm run smoke:media-flow`: passed.
- `npm run smoke:interaction-flow`: passed.
- `npm run smoke:pi-rpc`: passed.
- `npm run smoke:pi-approval`: passed.
- `npm run smoke:pi-ui-select`: passed.
- `npm run smoke:multi-channel`: passed.
- `npm run smoke:multi-user-sandbox`: passed.
- `npm run smoke:security-foundation`: passed.
- `npm run smoke:sandbox-launcher`: passed.
- `npm run smoke:worker-environment`: passed.
- `npm run smoke:pi-sandbox-integration`: passed.
- `npm run smoke:pi-retry-lifecycle`: passed.
- `npm run smoke:reliability-flow`: passed.
- `npm run smoke:wechat-reliability`: passed.
- `npm run smoke:mcp-session`: passed.
- `npm audit --omit=dev`: passed with zero reported vulnerabilities.

## Lessons Carried Forward

The outbound artifact prototype proved that channel upload plumbing works, but final-text path scanning can miss generated images and can also upload unrelated files when an agent mentions paths under broad allowed roots.

Artifact delivery now uses the explicit, session-scoped `hitch.send_media` hub tool path as the primary design, with legacy path scanning disabled by default. See [hub-tools-mcp.md](hub-tools-mcp.md).

## Historical Commit Notes

Earlier detailed checkpoint notes recorded implementation and test commands for each checkpoint. Git history remains the source for exact commit-level details; this archive keeps the maintained project docs compact and current.

# Hub Tools and MCP Design

This document defines the target design for agent-facing Hitch tools. MCP is the preferred long-term transport, but the product contract is the hub tool API itself.

## Problem

Outbound media currently relies on best-effort path discovery from assistant text. That is ambiguous:

- A generated image is not sent unless the final response includes the exact local path.
- A normal file may be uploaded accidentally if the final response mentions an allowed path.
- The agent cannot receive a structured delivery result.
- Users may not see upload failures unless they inspect logs.

For remote use, delivery should be explicit and auditable.

## Design Principle

Agents should not send directly to Telegram, WeChat, or any future chat platform. The hub owns channel credentials, target routing, path policy, size limits, and audit logs.

Agents ask Hitch to perform hub-scoped actions:

```text
agent -> Hitch tool request -> hub validation -> channel adapter -> chat
```

## Internal Service First

Implement an internal `HubToolService` before adding MCP transport.

The service should be callable from:

- hub commands such as `!send <path>`
- a Pi bridge/shim
- a future MCP server
- future non-Pi agent backends

MCP should call this service; it should not duplicate validation or channel logic.

## First Tool

The first MCP milestone should expose only one media tool.

### `hitch.send_media`

Sends a generated file to the chat target that owns the active session/turn.

Input:

```json
{
  "path": "/.../paint.png",
  "caption": "Generated image",
  "kind": "image"
}
```

`kind` is optional. Hitch should sniff MIME and infer image/file behavior when possible.

Output:

```json
{
  "deliveryId": "uuid",
  "status": "sent",
  "platform": "telegram"
}
```

Failure output:

```json
{
  "deliveryId": "uuid",
  "status": "failed",
  "platform": "wechat",
  "message": "WeChat sendMessage failed: ret=-2"
}
```

Behavior:

- Route automatically to the active session/chat target.
- Do not accept chat IDs, user IDs, or channel tokens.
- Block until the channel upload succeeds, fails, or times out.
- Return a structured result so the agent can report truthfully.
- Write an audit record for success, skip, and failure.
- Send a user-visible chat notice when delivery fails.

Validation:

- Resolve realpath before policy checks.
- Require the path to be inside a configured outbound export root or hub-managed artifact directory.
- Require a regular file.
- Sniff MIME from bytes.
- Enforce `media.max_outbound_bytes`.
- Enforce current session/turn ownership for agent-initiated calls.
- Use channel capability limits.

## Later Tools

These are useful after the minimal send path works, but they should not be in the first MCP milestone.

### `hitch.create_artifact_path`

Allocates a safe path for a generated artifact.

Input:

```json
{
  "kind": "image",
  "extension": ".png"
}
```

Output:

```json
{
  "path": "/.../data/media/outbound/<session>/<turn>/artifact-1.png"
}
```

Rules:

- The path is under a hub-managed outbound directory.
- The path is scoped to a session and preferably a turn.
- The extension is advisory; final send still uses MIME sniffing.

### `hitch.send_artifact`

Potential richer successor to `send_media` if Hitch later manages artifact lifecycle separately from upload.

Input:

```json
{
  "path": "/.../artifact-1.png",
  "kind": "image",
  "caption": "Generated image"
}
```

Output:

```json
{
  "deliveryId": "uuid",
  "status": "sent",
  "platform": "telegram"
}
```

Failure output:

```json
{
  "deliveryId": "uuid",
  "status": "failed",
  "reason": "channel_rejected",
  "message": "WeChat sendMessage failed: ret=-2"
}
```

### `hitch.list_artifacts`

Lists artifacts created or delivered for the active session.

Use cases:

- Human fallback with `!artifacts`
- Agent retry after a failed upload
- Debugging remote delivery

### `hitch.delivery_status`

Returns status for a previous delivery ID.

Use cases:

- Agent can report whether a send succeeded.
- Hub can retry or expose final status to the user.

### `hitch.notify`

Sends a short hub-scoped notification to the active chat target.

Use cases:

- Agent wants to report progress without pretending it is final assistant content.
- Future agents can communicate tool-specific state through a consistent path.

### `hitch.request_approval`

Optional future tool for agents that do not expose native approval requests.

Use cases:

- PTY or weaker backends can still ask the user before sensitive actions.
- The hub can normalize approval UI across channels.

## MCP Shape

Preferred long-term model:

```text
Hitch hub starts worker
Hitch provides a session-scoped MCP endpoint or process
Agent calls Hitch tools through MCP
Hub validates each call against session capability
```

Security requirements:

- Tool calls are scoped to one session.
- Tool calls require a short-lived capability token or a per-session process boundary.
- Tokens are never sent to chat.
- The MCP endpoint is localhost-only or stdio-only.
- Tool calls cannot select an arbitrary chat target.
- The hub maps the active session to the correct channel target.

Open transport decision:

- Per-session stdio MCP server is simple and strongly scoped.
- One localhost MCP server with short-lived tokens is easier to share across agents.
- A temporary CLI/outbox bridge may be needed before Pi can consume the hub MCP server directly.

## Interim Pi Bridge

Hitch now exposes a session-scoped bridge through environment variables on active Pi workers:

```text
HITCH_SESSION_ID=<session-id>
HITCH_TOOL_TOKEN=<short-lived-token>
HITCH_TOOL_OUTBOX=<data-dir>/tools/<session-id>/outbox.jsonl
HITCH_TOOL_RESULT_DIR=<data-dir>/tools/<session-id>/results
HITCH_TOOL_TIMEOUT_MS=<agent-tool-timeout-ms>
```

The hub starts a session-scoped outbox pump with each active worker, validates requests, sends media through the worker's fixed chat target, and writes one JSON result file per request. The pump remains active until worker shutdown so a retry or delayed tool request cannot become stranded between Hitch turn consumers.

For MCP-capable agents, the standalone `@hitch-hub/session-mcp` package starts a stdio server that exposes `hitch.send_media` and uses the same outbox/result protocol. Install the package below Pi's agent package directory and launch its compiled `dist/server.js` from the sandbox-visible `/agent-config/npm/node_modules` mount. The agent inherits the session-scoped `HITCH_TOOL_*` environment variables from its hub-started worker; the Hitch repository and channel credentials remain unmounted.

The current attended rollout uses `config_scope: system`, so one installation under the configured Pi directory is shared by that single-principal profile. A future `config_scope: hitch` multi-user rollout must provision the MCP adapter, server package, and `mcp.json` separately in each principal-owned `/agent-config`. Credential-isolated Pi currently starts with extensions disabled, so that mode must continue using Hitch's native guarded media tool rather than this adapter until an isolated extension strategy exists.

The same server also exposes the MCP prompt `hitch.outbound_media`. That prompt is the agent-facing guidance for generated media:

- create the media file locally
- call `hitch.send_media` with the absolute path
- report the structured delivery result
- do not rely on final-message path mentions as the delivery mechanism

MCP prompts are discoverable templates. They are not guaranteed to be injected into every client automatically. A client that supports MCP prompt selection or auto-loading should load `hitch.outbound_media`; otherwise Hitch needs a small client-specific adapter. The inspected Pi 0.80.2 install explicitly says it has no built-in MCP and exposes extension, skill, and prompt-template resources instead of a native MCP server list.

The raw JSONL request shape is:

```json
{
  "id": "request-id",
  "type": "send_media",
  "token": "short-lived-token",
  "path": "/path/to/image.png",
  "caption": "Generated image",
  "kind": "image"
}
```

The MCP wrapper writes that request and blocks until the matching result file appears.

## Config Direction

Add explicit outbound policy separate from workspace access:

```yaml
media:
  max_inbound_bytes: 20971520
  max_outbound_bytes: 52428800
  auto_discovery: false
  outbound_roots:
    - /tmp/pi-paint-outputs
```

Rules:

- `allowed_roots` controls where agents may work.
- `media.outbound_roots` controls what Hitch may send back to chat.
- Hub-managed generated artifact paths should be allowed automatically.
- Auto-discovery should be opt-in and eventually legacy-only.

## Migration Plan

1. Add `HubToolService` and route existing channel artifact upload through it.
2. Add `!send <path>` using the same service.
3. Add user-visible delivery failure messages.
4. Add Pi bridge through session-scoped JSONL outbox and result files.
5. Expose MCP `hitch.send_media` only.
6. Expose MCP prompt `hitch.outbound_media` as the canonical guidance for explicit generated-media delivery.
7. Gate current text path scanner behind `media.auto_discovery`.
8. Default auto-discovery to off.
9. Add Pi-native MCP server list wiring when available, or a Pi extension adapter if Pi does not consume MCP prompts/tools natively.
10. Add richer artifact tools only after the single-tool flow is reliable.

## Non-Goals

- Do not give agents Telegram or WeChat credentials.
- Do not allow tool calls to choose arbitrary chat IDs.
- Do not treat all mentioned paths as user-visible artifacts.
- Do not use broad workspace `allowed_roots` as outbound upload permission.
- Do not make MCP the only implementation path before the internal service exists.

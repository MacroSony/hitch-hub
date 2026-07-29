# `@hitch-hub/session-mcp`

Session-scoped MCP tools for a Hitch-managed Pi worker. The package is
deliberately independent of the Hitch source tree so it can be installed in the
Pi package directory that Bubblewrap mounts at `/agent-config`. The mount mode
follows Hitch's execution profile; system-config profiles require read/write
access for Pi's own state.

The server exposes:

- `hitch.send_media`, which requests delivery to the worker's active Hitch chat
- `hitch.outbound_media`, a prompt describing when and how to call the media tool

The parent Hitch process must provide `HITCH_TOOL_TOKEN`, `HITCH_TOOL_OUTBOX`, and `HITCH_TOOL_RESULT_DIR`. `HITCH_TOOL_TIMEOUT_MS` is optional and defaults to five minutes. The server does not contain channel credentials or choose a chat target; Hitch validates the session token, workspace path, and active target on the host side.

After installation, configure an MCP client to launch:

```text
node /agent-config/npm/node_modules/@hitch-hub/session-mcp/dist/server.js
```

The `/agent-config` path is the default Pi-agent package mount inside Hitch's Bubblewrap sandbox.

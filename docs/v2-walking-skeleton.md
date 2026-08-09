# V2 development walking skeleton

Status: implemented development-only checkpoint

This remains valid evidence for the committed single-owner foundation. The
accepted product target is now the
[`multi-user agentic MVP`](./v2-multi-user-agentic-mvp.md); this operator guide
does not claim certificate-bound multi-user authentication or production
agent execution.

The V2-014A walking skeleton exercises the real local boundary without making
a production-runtime claim. It uses separate daemon and CLI processes over the
owner-private Unix socket and durable SQLite state. The fake coordinator moves
one FIFO head to `dispatching` but launches no worker and writes no terminal
result, delivery, assistant response, lease, or provider state.

Production startup remains disabled. The server requires both the
`development-walking-skeleton` configuration mode and the explicit
`--development-walking-skeleton` command flag.

## Configuration

Copy [`../examples/v2.walking-skeleton.yaml`](../examples/v2.walking-skeleton.yaml)
and replace both absolute paths. The data root must be a direct child of an
existing owner-private (`0700`) directory. The workspace must already exist at
its canonical absolute path. Keep `bootstrapPublishedAt` stable when restarting
the same data root because it is part of the deterministic bootstrap
publication.

The configuration file must be a real, service-account-owned file and may not
be group- or world-writable.

## Run

Start the development daemon:

```bash
npm run v2 -- serve --config /absolute/path/to/v2.yaml \
  --development-walking-skeleton
```

In another process, create a session:

```bash
npm run v2 -- session create --config /absolute/path/to/v2.yaml \
  --profile pi-openai-codex-v1 \
  --workspace workspace-v1 \
  --name skeleton
```

Submit work using the returned Session ID:

```bash
npm run v2 -- prompt --config /absolute/path/to/v2.yaml \
  --session-id 'Session:<uuid>' \
  --idempotency-key demo-1 \
  'Inspect the workspace'
```

Query the returned Turn ID:

```bash
npm run v2 -- turn show --config /absolute/path/to/v2.yaml 'Turn:<uuid>'
```

The CLI emits one structured JSON outcome per command. The first prompt for a
session reports `starting`; three more may be queued; the next is rejected with
`queue-capacity-exceeded`. Reusing the same text prompt, session, and explicit
idempotency key after a daemon restart resolves to the original Turn.

Image first-submission staging is implemented with `--image`, but exact
after-restart idempotency for image-bearing retries remains open because a new
stage currently receives a new Attachment ID.

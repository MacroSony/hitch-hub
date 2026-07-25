# Pi native sidecar feasibility spike

Date: 2026-07-25

Status: feasibility gate passed; test fixture only, not production broker code.

This spike proves that Hitch can reuse Pi's own provider stack without placing
provider credentials or direct provider networking inside the Pi agent worker.
It pins `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-ai` 0.82.0, constructs `ModelRuntime` in a trusted sidecar,
and exposes one immutable provider/model connection to Pi through an explicitly
loaded extension and a versioned JSONL protocol over a Unix socket.

## Run it

Requirements:

- Node.js 24 or newer
- Pi 0.82.0 on `PATH`
- `/usr/bin/bwrap`

The default command is deterministic and makes no real provider call:

```sh
npm run spike:pi-native-sidecar
```

Real calls are opt-in and may consume quota:

```sh
npm run spike:pi-native-sidecar:real
node --use-env-proxy spikes/pi-native-sidecar/run-spike.mjs --provider deepseek
node --use-env-proxy spikes/pi-native-sidecar/run-spike.mjs --provider openai-codex
```

The real cases use saved Pi credentials for:

- `deepseek/deepseek-v4-flash` through Pi's `openai-completions` transport
- `openai-codex/gpt-5.4-mini` through Pi's
  `openai-codex-responses` transport

Credential values are neither printed nor copied into the worker or fixtures.
The output reports credential type and sanitized egress observations only.

## What the fixture proves

- Pi's native `ModelRuntime` works with an injected credential store and
  network-frozen model catalog.
- The worker has an unshared network namespace, no real auth-store mount, and
  no common provider-secret environment variables.
- Only the trusted sidecar can read saved credentials and reach the exact
  registered HTTPS origins.
- Text, reasoning, tool-call, image-input, usage, error, cancellation, and OAuth
  refresh semantics cross the local bridge.
- Turn, connection, catalog, provider, model, Pi version, and native-stack
  digest are fixed outside the agent request.
- Wrong capabilities, mismatches, origin/retry overrides, request-ID replay,
  same-request semantic replay, and a bad native-stack digest fail closed.
- The sidecar forces `maxRetries: 0` and `transport: "sse"` before invoking the
  two pinned native provider paths.
- Pi's normal HTTP dispatcher is initialized before the egress guard, preserving
  its proxy support.

Both real provider paths returned successful assistant responses during the
spike. A later OpenAI Codex rerun returned the account's HTTP 429 usage-limit
error; the request still crossed the intended native OAuth transport and the
bridge preserved the error without exposing the credential.

## Deliberate limits

The spike keeps replay state in memory, uses an ephemeral local capability, and
guards the audited Pi fetch paths in the trusted process. Production must move
these behaviors behind Hitch's durable forwarding reservation, live
reauthorization, restart recovery, and hardened egress-launch boundary. It must
also port the protocol to typed v2 modules and supervise sidecar lifecycle.

Kimi Coding, OpenCode Go, provider discovery/model switching, native wire
gateways, agent-native Codex/Claude drivers, and arbitrary extension-owned
inference remain follow-on work.

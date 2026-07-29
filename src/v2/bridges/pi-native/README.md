# Pi native bridge (V2-006A1)

This directory owns only the typed JSONL seam and the deterministic reviewed
Pi 0.82.0 extension artifact. It does not launch a sidecar, resolve a
credential, call a provider, authenticate a worker, persist a reservation, or
map a bridge event into a Hitch Turn event.

`frames.ts` is a closed protocol for the exact Pi 0.82.0 / pi-ai 0.82.0
compatibility identity. Every frame repeats a secret-free bridge/native-stack/
catalog binding and carries only a protocol-local UUID correlation. It has no
Hitch Turn, worker, lease, reservation, visibility, durability, endpoint,
origin, header, upstream auth, credential, command, environment, loader, or
path field. JSONL input is a single bounded UTF-8 line and rejects duplicate
JSON keys before typed decoding.

The A1 frame set is deliberately narrower than the spike. It represents
request/start/cancel, text/reasoning/tool streaming, image input, usage,
sanitized error, terminal/cancelled, and OAuth-refresh status. It does not
claim that a frame itself is authorization, durable replay prevention, or
prompt acceptance. `PiNativeBridgeCorrelationGuard` is an in-memory ordering
guard only. A connection owner must discard its guard when the private
transport closes so abandoned correlations do not survive a connection.

The accepted design says the worker receives a local capability, but carrying a
raw bearer value in these frames would violate this seam's no-auth/credential
rule and recreate the spike's unsafe payload shape. V2-006A2 plus the trusted
supervisor/broker must bind the private Unix transport at
`/hitch/pi-native.sock` to the active worker/capability and map the static
artifact/binding to the immutable connection before `invoke()` is allowed. The
sidecar must independently force `maxRetries: 0` and SSE at its Pi native call;
the A1 generator embeds those two literals as a checked invariant, not a
request-selected option.

`extension-generator.ts` accepts only a small semantic manifest: fixed bridge
identity, exact Pi versions/digests, and one exact provider/model projection.
It emits byte-stable ES module source, a semantic-manifest digest, and an
artifact digest. The generated extension has one static provider registration,
uses only the fixed local socket, preserves Pi's normal `streamSimple` agent
loop, and installs no command/tool/prompt/background hook, provider discovery,
auth-store access, or dynamic source/config loader. It bounds each frame,
context, image, tool-argument object, queued worker event, cumulative
text/reasoning stream, and total sidecar event count.

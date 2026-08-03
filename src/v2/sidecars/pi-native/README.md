# Deterministic Pi native sidecar runtime (V2-006A3)

This directory owns the path-free deterministic behavior between the typed A1
bridge and the later production Pi process integration. It provides one exact
Pi 0.82.0 package/bridge/catalog manifest, a network-frozen single-model
catalog whose bridge binding covers the full model-policy digest, a
provider-scoped injected credential store, and a one-use event runtime. Every
invocation is re-decoded, model-policy checked, claimed by a bounded
process-local recent-correlation and normalized-semantic replay window, and
forced to `maxRetries: 0` plus SSE before the executor can run. The provider's
frozen 128k output capacity is not advertised as this first slice's execution
capacity: the bridge and sidecar default to and enforce the installation's
16,384-token per-request ceiling.

The runtime strictly adapts Pi's native start, text, reasoning, tool, terminal,
usage, and error events into ordered A1 frames. It passes one exact
`AbortSignal` to the executor, maps cancellation to one correlated terminal
frame, exposes explicit disposal for an unopened/abandoned stream, emits
bounded buffered OAuth refresh/atomic-replacement outcome status (not
real-time provider progress), and replaces upstream failures with fixed
sanitized error classifications. Valid Pi errors may terminate an open partial
content item; that bounded partial prefix is preserved before the sanitized
error. Native SSE fragments are checked against a 2,097,152-unit aggregate
output ceiling and coalesced before A1's 4,096-frame limit. OAuth replacement
uses a V2-011-owned resource-wide atomic modification port; API-key entries are
read-only. The
preload boundary installs V2-E01's locked fetch guard from the manifest's exact
origin set before V2-006B imports Pi, and only its non-forgeable manifest-bound
proof can prepare the invoke seam.

It does not discover packages on `PATH`, verify filesystem artifacts, load Pi,
launch a process, resolve worker/Turn authority, or persist forwarding
reservations. The replay guard retains at most 256 claims and deliberately
evicts the oldest local observation; it is not restart-safe authority.
V2-006B owns verified artifact roots and production sidecar composition.
V2-011 supplies the live bound credential source, cross-process atomic update,
durable forwarding reservation, and restart replay authority.

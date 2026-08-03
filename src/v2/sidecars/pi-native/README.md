# Deterministic Pi native sidecar port (V2-006A2)

This directory owns the path-free deterministic behavior between the typed A1
bridge and the later production Pi process integration. It provides one exact
Pi 0.82.0 package/bridge/catalog manifest, a network-frozen single-model
catalog whose bridge binding covers the full model-policy digest, a
provider-scoped injected credential store, and a trusted `invoke()` port that
re-decodes every frame and forces `maxRetries: 0` plus SSE. OAuth replacement
uses a V2-011-owned resource-wide atomic modification port; API-key entries are
read-only. The preload boundary installs V2-E01's locked fetch guard from the
manifest's exact origin set before V2-006B imports Pi, and only its
non-forgeable manifest-bound proof can prepare the invoke seam.

It does not discover packages on `PATH`, verify filesystem artifacts, load Pi,
launch a process, resolve worker/Turn authority, persist forwarding
reservations, or map native stream events. V2-006B owns verified artifact roots
and production sidecar composition. V2-011 supplies the live bound credential
source and its cross-process atomic update implementation. V2-006A3 owns event,
OAuth, error, cancellation, and replay behavior.

# Production sidecar egress boundary (V2-E01)

This directory implements the focused boundary selected in
[`docs/v2-sidecar-egress-adr.md`](../../../../docs/v2-sidecar-egress-adr.md).

It owns public-address and exact DNS-set pinning, the bounded fixed-authority
CONNECT relay with exact TLS ClientHello SNI enforcement, optional pinned
host-proxy tunneling, the sidecar's fixed loopback proxy adapter and exact
environment, a locked redirect-denying fetch preload, and the one-use
runtime-authenticated `--unshare-net` launch specification.

It does not launch Pi, resolve provider credentials, authenticate a worker,
verify Pi artifacts, render the complete Bubblewrap command, or own sidecar
lifetime. V2-006A2 installs the fetch guard before loading Pi. V2-006B and
V2-010B consume the resulting runtime proofs only after their own artifact,
authorization, one-time immediate spawn claim and mount-identity validation,
readiness, and cleanup checks.

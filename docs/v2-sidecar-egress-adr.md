# ADR: Pi sidecar egress containment

Date: 2026-08-03

Status: accepted V2-E01 decision; remediated implementation independently
approved and verified, pending its bounded Git commit

## Decision

The production Pi native-library sidecar runs in a new Bubblewrap network
namespace with no external interface or route. The only mounted communication
path that can lead to provider egress is one owner-private pathname Unix socket
to a connection-specific Hitch CONNECT relay in the host network namespace.

```text
sandboxed Pi worker (network denied)
  -> private Pi bridge Unix socket
  -> trusted Pi sidecar (separate empty network namespace)
       -> fixed 127.0.0.1 HTTP proxy adapter
       -> mounted /hitch-egress/relay.sock
  -> trusted connection-specific CONNECT relay (host namespace)
       -> exact pinned public provider IP, or
       -> exact pinned operator HTTPS proxy -> exact provider IP
  -> provider TLS endpoint
```

The loopback adapter is a byte transport only. The host relay parses the
bounded CONNECT request and accepts only an exact authority published in the
immutable `ProviderConnectionSpec`. The sidecar receives an exact three-entry
environment: fixed `HTTP_PROXY`/`HTTPS_PROXY` values for
`127.0.0.1:43817` plus `NODE_USE_ENV_PROXY=1`. It does not inherit any host
environment entry, including Node loader options, TLS-disabling switches,
custom CA paths, credentials, provider variables, lowercase proxies, or proxy
bypasses. Node's normal environment proxy path therefore remains in use
without allowing the sidecar or native Pi stack to select a proxy authority.

The relay is not a TLS terminator. After accepting CONNECT, it reads a bounded
TLS ClientHello, requires one exact DNS SNI equal to the registered CONNECT
hostname, and only then dials an approved numeric address and forwards the
unchanged handshake. The sidecar's native Node/Pi transport still validates
the provider certificate against that hostname. The first slice uses Node's
bundled trust roots only; custom CAs are unsupported. V2-006B must verify the
exact Node artifact that owns this certificate policy.

## DNS and address rules

At sidecar readiness, Hitch resolves every registered hostname in the host
namespace. Each origin must produce between one and 32 canonical addresses,
and every answer must be ordinary public IPv4 or IPv6 unicast. A mixed
public/private answer fails the whole origin. Literal origin addresses,
loopback, private, shared, link-local, documentation, benchmark, multicast,
reserved, IPv4-mapped/transition IPv6, and other non-global IPv6 ranges are
denied.

The complete sorted address set is pinned. DNS operations have a fixed five
second deadline and are aborted during client disconnect or relay shutdown.
Before every tunnel, the relay
resolves the hostname again and requires the same canonical set. It then dials
one of those numeric addresses without a second name lookup. Any added,
removed, changed, empty, oversized, private, or malformed answer rejects the
request. Legitimate provider DNS rotation therefore requires a controlled
sidecar restart and new readiness pin; availability never widens the address
set in place.

## Redirect and proxy rules

Before Pi or provider code loads, V2-006A2 installs the Pi-side fetch guard as
a non-writable, non-configurable global fetch seam and passes its runtime proof
to V2-006B. The guard forces `redirect: "manual"` and rejects every 3xx
response, including same-origin redirects. The relay independently rejects an
unregistered CONNECT authority, absolute-form or non-CONNECT requests,
duplicate or unsupported headers, early tunnel bytes, proxy authorization,
authority/header disagreement, missing/malformed TLS SNI, and SNI/authority
disagreement. These two mandatory controls form the registered-origin check;
neither is claimed to make arbitrary credential-bearing native code safe.

If the service uses an operator proxy, Hitch selects only
`HTTPS_PROXY`/`https_proxy`, and both spellings must be identical when both are
present. The proxy must be an HTTP or HTTPS URL without credentials, path,
query, or fragment. Its address set is pinned exactly. Operator proxy
addresses may be ordinary public unicast or deliberate RFC1918, ULA, or
loopback unicast; unspecified, link-local, documentation, benchmark,
multicast, and other special-use addresses are denied. A private operator
proxy is allowed because it is an explicit trusted transport endpoint, but the
relay asks it to CONNECT an already approved numeric provider address, never a
request-selected hostname. Proxy authentication and SOCKS are unsupported in
the first slice. A proxy that refuses numeric CONNECT fails closed.

## Launch and artifact contract

`RunningPinnedConnectRelay.prepareLaunchAuthorization()` is the only E01
producer of a runtime-authenticated launch capability. A capability is issued
once and consumed once; casts and plain-object copies fail runtime validation.
The resulting immutable specification carries the expected device, inode,
owner, and mode of both the `0700` relay directory and exact `0600` socket,
requires `--unshare-net`, mounts only that directory read-only at
`/hitch-egress`, and supplies the exact fixed loopback proxy environment.
V2-010B must accept only this branded specification, atomically claim it once
immediately before spawn, and verify the mounted identity against the included
facts. A failed identity check leaves the specification unclaimed; after one
successful claim, every later claim fails.

Production composition must report `egress-boundary-unavailable` and launch no
sidecar if Bubblewrap/network-namespace support, the relay path, DNS pinning,
the selected proxy, or any required E01 artifact is unavailable. V2-006B still
owns exact Node/Pi/bridge/Hitch artifact verification. V2-010A/V2-010B still
own immediate mount identity verification, full Bubblewrap rendering,
supervision, and cleanup. This ADR clears the topology decision; it does not by
itself make those later integrations complete.

## Adversarial proof

Deterministic tests cover:

- public, private, link-local, reserved, transition, malformed, mixed, and
  changed DNS answers;
- exact authority/Host correlation, malformed framing, unsupported proxy
  headers, early bytes, and alternate authorities;
- exact environment allowlisting, including TLS/loader/credential exclusion,
  and ambiguous/unsupported host proxy configuration;
- numeric provider CONNECT through a pinned host proxy;
- exact TLS ClientHello SNI enforcement, locked manual redirect denial, and
  alternate-origin rejection;
- DNS/dial shutdown, late-socket cleanup, and logical connection capacity; and
- a real Bubblewrap `--unshare-net` probe proving direct TCP is unavailable
  to a controlled host listener while the explicitly mounted pathname Unix
  relay remains reachable.

The deterministic launch-contract scenario runs on every platform. The real
capability probe is a separate test and reports an explicit TAP skip when Linux
or Bubblewrap is unavailable; production remains fail-closed on such a host.
The child and network operations all have deadlines. Real provider smoke tests
remain opt-in and occur only after V2-006B/V2-010B apply this boundary to the
verified Pi sidecar artifact.

## Rejected alternatives

- A replaceable or optional global `fetch` wrapper: insufficient because code
  could bypass or overwrite it; the accepted design combines an immutable
  preload seam with OS isolation and relay SNI enforcement.
- Host networking plus nftables address rules: hostname rotation and proxy
  paths make the rule set privileged, stateful, and prone to DNS races.
- Landlock networking alone: its connect controls are port-based, not
  destination-address or hostname controls.
- TLS interception: unnecessary credential/content exposure and incompatible
  with retaining Pi's native serialization, parsing, and certificate behavior.
- A general-purpose egress proxy: outside the accepted first slice and much
  wider than one immutable provider connection.

## Implementation references

- [Bubblewrap sandboxing and network namespaces](https://github.com/containers/bubblewrap#sandboxing)
- [Node 24 `--use-env-proxy`](https://nodejs.org/docs/latest-v24.x/api/cli.html#--use-env-proxy)
- [Linux network namespace semantics](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)
- [Landlock network access rights](https://docs.kernel.org/userspace-api/landlock.html#network-flags)

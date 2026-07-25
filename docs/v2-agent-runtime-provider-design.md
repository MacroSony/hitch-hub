# Hitch v2 agent runtime and inference transport contract

Date: 2026-07-25

Status: accepted architecture; the Pi native-transport feasibility gate is
satisfied and implementation may begin.

## Decisions

- The first agent protocol is Pi RPC.
- The first secure inference path reuses Pi's version-pinned `ModelRuntime` and
  native provider implementations in a trusted sidecar.
- Provider execution is selected per immutable connection:
  `native-library-sidecar`, `native-wire-gateway`, `agent-native`, or
  `hitch-protocol-adapter`.
- Hitch-authored provider protocol adapters are a fallback, not the default.
- A connection may target any deliberately registered upstream supported by its
  selected native stack. An agent request cannot supply an origin.
- Standard Pi profiles expose pinned skills, prompt templates, themes, and
  granted extensions as first-class options.
- Pi global and project auto-discovery remains disabled. Project declarative
  resources may be snapshotted explicitly when the profile opts in.
- Extension packages are resolved at publication and loaded by exact revision,
  integrity digest, grant, and sandbox path. There is no startup package install
  or hot reload.
- Hitch calls the driver operation `submitProtocolPrompt`. Protocol submission
  and prompt acceptance are separate facts.
- A durable `submission-armed` state closes the database/pipe atomicity gap
  before the driver may write the first prompt byte.

The compile-only forms of these choices are in `src/v2/model/agent-runtime.ts`,
`provider-broker.ts`, `session.ts`, and `runtime-security.ts`.

## Runtime ownership

```text
AgentDriverDefinition
  -> validate profile and advertise capabilities
  -> project a semantic launch plan

trusted supervisor
  -> resolve reviewed launch profile
  -> launch sandboxed process and own its lifetime

AgentRuntime
  -> initialize/inspect one attached protocol connection
  -> prepare one serialized Turn

AgentTurnRun
  -> submitProtocolPrompt
  -> awaitPromptAcceptance
  -> emit normalized, causally scoped events
  -> respond to an interaction, cancel, or reconcile
```

The driver never receives process-spawn authority, canonical host paths,
repository access, event visibility/durability control, or connector delivery
authority. In brokered modes it also never receives an upstream provider
secret; it receives an already launched supervisor-owned transport, explicit
sandbox paths, and a revocable local inference capability. `agent-native` is a
separate lower-assurance mode in which the native runtime owns provider
credentials.

A launch projection names a supervisor-owned `AgentDriverLaunchProfileId`.
That ID selects a reviewed executable and fixed base arguments. Profile data
cannot inject a command, loader, environment entry, or arbitrary argument.
Driver-specific trusted code renders only the semantic provider/resource
projection permitted by the launch profile.

The bundled Pi RPC client is not the runtime boundary because it also spawns the
process and inherits ambient environment. The Pi driver implements the RPC
codec over the supervisor-owned process transport.

## Protocol submission and prompt acceptance

`submitProtocolPrompt` means:

1. serialize the exact agent-protocol prompt command for the prepared Turn;
2. attempt to write the complete framed command to the supervisor-owned
   transport; and
3. return whether the frame was completely written, definitely not written, or
   may have been partially/completely written.

For Pi RPC, the frame is one correlated JSONL `prompt` command. Submission does
not mean Pi parsed it, took responsibility for it, called a provider, began
model output, or finished.

Prompt acceptance means the correlated Pi RPC response reports successful
`prompt` preflight. It establishes only that the Pi runtime accepted
responsibility for the Turn. The immutable Hitch `TurnInputSnapshot` remains the
original request even if an allowed extension transforms the model-facing
input. Acceptance does not mean the upstream provider accepted a request or
that the model saw byte-identical input.

The durable ordering is:

```text
dispatching
  -> submission-armed       # durable; broker gate closed
  -> protocol frame attempt
  -> submitted-unconfirmed  # durable; broker gate may open
  -> accepted
  -> running/waiting
  -> terminal
```

The repository allocates an opaque `AgentDispatchAttemptId` when dispatch
starts, carries it through every non-terminal active lifecycle state, and issues
armed authorization tied to that exact Turn/attempt ID.
`AgentTurnRun.submitProtocolPrompt` rejects a missing or mismatched
authorization. The durable ID, rather than an attempt counter alone, is the
reconciliation identity after restart.

If the driver proves that no byte was written, Hitch may leave the armed
attempt and retry within the before-acceptance policy. A partial write, unknown
write result, or restart with only durable `submission-armed` evidence is not
safe to replay. A still-live driver may reconcile the exact attempt; otherwise
the Turn becomes `unknown/worker-lost-after-dispatch`.

A complete frame write moves to `submitted-unconfirmed`; it is still not
acceptance. A correlated success response, first causally guaranteed Turn event,
or correlated terminal response supplies acceptance evidence. Pi's normal
mapping uses its correlated successful `prompt` response.

The broker gate is closed through `submission-armed`. It opens only once
`submitted-unconfirmed`, `accepted`, or `running` is durable, and closes during
interaction waits, cancellation, and terminal state. If an acknowledgement
races ahead of the submitted transition, Hitch may durably advance directly
from the armed attempt using the stronger correlated evidence.

## Event correlation and reconciliation

`AgentTurnRun` is the correlation boundary. Driver events carry only
protocol-local message, tool-call, and interaction correlation IDs. They do not
carry a Hitch Turn/message/tool/interaction ID, sequence, audience, or
durability selector. The application accepts an event only from the run object
for the session's current worker fence and active Turn, validates its payload,
allocates every Hitch-owned ID, and derives the domain event. Interaction
responses return the stored protocol interaction ID to the same run.

Configuration changes, session title events, process liveness, background
usage, and heuristic content matches never establish Turn acceptance.

Exact recovery needs an exact agent/driver Turn handle. Pi currently provides
useful live runtime state but no durable exact Turn handle, so the first Pi
driver advertises `live-runtime-only` reconciliation. Process loss after
possible submission therefore resolves conservatively to unknown.

## Resource loading

Resources have two trust classes:

| Class | Examples | Publication and launch rule |
|---|---|---|
| declarative agent input | skills, prompt templates, themes | immutable profile resource or project snapshot, integrity digest, explicit sandbox path |
| worker-executable | Pi extensions | exact extension revision, integrity digest, capability grant, explicit sandbox path |

The standard Pi profile defaults declarative resource modes to `pinned` and
extension mode to `granted-only`. An empty snapshot/grant list loads nothing.
Installations can publish a stricter profile with any resource class disabled.
Every profile revision explicitly names its declarative snapshots and extension
grant snapshots. `SessionSpec` repeats the resolved exact lists and may add only
project snapshots permitted by that profile's policy.
Project auto-discovery is disabled by default; project skills/templates/themes
load only from an immutable session-creation snapshot when the profile
explicitly enables that source.

Pi launches with `--no-extensions`, `--no-skills`, `--no-prompt-templates`,
`--no-themes`, and `--no-context-files`, then receives only explicit verified
extension, skill, prompt-template, and theme paths. In the pinned Pi version,
the first four switches suppress discovery while retaining the corresponding
explicit paths; this behavior is an adapter compatibility fixture.
User/global resource directories, mutable workspace `.pi`, `AGENTS.md`, or
`CLAUDE.md` discovery, arbitrary filesystem paths, package names, package
installation, and reload/update during a session are not supported.

Extension-specific configuration is decoded against the exact published
revision's schema. A trusted Pi launch renderer may project only those typed
values to reviewed extension flags or sandbox configuration files. Raw argument
arrays, environment entries, host paths, secrets, and loader options are not
extension configuration.

Skills are model instructions and can contain or reference scripts. The
execution policy still decides whether any model-facing tool can execute such a
script; a skill grant does not add process authority.

Extensions execute arbitrary code inside the worker and share all of its
sandbox and local inference authority. The control plane cannot distinguish an
extension request from core Pi merely by capability possession. An allowed
extension is therefore a reviewed trusted worker component, although brokered
modes continue to treat the worker as untrusted relative to credentials and the
host control plane. In `agent-native` mode, approved executable extensions also
join the credential trust boundary; that weaker claim must be visible in the
profile.

Pi can acknowledge a prompt that an extension handled without exposing whether
the normal agent loop ran. The first supported extension subset is therefore
`agent-loop-preserving`:

- tool registration, event observation, and input transformation that continues
  into the normal agent loop are allowed when granted;
- fully handled prompts/commands, hidden terminal disposition, background
  inference, and independent session work are excluded;
- an extension requiring direct upstream credentials is incompatible with
  secure mode.

A later lifecycle-aware extension contract may add explicit disposition and
work identity. It cannot be inferred from Pi's current success response.

## Inference control-plane structure

The selected structure is:

```text
Hitch Turn authorization, leases, budgets, reservations, and audit
  -> immutable ProviderConnectionSpec
  -> selected inference execution mode
  -> agent/native provider transport
  -> registered upstream
```

The four modes are:

| Mode | Provider serialization/parsing | Credential custody | Assurance |
|---|---|---|---|
| `native-library-sidecar` | version-pinned native provider library in a trusted sidecar | Hitch control plane | secure default where a library seam exists |
| `native-wire-gateway` | agent's native client; gateway inspects then forwards bytes | Hitch control plane | secure when the inspector can enforce the required limits |
| `agent-native` | complete native agent runtime | agent runtime | trusted-runtime compatibility mode |
| `hitch-protocol-adapter` | Hitch-authored codec | Hitch control plane | fallback when native reuse is unavailable |

This avoids one Hitch implementation per upstream without turning the broker
into a request-selected forward proxy. Installation configuration publishes an
immutable `ProviderConnectionSpec` that pins:

- provider and execution mode;
- versioned bridge, native stack/catalog digest, or protocol inspector;
- deliberately registered upstream origins;
- credential resolver/custody;
- exact model manifests, context/output limits, image/tool support, portable
  reasoning efforts, and conservative token estimator;
- secret-free native compatibility metadata; and
- an integrity digest used by sessions, audit, and fixtures.

Changing an origin, native stack revision, inspector, credential custody, or
model behavior publishes a new connection. The agent receives only connections
allowed by its profile and `SessionSpec`; it never submits a base URL.

## Pi native library sidecar

The first secure path reuses the exact Pi package revision used by the Pi
driver. The trusted sidecar owns Pi's `ModelRuntime`, provider/model catalog,
credential store, OAuth refresh behavior, and native `streamSimple` provider
implementations:

```text
sandboxed Pi RPC worker
  -> Hitch-generated, explicitly pinned provider bridge extension
  -> versioned structured request over a supervisor-owned local endpoint
  -> live Turn/lease/model/budget authorization
  -> durable reservation and one-shot forwarding transition
  -> trusted Pi ModelRuntime/provider implementation
  -> registered upstream
  -> Pi-native stream events back to the worker
```

The bridge extension receives only a local capability and the exact allowed
model projection. It does not load Pi's real `auth.json`, provider environment,
or upstream token. The sidecar may use a trusted Pi-compatible
`CredentialStore` backed initially by the operator's existing Pi auth storage.
OAuth refresh runs through the native provider implementation, with serialized
credential updates and no secret crossing the bridge.

The structured bridge protocol is versioned independently from Pi. Every
payload is untrusted input: the sidecar validates its schema, size, exact
connection/model/reasoning selection, output limit, image limits, and active
Turn before reservation. Native catalog discovery occurs only in the control
plane; the worker receives a non-empty authorized projection.

Provider compatibility, request construction, streaming parsing,
provider-specific headers, and OAuth are Pi's responsibility. The first secure
bridge sets Pi's native `maxRetries` to zero: each retry is a fresh Hitch
attempt with its own reservation and forwarding authorization. Hitch owns that
retry boundary, authorization, connection/model pinning, finite request/token
ceilings, cancellation registration, usage settlement, and audit.

## Native wire gateway

When an agent supports a custom base URL but has no reusable library seam, it
may serialize its native protocol to a local gateway. The gateway:

- binds a capability to one immutable connection rather than trusting a URL,
  authority, provider, or model from the request;
- preserves ordered raw headers until authority/authentication/framing
  ambiguity is rejected;
- denies `CONNECT`, absolute-form targets, redirects, request-selected origins,
  proxy headers, unsafe hop-by-hop fields, oversized bodies, and unsupported
  routes;
- uses a small versioned protocol inspector to extract model, reasoning, output
  limit, features, and usage needed for policy;
- strips the local capability and injects control-plane authentication only
  after the durable forwarding transition; and
- returns the sanitized HTTP status, headers, and streaming body without
  reimplementing the agent's parser.

An inspector is intentionally smaller than a provider adapter. It validates
only the protocol facts required by Hitch and never performs compatibility
rewrites. If it cannot establish a safe token bound or observe usage, the
connection either charges the full conservative reservation or is incompatible
with secure mode.

## Agent-native execution

Some native subscription/OAuth paths expose no supported external transport
seam. An `agent-native` connection lets the version-pinned agent own its auth
and provider transport while Hitch integrates through the agent protocol, such
as Codex app-server or a future Claude Code driver.

This mode is useful and supported, but it has a deliberately weaker claim:

- the native agent and approved executable extensions/plugins are
  credential-trusted;
- Hitch can pin the process, model configuration, Turn lifetime, and observed
  usage, but cannot prove per-request reservation or prevent a compromised
  runtime from using its credential outside the broker gate;
- reported usage supports audit and soft limits, not broker-enforced hard token
  ceilings; and
- secure unattended or mutually untrusted multi-user profiles cannot silently
  substitute this mode for a brokered connection.

Codex app-server is therefore a natural agent-native driver. API-key-backed
Codex custom providers may instead use the native wire gateway. The same split
applies to Claude Code when its gateway/base-URL configuration is available.

## Durable forwarding boundary

In brokered modes, a validated request is still not invocable. The control
plane atomically rechecks live authority and creates a durable token reservation
tied to the request fingerprint. Immediately before native-library invocation
or upstream wire I/O, it durably moves that reservation to `forwarding` and
returns opaque one-shot authorization. The exact
request/forward-authorization pair may start at most one send.

Cancellation after `forwarding` is best effort. Missing usage charges the full
reservation. A native final-usage event or reviewed wire inspector may reconcile
the held amount. No request or response body is durably logged.

## Feasibility gate

Before the repository/runtime implementation starts, a narrow Pi spike must
prove:

1. a trusted sidecar can construct Pi `ModelRuntime` with an injected
   credential store and a network-frozen model catalog;
2. DeepSeek and OpenAI Codex execute through their native Pi transports using
   the existing saved credential entries;
3. streaming text, reasoning, tools, images where supported, usage, errors,
   cancellation, and OAuth refresh remain representable across a versioned
   local bridge;
4. the sandboxed Pi worker has no real provider credential or direct
   authenticated upstream path;
5. a stale/mismatched capability, Turn, connection, model, native-stack
   revision, or replayed forwarding authorization fails closed; and
6. `maxRetries: 0` reaches both native transports, so one forwarding
   authorization cannot cause a hidden second upstream attempt.

The spike may use a deterministic fake provider before opt-in real calls. Its
purpose is to validate the seam, not implement repositories or production
broker behavior.

The initial spike pins the currently installed Pi 0.82.0 package set. It uses
DeepSeek to exercise Pi's OpenAI-completions transport and `openai-codex` to
exercise Pi's distinct Codex Responses/OAuth transport. Saved credential
contents are never printed or copied into fixtures. Kimi Coding and OpenCode Go
are follow-on compatibility cases after the two-protocol seam is proven.

### Spike result

Satisfied on 2026-07-25 by
[`spikes/pi-native-sidecar`](../spikes/pi-native-sidecar/README.md):

- A version- and digest-pinned Pi 0.82.0 `ModelRuntime` accepted an injected
  credential store and an offline model catalog.
- Saved DeepSeek API-key and OpenAI Codex OAuth entries both completed real
  requests through Pi's native transports. A later Codex rerun reached the same
  authenticated transport but was rejected by the account's external usage
  quota; the native error remained representable across the bridge.
- The versioned JSONL/Unix-socket bridge preserves streaming text, reasoning,
  tool calls, image-bearing context, usage, errors, cancellation, and serialized
  OAuth refresh.
- The Pi worker runs in a Bubblewrap network namespace without the real auth
  store or provider-secret environment variables. Only the trusted sidecar
  reads Pi's credential store and performs provider egress.
- Negative fixtures deny wrong capabilities, Turn/connection/catalog/model
  mismatches, native-stack mismatches, origin/retry overrides, request-ID
  replays, and same-request semantic replays.
- The sidecar forces `maxRetries: 0` and SSE before entering either pinned
  native transport. Semantic replay denial prevents an agent-level retry from
  forwarding the same structured inference request a second time.

The spike proves the library seam and fixes the first implementation fixture;
it is not production broker code. Durable forwarding reservations, restart-safe
replay state, typed application integration, and production-strength egress
containment remain implementation work under the already accepted contracts.

## What can wait

- ACP and remote agent transports
- exact durable reconciliation for Pi after process loss
- extension-handled prompts and extension-owned/background inference
- extension/package install, update, hot reload, or arbitrary paths
- project `AGENTS.md`/`CLAUDE.md` snapshot and composition semantics
- user-supplied MCP servers
- provider/model discovery and model switching
- management UI for registering provider connections
- production `native-wire-gateway` and protocol inspectors
- production `agent-native` Codex/Claude Code drivers
- Hitch-authored Chat Completions, Responses, or Anthropic Messages codecs

# Hitch v2 agent runtime and provider adapter contract

Date: 2026-07-25

Status: accepted contract; the first fixed provider origin and exact model
manifest still require selection before broker implementation.

## Decisions

- The first agent protocol is Pi RPC.
- The first provider wire protocol is OpenAI-compatible Chat Completions.
- Provider support is a reusable protocol codec plus a reviewed, fixed-origin
  dialect manifest. It is not an arbitrary base-URL proxy.
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

The compile-only forms of these choices are in
`src/v2/model/agent-runtime.ts`, `provider-broker.ts`, `session.ts`, and
`runtime-security.ts`.

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

The driver never receives process-spawn authority, canonical host paths, an
upstream provider secret, repository access, event visibility/durability
control, or connector delivery authority. It receives an already launched
supervisor-owned transport and explicit sandbox paths.

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
sandbox and broker authority. The broker cannot distinguish extension requests
from core Pi requests. An allowed extension is therefore a reviewed trusted
worker component, although Hitch continues to treat the entire worker as
untrusted relative to the host control plane.

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

## Provider adapter structure

The selected structure is:

```text
OpenAIChatCompletionsCodec
  + reviewed OpenAIChatCompletionsDialectSpec
  + exact model specs and token estimator
  = one fixed-origin ProviderBrokerAdapter
```

Alternatives rejected for the first slice:

- an arbitrary OpenAI-compatible base URL, because it turns the broker into an
  SSRF-capable forward proxy and makes compatibility/security behavior mutable;
- one monolithic adapter per provider, because it duplicates the common Chat
  Completions parser and validation boundary;
- Anthropic Messages first, because it is not the user's primary provider shape
  and provides less cross-provider leverage here;
- OpenAI Responses first, because Chat Completions is the broader compatibility
  target for the first non-Anthropic adapter. Responses can be a separate future
  codec.

The first dialect manifest pins:

- exact HTTPS origin and `POST /v1/chat/completions`;
- bearer authentication reconstructed by the broker;
- exact supported model IDs, context/output limits, image/tool support, and
  reasoning efforts;
- exact image MIME allowlist, per-request count, per-image decoded bytes, and
  total decoded image bytes for each image-capable model (the Hitch Turn
  projection separately permits at most one new image);
- `max_tokens` versus `max_completion_tokens`;
- developer-role handling and reasoning-field encoding;
- streaming and whether final usage is requested or the full reservation is
  charged because that dialect cannot report it;
- a reviewed request-header/body-field allowlist;
- one conservative token estimator per model; and
- explicit Pi compatibility values.

The HTTP boundary preserves ordered raw header pairs until duplicate
authorization/authority/framing checks finish; it never merges those fields
before smuggling validation. The codec rejects absolute-form targets, alternate
routes/origins, redirects, unknown fields, mismatched listener authorities,
proxy/forwarding headers, unsupported model aliases, unsupported features,
non-streaming requests, and missing/non-finite output limits. The agent's
authorization header carries only the local broker capability; it is consumed
and never forwarded. Exact SDK-generated telemetry headers from the pinned
Pi/OpenAI client may be validated and stripped. Only semantic headers on the
dialect allowlist are reconstructed upstream with the real provider
authentication. A dialect that supports `stream_options.include_usage` requires
it; a reviewed dialect that cannot report streaming usage conservatively
charges the full reservation.

A validated request is still not forwardable. The trusted broker boundary first
atomically rechecks live authority and creates a durable token reservation tied
to the request fingerprint. Immediately before upstream I/O, it durably moves
that same reservation to `forwarding` and returns an opaque forward
authorization. Only the exact request/forward-authorization pair permits the
adapter to inject the real upstream credential and build a sendable request.

Standard OpenAI client function-tool and image content shapes are enabled only
when the exact model manifest supports them. Provider routing, storage,
metadata, arbitrary `extra_body`, and provider-specific fields are denied
unless a later reviewed manifest adds an exact field and validation rule.

Pi sees the loopback broker as its base URL, so Pi's origin-based compatibility
inference cannot identify the real upstream dialect. The driver must project
the manifest's output-token field, developer-role behavior, reasoning encoding,
streaming-usage behavior, image support, tool support, and exact profile-allowed
model metadata/effort maps explicitly. Pi model discovery is not used.

## Remaining manifest selection

The contract is implementation-ready, but the real-provider adapter cannot be
built until these deployment values are chosen together:

| Value | State |
|---|---|
| provider ID and fixed HTTPS origin | pending user selection |
| exact model ID | pending user selection |
| model context and maximum output limits | derived from selected model |
| reasoning/developer/tool/image compatibility and image limits | derived and fixture-tested |
| token estimator | selected for the exact model tokenizer |

This is not runtime custom-provider configuration. The chosen values become one
reviewed built-in manifest and deterministic test fixture. Supporting a second
origin means publishing and reviewing a second dialect manifest.

## What can wait

- ACP and remote agent transports
- exact durable reconciliation for Pi after process loss
- extension-handled prompts and extension-owned/background inference
- extension/package install, update, hot reload, or arbitrary paths
- project `AGENTS.md`/`CLAUDE.md` snapshot and composition semantics
- user-supplied MCP servers
- provider/model discovery and model switching
- a second provider protocol or origin
- configurable custom origins
- OpenAI Responses and Anthropic Messages codecs

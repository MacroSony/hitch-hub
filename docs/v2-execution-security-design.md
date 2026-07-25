# Hitch v2 execution trust and credential broker

Date: 2026-07-24

Status: accepted domain and adapter contract; runtime codecs, concrete provider
manifest, broker, and services are not implemented.

## Security claim

In secure v2 operation, an agent runner never receives a Hitch-managed upstream
provider API key, OAuth access token, refresh token, connector credential, or
broker secret-store locator. Hitch supplies authenticated LLM-provider access to
the runner only through a trusted credential broker.

The runner does know its provider, model, reasoning configuration, and broker
API protocol. The broker is a credential boundary and enforcement point, not an
opaque model router.

The v1 Pi credential guard demonstrates model-tool confinement behavior worth
porting into the clean v2 implementation, but it is not a provider credential
broker because the Pi controller can still read provider credentials. The v1
implementation is not retained as a compatibility layer, and that configuration
cannot satisfy the v2 secure-mode acceptance criteria.

## Trust boundary

Trusted:

- the host operating system and Hitch service account
- Hitch authorization, repository, supervisor, AgentDriver adapter, and
  credential broker
- the sandbox launcher and driver-specific configuration codec

Untrusted:

- inbound IM/CLI content and attachments
- the agent process, model output, and optional in-process extensions
- files visible inside the sandbox
- other Hitch principals and their sessions
- arbitrary internet destinations

An installation administrator is operationally privileged but remains
content-blind through Hitch authorization. The operating-system administrator is
inside the trust boundary and can inspect Hitch storage and process memory.
Cryptographic privacy from the host administrator is not a v2.0 claim.

The trusted broker necessarily observes provider request and response bodies
while forwarding them. It must not retain those bodies as broker logs. Normal
Turn content persistence remains governed by Turn output policy and session
authorization.

Host-network sharing means Hitch cannot stop an agent from attempting a direct
request or using an unrelated credential that a user deliberately placed in a
prompt, workspace, extension, or other authorized input. Secure mode guarantees
that Hitch-managed credentials and configuration do not enable such a request.
Complete provider-only egress enforcement requires the separately deferred
egress proxy/network namespace.

An allowed in-process extension shares the runner's broker capability and is
therefore confined to the same worker, active-Turn lifecycle window,
provider/model, and usage limits. The broker cannot distinguish an extension
from the main agent process or prove which in-process task caused a request.
Extensions that embed, request, or require an upstream credential are
incompatible with secure mode.

The first slice permits only exact, integrity-pinned extension revisions with an
immutable grant. Pi ambient/project discovery and hot reload are disabled; the
driver supplies explicit sandbox paths. Because Pi's prompt acknowledgement
does not distinguish a fully extension-handled prompt from its normal agent
loop, first-slice extension grants must be `agent-loop-preserving` and forbid
hidden terminal handling or background inference. These extensions are reviewed
worker components and share the worker's authority; they are not isolated
plugins. Pinned skills, prompt templates, and themes are declarative
agent-instruction resources and do not grant process authority. The full
contract is in
[`v2-agent-runtime-provider-design.md`](./v2-agent-runtime-provider-design.md).

## Records and runtime material

`ProviderCredentialBinding` is stable, grantable metadata for one broker-owned
provider secret. Its record contains no secret or vault locator. The trusted
secret store resolves a binding ID internally, and credential rotation does not
change the binding ID or immutable `SessionSpec`.

`WorkerLease` is fenced ownership of a session runtime. Its positive,
session-monotonic fencing token prevents an expired process from emitting
accepted events or using renewed authority.

Lease creation and renewal are atomic current-fence operations: renewal succeeds
only for the session's exact active WorkerLease ID and fencing token. Fencing
tokens are positive safe integers allocated atomically per session. Ending a
worker lease releases or revokes all child CredentialLeases in the same
transactional cleanup path.

Fencing protects repositories, broker access, and Hitch tools; it cannot prevent
an old process from writing an already-mounted workspace. The supervisor must
therefore place every worker in a killable lifetime container and confirm the
previous container is gone before launching a successor lease. If termination
cannot be confirmed, the session becomes blocked/quarantined rather than running
two workers against one workspace.

`CredentialLease` authorizes one active worker lease to use one session-bound
provider credential within the profile's allowed model set. It contains no raw
bearer token.

`RuntimeBrokerCapability` contains the local broker endpoint and raw capability
token given to the untrusted agent as its apparent provider credential. Its
safety comes from narrow authority and local reachability, not from assuming the
runner will keep it confidential:

- raw material exists only in process memory and the sandbox runtime projection
- the broker persists at most a one-way verifier
- Hitch never intentionally writes it to domain storage, logs, audit records,
  management APIs, connector messages, or crash reports
- it is bound to one credential lease, provider, worker lease, and fencing token
- it cannot authenticate directly to the upstream provider
- active capability values are registered with output/log redaction immediately
  when generated, before constructing a launch authorization or invoking any
  generic logging path

A capability may live for the current worker lifetime so provider SDKs can use a
static credential value. Server-side checks on every request provide immediate
revocation. A restarted worker receives new capability material and any
capability embedded by the agent in its own state remains unusable.

Capabilities use cryptographically secure high-entropy random material. The
broker stores a one-way verifier, compares it in constant time, and applies a
fixed installation rate limit to failed authentication. Literal-value redaction
is defense in depth only: an untrusted process can transform or encode a token,
so Hitch does not claim it can redact every malicious disclosure.

## Broker request flow

```text
agent provider client
  -> local broker endpoint + scoped capability
  -> validate raw authority/framing/header pairs before canonicalization
  -> authenticate CredentialLease
  -> verify current WorkerLease ID and fencing token
  -> require one active authorized Turn for the session
  -> validate API protocol, provider, model, reasoning, and limits
  -> atomically reserve request/tokens for the normalized request fingerprint
  -> durably mark that reservation forwarding
  -> inject broker-owned upstream credential
  -> trusted HTTPS provider origin
  -> stream the provider response to the agent
```

The endpoint binds only to a supervisor-controlled local transport. The first Pi
and provider adapter use loopback HTTP and therefore require the execution
policy's `host-network` mode. Admission rejects `deny` and `egress-proxy` for
provider-bound sessions in this slice; they are not allowed to fail later during
agent startup. A future mounted Unix socket or dedicated namespace bridge may
enable those modes. The loopback listener must never bind an externally
reachable interface.

The broker is provider-aware. It does not expose a generic forward proxy,
arbitrary destination URL, or HTTP `CONNECT`. Each adapter:

- fixes the trusted upstream HTTPS origin
- allowlists methods, routes, headers, and provider API versions
- parses origin-form request targets only and rejects alternate schemes,
  authorities, encoded traversal, and ambiguous encodings
- consumes the exact local broker authorization capability and reconstructs
  upstream authentication rather than forwarding it
- requires the HTTP authority to match the loopback listener and rejects
  `CONNECT`, alternate/malformed `Host`, proxy, forwarding, cookie, and unsafe
  hop-by-hop headers
- preserves ordered raw header pairs until duplicate `Host`, `Authorization`,
  `Content-Length`, `Transfer-Encoding`, and framing ambiguity are rejected
- enforces fixed header, request-body, response-body, and concurrency ceilings
- never follows redirects or accepts a destination outside the configured
  provider
- strips sensitive response headers and cookies
- supports streaming without logging request or response bodies
- normalizes sanitized status, usage, latency, and failure metadata for audit

The first adapter uses the reusable OpenAI-compatible Chat Completions codec
bound to one built-in, reviewed `OpenAIChatCompletionsDialectSpec`. The dialect
fixes `POST /v1/chat/completions`, bearer authentication, models, token limits,
reasoning/developer behavior, tool/image support and exact image limits, request
fields, streaming usage behavior, token estimation, and the upstream HTTPS
origin. A dialect that cannot report final streaming usage charges the full
reservation. The broker never accepts an origin or compatibility option from
the agent request. The concrete first origin and model are still pending
selection.
Custom/configurable origins are unsupported until a separately reviewed
installation allowlist also rejects loopback, private, link-local, and otherwise
unsafe resolved addresses.

Agents may still use permitted host-network access for non-provider internet
traffic. Hitch-provisioned direct provider calls are unauthenticated because real
credentials and credential-bearing config are absent from the sandbox.

## Live authorization

Before forwarding every provider request, the broker must verify:

1. The capability verifier matches an active, unexpired `CredentialLease`.
2. The referenced `ProviderCredentialBinding` is active and still belongs to
   the expected installation and provider.
3. The exact `WorkerLease` ID and fencing token still own the session runtime.
4. The session has one current active Turn whose protocol prompt submission is
   durably `submitted-unconfirmed`, `accepted`, or `running`.
5. The requester, configuration-use grants, session binding, profile revision,
   workspace revision, execution policy, and installation ceilings remain
   authorized.
6. The provider/model/reasoning request matches that active Turn.
7. The Turn's request/token budget, live installation ceilings, and fixed broker
   concurrency/size limits have not been exceeded.

Authorization and a conservative maximum-token reservation occur in one durable
transaction before the upstream request. `TurnPolicySnapshot.inference` provides
finite provider-request, total-token, and per-request output-token ceilings.
Each `InferenceRequestReservation` is attributed to the exact Turn,
CredentialLease, WorkerLease ID, and fencing token. Its input estimate plus
maximum output allowance must be a provider-adapter-supported upper bound; an
adapter that cannot establish a safe bound rejects the request.

The transaction that creates the reservation is the request's authorization
point, but does not yet permit upstream I/O. A second durable transition marks
the same request fingerprint and reservation `forwarding`. Only the resulting
opaque forward authorization permits upstream credential injection and network
send. Revocation after that transition may race with upstream submission and
cannot undo already spent tokens or side effects. The broker registers and
cancels in-flight streams best-effort. A reservation may be released only when
the broker proves it never reached `forwarding`. Once forwarding may have begun,
missing usage charges the full reservation; reported final usage reconciles the
held amount. Cancellation cannot guarantee the provider stops generation or
billing.

Monetary cost is an observation in v2.0, not an enforceable budget. Configurable
request-rate policies are also deferred; fixed concurrency, request-size, and
failed-authentication limits remain mandatory broker safeguards.

The broker gate remains closed while a Turn is queued, `dispatching`, or
`submission-armed`, including during worker startup. `submission-armed` is
committed before the driver may write the first protocol prompt byte and remains
non-replayable after an uncertain write or restart. The gate opens only after
submission is durably recorded as `submitted-unconfirmed`, or after stronger
correlated acceptance evidence is durable; a request racing that commit may wait
briefly for the state transition but cannot bypass it. A broker request is not
prompt-acceptance evidence by itself unless the AgentDriver separately
guarantees causal attribution to that exact Turn.

The gate closes again in `waiting-for-approval`, `waiting-for-input`,
`cancelling`, and `terminal`. It reopens only after an interaction resolution
returns the same Turn to `running`. This matches paused active-work accounting:
paid work cannot start while that budget is paused.

Before clearing the active Turn or allowing a next Turn to dispatch, every
authorized reservation for the old Turn must be released, settled, or charged,
and every in-flight stream must be aborted or drained. This is a hard Turn
handoff barrier, so usage and response events cannot settle into the next Turn.

No provider calls are allowed while a session is idle. Background title,
summary, telemetry, or maintenance model calls are disabled in supported v2.0
drivers unless they later receive their own explicit Hitch work identity and
policy.

A worker-lifetime bearer capability cannot prove causality among tasks inside
the same untrusted process. While a Turn gate is open, a delayed background task
could make a request that the broker can attribute only to the current
worker/Turn window. A caller-supplied Turn ID would not fix this because the
runner could forge it. The first slice therefore requires drivers to serialize
prompt execution and disable known background model features, applies strict
per-Turn request/token budgets, and drains before handoff. Strong cryptographic
intra-process Turn causality is not an MVP security claim; it would require a
single-Turn worker or another trusted per-Turn mediation boundary.

## Model and reasoning projection

`AgentProfileRevision` defines the allowed provider/model catalog, optional
default model, and required default reasoning intent. Every Turn explicitly
records the resolved choices:

- an exact resolved provider/model, or deliberate agent selection
- `agent-default` reasoning, or a portable `none`, `low`, `medium`, or `high`
  effort

Configured model and reasoning defaults are resolved before Turn admission. For
an exact Turn:

- the driver tells the agent the exact provider, model, and reasoning intent
- the broker rejects a different value rather than silently rewriting it

If ingress omits a model, admission uses the profile default. When the profile
has no default, admission fails unless the caller deliberately requested
`agent-selected`; omission never silently enables agent selection.

For an `agent-selected` Turn:

- admission intersects profile allowance, live policy, driver support, broker
  adapter support, and the requested reasoning intent
- model discovery exposes only that non-empty filtered catalog; admission fails
  if no eligible provider/model combination remains
- the first accepted selection atomically creates one immutable
  `TurnInferenceResolution`
- every later provider request in that Turn must use the same provider, model,
  and reasoning choice

The first-request transaction stores the unique inference resolution and its
durable event together with the initial usage reservation, then commits before
forwarding upstream. A failed policy or usage check rolls the transaction back.
Concurrent requests proposing different models cannot both win; the loser
reloads the resolution and is rejected without reaching a provider. The event
Turn ID and resolution Turn ID must match.

V2.0 does not support multi-model execution inside one Turn. It can be added
later as an explicit orchestration feature rather than inferred from arbitrary
requests.

Portable reasoning effort is accepted only when both the AgentDriver and broker
adapter advertise an exact mapping. For a resolved model, unsupported effort
fails admission. For agent selection, unsupported combinations are filtered and
admission fails when the resulting catalog is empty. `agent-default` means the
provider request contains no reasoning override; an explicit override is
rejected. Hitch never silently downgrades or substitutes a requested effort.

Provider-specific model aliases and configuration are validated by the selected
driver/provider codecs. Actual provider/model resolution is durable audit data;
raw provider requests are not.

## Configuration and launch authorization

Publication validates `AgentProfileRevision.configuration` with the selected
driver's schema. Launch revalidates it and produces the branded
`SanitizedAgentProfileConfiguration`, rejecting:

- credential values, credential commands, or secret-store locators
- canonical host paths
- arbitrary commands or loader injection
- provider endpoints outside the broker projection
- ungranted resource paths, ambient discovery, hot reload, or unsupported
  configuration fields

The trusted supervisor constructs one ephemeral
`SupervisorLaunchAuthorization`:

```text
immutable SessionSpec
  -> live authorization and hard-ceiling checks
  -> fenced WorkerLease
  -> launch-time verified sandbox mount sources and destinations
  -> pinned declarative resources and exact extension grants
  -> one CredentialLease per enabled provider binding
  -> runtime broker capabilities
  -> sanitized AgentDriver configuration
  -> sandbox launch
```

The authorization may contain canonical host paths and raw broker capabilities,
so it is never persisted. Only the supervisor receives the whole object. It is
not an executable process specification. The AgentDriver projects a semantic
`AgentDriverLaunchProfileId`, generated sandbox configuration, and explicit
resources; a trusted supervisor renderer owns the reviewed executable, fixed
base arguments, environment, and process lifetime. The AgentDriver receives
`SanitizedAgentRuntimeConfiguration`, using sandbox paths and broker
capabilities but no host paths or upstream secrets.

Every mount source is resolved again at launch. The supervisor validates every
path component and expected filesystem object identity, rejects symlinks or
aliases that changed since catalog validation, and rejects duplicate, nested,
overlapping, or protected sandbox destinations that could shadow broker,
configuration, runtime, or system paths. Descriptor/handle-based mounting is
preferred. A path-only engine is allowed only with trusted-stable parents and
immediate device/inode revalidation; any change fails closed.

The supervisor, not the driver, owns process launch, sandbox selection,
environment construction, capability injection, lease renewal, revocation, and
cleanup. The accepted driver contract defines only how sanitized configuration
is projected into a particular agent and how a driver speaks over a
supervisor-owned transport.

## Revocation and failures

Revoking or expiring a credential binding, CredentialLease, WorkerLease, or
required grant—or cancelling/completing the active Turn—denies every broker
request that has not passed the durable authorization point. A request already
authorized may race with upstream submission and is cancelled best-effort. Loss
of execution authority also:

- initiates active Turn cancellation when execution authority is lost
- rejects new privileged tool and broker operations
- cancels pending interactions
- invalidates raw broker capability verification
- terminates the worker after supervisor cleanup grace

Broker unavailability fails closed as `credential-unavailable`; it never falls
back to direct credentials. A provider/model/reasoning mismatch is a policy
violation and is never silently corrected. Agents that require client-side
provider secrets, signatures, or unsupported provider endpoints are incompatible
with secure mode.

An explicitly unsafe development profile may exercise driver integration with
raw credentials, but it must be visibly labeled, disabled by default, excluded
from multi-user deployment, and excluded from all v2 secure-mode acceptance
claims.

## Acceptance criteria

The first secure provider adapter must prove:

- no Hitch-managed provider or connector credential exists in agent arguments,
  environment, mounted configuration, readable files, logs, or transcripts
- direct provider requests using Hitch-provisioned configuration cannot
  authenticate
- a valid capability works only for its provider and current worker lease
- an expired/revoked lease or stale fencing token is denied
- a successor worker cannot launch until the previous sandbox is confirmed dead
- idle, queued, pre-submission, interaction-waiting, cancelling, and terminal
  lifecycle windows deny provider requests
- old-Turn inference is drained or aborted before the next Turn dispatches
- supported drivers serialize Turns and disable known background model features
- request and token reservations enforce their finite per-Turn ceilings under
  concurrent requests, recovery, cancellation, and missing usage
- one reservation/forward authorization can start at most one upstream send;
  replaying the same authorization cannot duplicate inference
- resolved model mismatches are denied without rewriting
- agent-selected inference is pinned once and cannot switch mid-Turn
- agent-selected catalogs contain only reasoning-compatible combinations and
  cannot be empty
- `agent-default` omits a reasoning override and rejects an explicit override
- bearer tokens have sufficient entropy, constant-time verifier checks,
  immediate redaction registration, and failed-authentication rate limiting
- absolute-form targets, alternate origins/schemes, `CONNECT`, encoded path
  traversal, redirects, unsafe methods/routes/query forms, mismatched listener
  authorities, duplicate authority/authorization/framing fields, alternate
  authorization, unsafe hop-by-hop headers, and oversized headers/bodies are
  denied
- custom origins and loopback/private/link-local upstream destinations are
  unavailable in the first adapter
- symlink swaps, filesystem aliases, nested/overlapping destinations, and mount
  attempts that shadow broker/configuration/runtime paths are denied
- unsupported execution-network modes fail at admission
- broker bodies are not durably logged
- broker capability values are redacted from Hitch-managed output and logs
- provider streaming, cancellation, error mapping, and usage accounting work
- credential rotation requires no `SessionSpec` change
- broker failure never falls back to exposing or injecting the upstream secret

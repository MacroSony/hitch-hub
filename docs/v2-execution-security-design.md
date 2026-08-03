# Hitch v2 execution trust and credential broker

Date: 2026-07-25

Status: accepted domain and transport-bridge contract. The Pi native-library
sidecar feasibility spike is complete, and V2-E01 selected the production
egress topology in [`v2-sidecar-egress-adr.md`](./v2-sidecar-egress-adr.md).
Review/commit, broker, and service integration state lives in
[`v2-status.md`](./v2-status.md).

## Security claim

In secure brokered v2 operation, an agent runner never receives a Hitch-managed
upstream provider API key, OAuth access token, refresh token, connector
credential, or broker secret-store locator. Hitch supplies authenticated
LLM-provider access only through a trusted native-library sidecar, inspected
wire gateway, or fallback protocol bridge.

The runner does know its provider, model, reasoning configuration, and broker
transport projection. The inference control plane is a credential boundary and
enforcement point, not a request-selected model router.

`agent-native` is an explicit compatibility mode, not secure brokered mode. Its
native agent and approved executable extensions/plugins own the provider
credential. Hitch can constrain the process and observe its Turns, but cannot
claim credential isolation or broker-enforced per-request token reservations.

The v1 Pi credential guard demonstrates model-tool confinement behavior worth
porting into the clean v2 implementation, but it is not a provider credential
broker because the Pi controller can still read provider credentials. The v1
implementation is not retained as a compatibility layer, and that configuration
cannot satisfy the v2 secure-mode acceptance criteria.

## Trust boundary

Trusted:

- the host operating system and Hitch service account
- Hitch authorization, repository, supervisor, AgentDriver adapter, and
  inference control plane
- the sandbox launcher, version-pinned native provider sidecar, protocol
  inspectors, and driver-specific configuration codecs

Untrusted:

- inbound IM/CLI content and attachments
- the agent process, model output, and optional in-process extensions
- files visible inside the sandbox
- other Hitch principals and their sessions
- arbitrary internet destinations

For an `agent-native` connection, the version-pinned native agent process and
every enabled executable extension/plugin move into the credential trust
boundary. Profiles must state that change rather than inheriting secure-mode
claims.

An installation administrator is operationally privileged but remains
content-blind through Hitch authorization. The operating-system administrator is
inside the trust boundary and can inspect Hitch storage and process memory.
Cryptographic privacy from the host administrator is not a v2.0 claim.

The trusted sidecar/gateway necessarily observes structured inference content or
provider request/response bodies while invoking or forwarding them. It must not
retain those bodies as broker logs. Normal Turn content persistence remains
governed by Turn output policy and session authorization.

Outside the first secure slice, a profile may permit host-network sharing. In
that case Hitch cannot stop an agent from attempting a direct request or using
an unrelated credential that a user deliberately placed in a prompt, workspace,
extension, or other authorized input. Secure brokered mode still guarantees that
Hitch-managed credentials and configuration do not enable such a request.
Complete provider-only egress enforcement for those profiles requires the
separately deferred egress proxy/network namespace.

In brokered mode, an allowed in-process extension shares the runner's local
inference capability and is therefore confined to the same worker, active-Turn
lifecycle window, provider connection/model, and usage limits. The control plane
cannot distinguish an extension from the main agent process or prove which
in-process task caused a request. Extensions that embed, request, or require an
upstream credential are incompatible with secure mode.

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

`ProviderCredentialBinding` is stable, grantable metadata for one provider
credential and explicitly records `hitch-control-plane` or `agent-runtime`
custody. Its record contains no secret or vault locator. A brokered connection's
trusted credential store resolves a binding ID internally, and credential
rotation does not change the binding ID or immutable `SessionSpec`.

`ProviderConnectionSpec` is an immutable reviewed binding of provider,
execution mode, versioned native bridge/inspector, deliberately registered
upstream origins, credential resolver/custody, and exact model manifests.
Profiles and sessions pin its ID; requests cannot replace its origin or mode.

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

## Brokered inference flow

```text
agent native provider client or generated bridge extension
  -> supervisor-owned local endpoint + scoped capability
  -> authenticate CredentialLease
  -> verify current WorkerLease ID and fencing token
  -> require one active authorized Turn for the session
  -> select the pinned ProviderConnectionSpec and versioned bridge
  -> validate structured native payload or inspect native wire request
  -> validate provider, model, reasoning, features, and limits
  -> atomically reserve request/tokens for the normalized request fingerprint
  -> durably mark that reservation forwarding
  -> invoke the native provider library or inject control-plane authentication
  -> egress restricted to the connection's registered upstream origins
  -> stream native events or allowed response bytes to the agent
```

The endpoint binds only to a supervisor-controlled local transport and never to
an externally reachable interface. The first Pi bridge should use a mounted Unix
socket or equally isolated local channel, allowing the worker network namespace
to remain denied unless its separately granted tools/extensions require egress.

The first secure transport is a version-pinned Pi native-library sidecar. A
generated, integrity-pinned Pi provider bridge extension sends a versioned
structured request; the trusted sidecar uses Pi's own `ModelRuntime`, provider
catalog, credential resolution/OAuth refresh, request serialization, streaming,
and response parsing. The worker receives only the profile-filtered model
projection and a local capability. It does not receive Pi's real provider auth
store or environment.

Native-library reuse does not make arbitrary native behavior trusted. The
sidecar must pin the library/catalog digest, disable request-selected provider
registration and origin overrides, validate every structured payload, and
constrain actual network egress—including redirects and DNS rebinding—to the
connection's registered origins. If the library does not expose an injectable
transport, equivalent OS/proxy egress enforcement is required; otherwise that
connection cannot claim secure mode. The first secure bridge also sets native
provider retries to zero. A retry is a new Hitch inference attempt and requires
its own durable reservation and one-shot forwarding authorization.

A `native-wire-gateway` remains provider-aware without becoming a complete
provider implementation. Its small versioned protocol inspector extracts only
the route/model/reasoning/limit/usage facts required by policy; the agent's
native client owns serialization and parsing. The HTTP boundary:

- consumes the local capability and reconstructs upstream authentication;
- preserves ordered raw headers until duplicate authority, authorization, and
  framing ambiguity are rejected;
- denies `CONNECT`, absolute-form targets, request-selected authorities,
  alternate schemes, encoded traversal, proxy/forwarding/cookie headers,
  unsafe hop-by-hop fields, redirects, and oversized messages;
- enforces the exact connection origin/route and fixed concurrency ceilings;
- strips sensitive response headers and cookies; and
- returns a sanitized status/header envelope and streams the body without
  logging it.

If an inspector cannot establish a conservative token bound or observe usage,
the connection charges the full reservation or is rejected from secure mode.
Hitch-authored protocol codecs remain a fallback when neither native seam can
enforce the contract.

Agents may still use permitted host-network access for non-provider internet
traffic. Hitch-provisioned direct provider calls are unauthenticated because real
credentials and credential-bearing config are absent from the sandbox.

## Live authorization

Before forwarding every provider request, the broker must verify:

1. The capability verifier matches an active, unexpired `CredentialLease`.
2. The referenced `ProviderCredentialBinding` is active and still belongs to
   the expected installation/provider, and its custody matches the pinned
   connection mode.
3. The exact `WorkerLease` ID and fencing token still own the session runtime.
4. The session has one current active Turn whose protocol prompt submission is
   durably `submitted-unconfirmed`, `accepted`, or `running`.
5. The requester, configuration-use grants, session binding, profile revision,
   workspace revision, execution policy, and installation ceilings remain
   authorized.
6. The provider connection/model/reasoning request and bridge revision match
   that active Turn and immutable `SessionSpec`.
7. The Turn's request/token budget, live installation ceilings, and fixed broker
   concurrency/size limits have not been exceeded.

Authorization and a conservative maximum-token reservation occur in one durable
transaction before the upstream request. `TurnPolicySnapshot.inference` provides
finite provider-request, total-token, and per-request output-token ceilings.
Each `InferenceRequestReservation` is attributed to the exact Turn,
CredentialLease, WorkerLease ID, and fencing token. Its input estimate plus
maximum output allowance must be a selected-transport-supported upper bound; a
bridge/inspector that cannot establish a safe bound rejects the request.

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
  transport-bridge support, and the requested reasoning intent
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

Portable reasoning effort is accepted only when both the AgentDriver and
selected transport advertise an exact mapping. For a resolved model, unsupported
effort fails admission. For agent selection, unsupported combinations are
filtered and admission fails when the resulting catalog is empty.
`agent-default` means the provider request contains no reasoning override; an
explicit override is rejected. Hitch never silently downgrades or substitutes a
requested effort.

Provider-specific model aliases and compatibility are validated by the selected
version-pinned native bridge/driver or fallback codec. Actual
connection/provider/model resolution is durable audit data; raw native requests
are not.

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
  -> runtime broker capabilities or explicit agent-native trust projection
  -> sanitized AgentDriver configuration
  -> sandbox launch
```

The authorization may contain canonical host paths and raw broker capabilities,
so it is never persisted. For an `agent-native` connection, a separate trusted
supervisor auth renderer may also resolve credential material directly into the
native runtime without passing it through the AgentDriver or durable model. Only
the supervisor receives the whole authorization. It is not an executable
process specification. The AgentDriver projects a semantic
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

Broker/sidecar unavailability fails closed as `credential-unavailable`; a
brokered connection never falls back to direct credentials. A
connection/provider/model/reasoning mismatch is a policy violation and is never
silently corrected. Agents that require client-side provider secrets or
unsupported provider endpoints may use only an explicitly lower-assurance
`agent-native` profile.

An explicitly unsafe development profile may exercise driver integration with
raw credentials, but it must be visibly labeled, disabled by default, excluded
from multi-user deployment, and excluded from all v2 secure-mode acceptance
claims.

## Acceptance criteria

The first secure Pi native-library bridge must prove:

- no Hitch-managed provider or connector credential exists in agent arguments,
  environment, mounted configuration, readable files, logs, or transcripts
- direct provider requests using Hitch-provisioned configuration cannot
  authenticate
- a valid capability works only for its provider connection and current worker
  lease
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
- the native provider receives `maxRetries: 0`, preventing an invisible second
  upstream attempt under the same authorization
- resolved model mismatches are denied without rewriting
- agent-selected inference is pinned once and cannot switch mid-Turn
- agent-selected catalogs contain only reasoning-compatible combinations and
  cannot be empty
- `agent-default` omits a reasoning override and rejects an explicit override
- the exact Pi/native-stack and provider-catalog digests are pinned, and a
  mismatch fails before invocation
- worker-side provider discovery, origin override, and direct credential
  resolution are unavailable
- the sidecar's real egress cannot leave the registered origin set through
  redirects, DNS rebinding, alternate native configuration, or proxy settings
- malformed, oversized, connection/model/reasoning-mismatched, or
  version-mismatched structured bridge payloads are rejected
- bearer tokens have sufficient entropy, constant-time verifier checks,
  immediate redaction registration, and failed-authentication rate limiting
- when a native wire gateway is enabled, absolute-form targets, alternate
  origins/schemes, `CONNECT`, encoded traversal, redirects, unsafe
  methods/routes/query forms, mismatched listener authorities, duplicate
  authority/authorization/framing fields, alternate authorization, unsafe
  hop-by-hop headers, and oversized headers/bodies are denied
- symlink swaps, filesystem aliases, nested/overlapping destinations, and mount
  attempts that shadow broker/configuration/runtime paths are denied
- unsupported execution-network modes fail at admission
- broker bodies are not durably logged
- broker capability values are redacted from Hitch-managed output and logs
- provider streaming, cancellation, error mapping, and usage accounting work
- credential rotation requires no `SessionSpec` change
- broker/sidecar failure never falls back to exposing or injecting the upstream
  secret
- `agent-native` connections are visibly excluded from these brokered-mode
  claims and hard-token-budget acceptance tests

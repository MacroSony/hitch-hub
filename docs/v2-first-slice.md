# Hitch v2 first executable slice

Date: 2026-07-25

Status: accepted implementation scope

This document is the canonical product and acceptance boundary for the first
executable Hitch v2 vertical slice. It narrows the broader domain and security
designs to one end-to-end path. When another roadmap or discussion note suggests
a different implementation order, this document wins for the first slice.

The slice is not a compatibility refactor of v1. V1 is a frozen maintenance
baseline. V2 uses a separate executable path, disposable data root, canonical
schema, and clean runtime boundary.

## Outcome

One installation owner can use a local structured CLI to submit durable work to
one private Pi RPC session. Hitch authenticates the caller, admits an immutable
Turn, runs Pi inside a required Linux sandbox, invokes one exact
provider/model pair through a trusted sidecar that reuses Pi's native provider
stack without exposing the upstream credential, persists the authoritative
Turn result, and independently delivers the response to the originating CLI
request.

The first slice proves the architecture and security boundary. It is not yet a
replacement for every v1 channel or convenience feature.

## Fixed product choices

- The first ingress is a private local structured CLI.
- The first agent driver is native Pi RPC.
- PTY passthrough is not a Turn and is deferred.
- ACP is a future driver target, not part of the first executable path.
- The slice supports one installation, one active human principal, and sessions
  owned by that principal.
- Every session uses one exact workspace revision, execution-policy snapshot,
  turn-policy snapshot, agent-profile revision, and resolved provider/model
  pair.
- The model is resolved before Turn admission. Agent-selected models, model
  pickers, and model switching inside a Turn are deferred.
- Sessions and Turns are private. Shared endpoints, group context, delegation,
  invitations, and team ownership are not executable in this slice.
- One session has at most one active Turn and at most three queued Turns.
- A new prompt never cancels active work automatically.
- The first real workspace policy is read/write, with model-facing `read`,
  `write`, `edit`, and `ls` capabilities. Model-facing shell/process access is
  denied.
- Standard Pi profiles may load pinned skills, themes, prompt templates, and
  exact granted extension revisions. Ambient/project discovery, hot reload,
  arbitrary resource paths/packages, and user-supplied MCP servers are
  disabled.
- Secure operation requires Bubblewrap, the Pi native-library sidecar,
  credential broker, finite Turn inference limits, and supervisor cleanup.
  There is no direct or raw-credential fallback.
- The Pi worker reaches the sidecar through a supervisor-owned local endpoint.
  Its network namespace is denied in the secure first slice; only the trusted
  sidecar receives provider egress restricted to registered origins.

## Process and trust shape

```text
hitch CLI
  -> installation-private Unix socket
  -> LocalConnector authentication
  -> v2 application service
  -> authorization + SQLite transaction
  -> Hitch Turn queue
  -> worker supervisor
  -> Bubblewrap + PiRpcAgentDriver
  -> generated Pi inference bridge extension
  -> trusted Pi ModelRuntime sidecar + credential broker
  -> one registered provider connection

Pi events
  -> trusted driver normalization
  -> Turn event/state repositories
  -> independently authorized local delivery
  -> originating CLI
```

The long-running Hitch service owns SQLite, workers, leases, the broker, and
delivery. CLI processes are clients; they never open the database or launch Pi
directly.

The local socket lives inside the installation-private data directory. Its
parent directory is mode `0700` and the socket is mode `0600`. Startup verifies
that both are owned by the Hitch service account and are not symbolic links.
For the single-owner slice, a connection accepted through this socket resolves
to the bootstrap owner's active local-peer identity binding. The client cannot
supply a principal ID, role, grant, endpoint owner, or authorization result.
Root and other processes running as the same service account remain inside the
documented host trust boundary.

Multi-user peer credential mapping, remote CLI authentication, OIDC, and local
socket access by other operating-system users are deferred.

## User-visible operations

The CLI exposes these application operations. Exact option spelling may be
refined with the CLI adapter, but the semantics and identifiers are fixed.

### Service lifecycle

```text
hitch serve --config <path>
```

Starts one v2 service against an explicitly configured v2 data root. Startup
rejects a v1, unknown, or incompatible schema. Development uses a disposable
data root; this slice does not reset a production v1 installation.

### Create a private session

```text
hitch session create --profile <profile> --workspace <workspace> [--name <name>]
```

The service resolves stable configuration names, pins their exact revisions and
snapshots into one immutable `SessionSpec`, verifies the owner holds every
required use grant, creates one private local endpoint binding, and returns the
Hitch `SessionId`.

Changing profile, workspace, provider/model, or policy creates a new session in
the first slice. Session reconfiguration and fork UX are deferred.

### Submit and observe a Turn

```text
hitch prompt --session <session-id-or-name> [--idempotency-key <key>] [--image <path>] <text>
```

The CLI normally generates a cryptographically random idempotency key and may
accept an explicit key for deterministic callers. The trusted local connector
scopes it to the private endpoint; an untrusted prompt cannot choose another
origin.

The service immediately returns the durable `TurnId` and whether the Turn is
starting or queued. The request remains attached to delivery while connected.
Sanitized checkpoints may be rendered during execution. The immutable terminal
result and finalized response are queryable after disconnect or delivery
failure:

```text
hitch turn show <turn-id>
```

The first attachment path supports at most one image. The local connector opens
and validates the source, applies the configured byte limit, MIME-sniffs it,
copies it into Hitch-owned private attachment storage, records its hash and
provenance, and admits only the resulting `AttachmentId`. Dispatch resolves it
to a text-plus-optional-single-image driver projection only when the exact model
manifest allows that MIME type and decoded byte length. Pi never receives the
caller's host path.

### Control work

```text
hitch turn cancel <turn-id>
hitch session stop <session-id>
```

The requester may cancel their own queued or active Turn. Queued cancellation
is atomic and never reaches Pi. Active cancellation enters the durable
`cancelling` state, closes broker/tool authority, asks the driver to cancel, and
ends with bounded supervisor cleanup.

The content-blind administrator cancellation path exists in the authorization
contract but does not need a separate CLI identity in this single-owner slice.

### Resolve a safe approval

```text
hitch interaction approve <interaction-id>
hitch interaction deny <interaction-id>
```

Execution policy handles pre-authorized and denied operations first. An agent
approval request reaches the CLI only when the driver exposes a genuine
one-operation response. The owner may choose allow-once or deny-once. Persistent
agent choices are retained only as sanitized audit metadata and are never
selectable. If the driver cannot express a safe denial, Hitch cancels the Turn.

Structured free-form input requests resolve as no-input in this slice. Their
interactive CLI UX is deferred.

## Configuration bootstrap

The first slice uses one validated installation configuration to publish or
resolve:

- the installation and bootstrap owner
- the owner's local-peer identity binding and installation role
- one workspace and one workspace revision
- one agent profile and one agent-profile revision for Pi RPC
- one execution policy and immutable snapshot
- one turn policy and immutable snapshot
- one provider credential binding
- one immutable provider connection using the Pi native-library sidecar
- one exact provider/model allowance and default
- pinned declarative agent-resource snapshots and exact extension grants
- the configuration-use grants required by the owner

Publication is deterministic and transactional. Re-reading unchanged
configuration resolves the same stable resources and revisions. A semantic
configuration change publishes a new append-only revision or snapshot; it never
mutates a record pinned by an existing `SessionSpec`.

The configuration contains a reference used by the trusted credential store,
not an upstream credential value. The first connection uses the
`native-library-sidecar` contract in
[`v2-agent-runtime-provider-design.md`](./v2-agent-runtime-provider-design.md).
It pins the Pi/native catalog revision, registered origin set, credential
resolver, exact model manifest, and token estimator. The initial credential
store may reuse the operator's existing Pi auth storage through Pi's native
credential interfaces, but the worker never mounts or reads that storage. The
executable slice still exposes exactly one resolved connection/model pair even
though the feasibility spike exercises more than one native provider.

No management UI, dynamic configuration administration, invitation flow, or
delegated configuration publishing is part of this slice.

## Turn policy

The bootstrap Turn policy uses:

- `bounded-fifo` with `maxQueuedTurns = 3`
- a finite initial active-work budget
- finite per-tool extensions up to a finite maximum active-work budget
- a finite interaction wait
- no replay after possible prompt acceptance
- a finite provider-request count
- a finite total-token reservation
- a finite per-request output-token reservation
- checkpoint progress delivery
- durable finalized messages and terminal results
- no durable raw reasoning or raw tool input/output

Installation hard ceilings are mandatory and may only narrow the pinned
snapshot. Exact numeric defaults belong to the runtime-codec design and become
acceptance fixtures rather than implicit constants spread across services.

The provider gate is closed while a Turn is queued, `dispatching`, or
`submission-armed`, and while it is waiting for an interaction, cancelling, or
terminal. It opens only after protocol prompt submission is durably
`submitted-unconfirmed` (or stronger correlated acceptance evidence is durable),
and it closes before the next Turn is claimed.

## Agent runtime boundary consumed by the slice

The first `AgentDriver` contract needs only:

- capability discovery sufficient to validate the Pi profile
- profile-configuration decoding and sanitization
- runtime start with supervisor-provided sandbox paths and native-sidecar broker
  projection
- runtime resume from an opaque, protected Pi resume handle
- preparation of one exact Turn and its inference configuration without prompt
  emission
- `submitProtocolPrompt` only after exact durable `submission-armed` evidence
- correlated prompt acceptance distinct from protocol submission
- normalized event streaming with protocol-local correlation only; Hitch
  allocates all domain message/tool/interaction IDs
- safe approval response
- cancellation
- terminal reconciliation
- runtime close

The driver does not spawn processes, choose a sandbox, receive canonical host
paths or upstream credentials, renew leases, authorize events, persist records,
or deliver connector messages.

The supervisor owns the Pi executable allowlist, arguments, environment,
Bubblewrap launch, mount identity checks, lifetime container, lease fencing,
generated provider bridge extension, broker capability injection, sidecar
lifetime, descendant cleanup, and proof that an old sandbox is gone before a
successor launches.

## Persistence and recovery consumed by the slice

The first schema and repositories cover only records exercised here:

- installation, principal, local identity binding, and role/use grants
- workspace/profile/policy resources and pinned revisions or snapshots
- provider connection and credential binding metadata
- session, immutable `SessionSpec`, metadata, lifecycle, and private endpoint
  binding
- attachment metadata and private storage reference
- Turn, input snapshot, queue, runtime state, interactions, finalized messages,
  and payload-derived durable events
- worker lease, protected resume handle, credential lease, inference resolution,
  reservations, and usage ledger
- local response delivery and audit envelope

Repository operations must make these boundaries atomic:

- bootstrap publication
- session creation and private binding creation
- Turn admission, origin-scoped idempotency, and bounded queue insertion
- queue-head claim plus `dispatching` transition and durable
  `AgentDispatchAttemptId`
- durable `submission-armed` authorization before any protocol prompt byte
- protocol-submission outcome plus `submitted-unconfirmed` transition
- prompt acceptance
- queued cancellation
- active cancellation request
- interaction creation and resolution
- worker fence issuance, renewal, and release
- inference resolution at admission, request reservation, and usage-ledger
  update
- terminal result and finalized output
- old-Turn broker drain/charge plus active-queue handoff
- independently authorized delivery creation

After restart:

- queued Turns remain eligible for dispatch after live reauthorization
- a dispatch failure proven to precede every protocol byte may retry within
  policy
- `submission-armed`, submitted-unconfirmed, or accepted work is never replayed
  heuristically
- exact driver reconciliation may resume it; otherwise it becomes
  `unknown/worker-lost-after-dispatch`
- stale worker fences and broker capabilities fail
- an unconfirmed old sandbox blocks the session instead of permitting two
  workers against one workspace
- terminal results remain immutable
- interrupted delivery may retry or expire without changing the Turn result

## Security and product claims

When every secure acceptance test passes, this slice may claim:

- Hitch authorization, not local caller-supplied IDs or Pi state, controls
  session and Turn access.
- Pi and its model-facing tools see only the authorized sandbox resources.
- A Hitch-managed upstream provider credential is absent from Pi arguments,
  environment, mounts, configuration, logs, and transcripts.
- Pi receives only a revocable local broker capability for one
  worker/provider connection.
- Every loaded agent resource is an exact immutable snapshot or extension grant;
  executable extensions share only that worker's sandbox and broker authority.
- Provider/model/reasoning and finite request/token limits are enforced at the
  native-sidecar broker boundary.
- Provider protocol serialization, streaming, compatibility, and OAuth refresh
  are reused from the exact pinned Pi provider stack rather than reimplemented
  by Hitch.
- Possibly accepted prompts are not automatically replayed.
- Stale workers cannot emit accepted events or use renewed Hitch authority.
- Terminal Turn results and delivery outcomes are independently durable.

This slice does not claim:

- cryptographic privacy from the host administrator
- isolation from another process running as the Hitch service account
- arbitrary network egress confinement outside the secure first-slice worker
  and sidecar origin policy
- prevention of direct requests using a credential deliberately placed in an
  authorized prompt, workspace, or attachment
- provider cost enforcement
- safe unattended execution
- multi-user host fairness or denial-of-service isolation
- PTY, user-supplied MCP, ACP, or non-Pi security equivalence
- safety of unreviewed extensions or extension-owned/background inference

## Acceptance scenarios

The slice is complete only when automated tests prove:

1. Bootstrap creates one owner and deterministic configuration resources without
   duplicating unchanged revisions.
2. A caller cannot select or forge a principal, endpoint owner, grant,
   `SessionSpec`, Turn origin, or authorization result.
3. Session creation pins exact revisions and rejects a missing/revoked use grant.
4. Duplicate prompt submission returns the original Turn receipt and queue
   position.
5. One active Turn and three pending Turns are accepted; a fourth pending Turn
   is rejected without reaching the driver.
6. Requester cancellation wins only while the named queued Turn remains pending,
   and active cancellation follows the bounded cleanup path.
7. Queue dispatch reauthorizes the requester, origin binding, configuration
   grants, provider connection/credential custody binding, and installation
   ceilings.
8. Submission arming, protocol prompt submission, acceptance evidence, worker
   loss, exact reconciliation, and `unknown` recovery follow the accepted state
   machine using the same durable dispatch-attempt ID and without heuristic
   replay.
9. Invalid, uncorrelated, stale-fence, secret-bearing, or oversized driver
   events are rejected or sanitized before becoming Hitch events.
10. Event visibility and durability are derived by trusted Hitch code, not
    selected by the driver.
11. A safe allow-once/deny-once interaction works; persistent or ambiguous agent
    options cannot be selected.
12. The image attachment is copied into private storage, size/MIME validated,
    hash recorded, checked against the exact model MIME/per-request byte/count
    limits and the one-new-image-per-Turn limit, and supplied to Pi without
    exposing the source host path. Accumulated image history over the manifest
    limit fails before native sidecar invocation until pruning/compaction
    semantics exist.
13. The secure Pi sandbox exposes the intended workspace, pinned resources, and
    tools while blocking host, Hitch-state, symlink-swap,
    protected-destination, shell, resource-discovery, and ungranted-extension
    escape attempts.
14. The upstream credential and real Pi auth store are absent from the sandbox,
    a valid broker capability is restricted to the active worker, connection,
    and Turn, and stale, idle, queued, waiting, cancelling, and terminal
    requests fail.
15. Concurrent inference reservations cannot exceed request/token ceilings;
    missing usage is conservatively charged, a forward authorization cannot be
    replayed into a second native invocation/upstream send, the sidecar cannot
    egress outside registered origins, and old-Turn requests drain or abort
    before handoff.
16. A finalized result remains queryable when the originating CLI disconnects
    or delivery fails.
17. Delivery rechecks the private endpoint binding and current recipient
    authority without rewriting the terminal Turn result.
18. Restart and forced worker-loss tests leave one explainable durable state,
    never two workers or a silently replayed Turn.
19. Audit records contain actor, session, Turn, lease, interaction, reservation,
    and delivery correlation without raw secrets, prompt bodies in operational
    envelopes, raw reasoning, or raw tool input/output.
20. The version-pinned Pi bridge represents streaming, reasoning, tools, images
    where supported, usage, errors, cancellation, and OAuth refresh; mismatched
    native-stack/catalog revisions fail closed.
21. Opt-in DeepSeek and OpenAI Codex smoke calls pass through the same native
    sidecar and sandbox boundary after deterministic provider-stub tests pass.

## Explicit non-goals

The first executable slice does not include:

- importing, migrating, or dual-writing v1 data
- replacing the live v1 Telegram or WeChat service
- Telegram, WeChat, Discord, QQ, Feishu, or HTTP ingress
- PTY passthrough or full Pi TUI behavior
- ACP or another agent backend
- multiple principals, enrollment, invitations, delegation, or shared endpoints
- schedules, triggers, subscriptions, or unattended producers
- session fork/reconfiguration UX
- agent-selected models, model switching, slash commands, or model pickers
- multiple simultaneously exposed provider connections or runtime registration
- native wire gateways, agent-native connections, or Hitch-authored provider
  protocol adapters
- extension-handled prompts, background extension inference, user MCP servers,
  or agent config/package management
- free-form elicitation
- outbound media or automatic path discovery
- management UI
- alternative sandbox engines
- general-purpose agent egress proxying
- CPU/fairness claims for mutually untrusted local users
- production reset/cutover tooling

## Implementation gate

The minimal `AgentDriver`/supervisor and transport-pluggable inference control
contracts are fixed in
[`v2-agent-runtime-provider-design.md`](./v2-agent-runtime-provider-design.md)
and the compile-only model. Before repository, connector, or supervisor
implementation begins, the focused Pi `ModelRuntime` sidecar spike must satisfy
that document's feasibility gate. A successful spike becomes the implementation
fixture and fixes the exact first connection/model configuration.

The gate was satisfied on 2026-07-25 by
[`spikes/pi-native-sidecar`](../spikes/pi-native-sidecar/README.md). The first
implementation fixture is Pi 0.82.0 with the native-library sidecar; deterministic
tests pin the bridge behavior, while real DeepSeek and OpenAI Codex calls prove
the two initial native transport/auth paths.

The reviewed commit-sized work and acceptance mapping are maintained in
[`v2-implementation-plan.md`](./v2-implementation-plan.md).

Any proposed capability not required by an acceptance scenario stays outside
the executable model or in `v2-deferred-design.md`.

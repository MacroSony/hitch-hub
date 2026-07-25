# V2 Domain Model

This directory contains compile-only domain interfaces. It is intentionally
isolated from the operational v1 implementation while the model is reviewed.
It does not implement storage schemas, runtime codecs, migrations, or adapters;
the adapter files define compile-only trust boundaries.

V2 is a clean replacement for v1 storage. The implementation will initialize
one canonical schema after an explicit destructive cutover; it will not add
prefixed tables beside v1, import legacy records, or carry compatibility paths
into the new repositories.

Current decisions:

- A session has one immutable `SessionSpec`.
- Each `SessionSpec` pins an append-only `TurnPolicySnapshot` separately from its execution policy.
- Agent profiles, workspaces, policies, declarative agent resources, and
  extension grants are append-only revisions or snapshots.
- Standard Pi profiles can enable pinned skills/templates/themes and exact
  granted extensions. Ambient discovery and hot reload remain disabled;
  executable extensions share the worker's sandbox and local inference
  authority.
- Agent profile revisions explicitly name their resource/grant snapshots.
- Agent profiles pin an immutable provider connection and allow either all or
  an explicit list of that connection's models.
- Agent profiles define an explicit default reasoning intent; admission resolves
  both model and reasoning defaults before creating a Turn.
- Every turn records either a resolved allowed provider/model or an explicit
  agent-selected choice (optionally constrained to one allowed provider), plus
  an explicit agent-default or portable reasoning-effort intent.
- Provider credentials are referenced, never copied into a snapshot. Brokered
  connections use Hitch control-plane custody; `agent-native` connections
  explicitly move the native runtime into the credential trust boundary.
- Secure runners receive only local, worker/connection-scoped broker
  capabilities. Hitch-managed provider secrets never enter agent arguments,
  environment, mounts, configuration, logs, or transcripts.
- The first secure inference path reuses Pi's version-pinned `ModelRuntime`,
  provider catalog, auth refresh, and native streaming implementations in a
  trusted sidecar. Native wire gateways and Hitch-authored codecs are later
  transport modes, not one adapter per upstream.
- Connector and local-client destinations are modeled as `Endpoint` records.
- Connector commands carry caller intent only. Trusted local authentication
  constructs the application context; callers cannot supply a principal,
  endpoint binding, Turn origin, SessionSpec, or authorization result.
- Application persistence exposes named semantic atomic units of work rather
  than CRUD or a generic transaction callback. Each method owns and completes
  its transaction before returning, so process, driver, sidecar, attachment,
  and delivery I/O remains outside SQLite.
- Write units accept sealed request/service contexts and repeat live authority
  checks in the same transaction. Advisory authorization decisions are never
  reusable write authority.
- Attachment commands carry a connector-minted bounded intake handle, never a
  host path, caller-selected durable ID, or unbounded in-memory byte array.
- Ready provider invocations and interaction responses must cross a separate
  durable send-started compare-and-swap before their external bridge/driver
  accepts them. The external boundary rejects replayed dispatch IDs, and
  restart recovery closes an interrupted interaction response as
  outcome-unknown instead of guessing or resending it.
- Delivery transports report only delivered/failed observations. Persistence
  derives attempt timestamps, retry schedules, exhaustion, expiry, and
  authorization suppression from trusted state.
- Stable configuration references are normalized immutable installation keys;
  display names are never lookup authority. `session stop` drains/cancels the
  current workload but does not archive the reusable Session.
- A prompt's Session ID-or-owner-scoped-name selector is resolved and
  reauthorized inside the same Turn-admission transaction as idempotency and
  queue insertion.
- Startup recovery closes a delivery attempt left in progress by a crash and
  derives retry, exhaustion, or expiry without inventing a transport outcome.
- Endpoints connect through mutable, suspendable, and revocable `SessionEndpointBinding` records.
- V2.0 bindings are private only. Shared endpoints may be recognized by ingress
  but cannot be bound until their authority and lifecycle model is implemented.
- Runtime state and display metadata are separate from session configuration.
- Every launch revalidates the immutable snapshot against current authority; immutability never defeats revocation.
- Host paths are confined to the trusted workspace catalog and supervisor boundary.
- Worker leases use a session-monotonic fence; stale workers cannot emit
  accepted events or use renewed broker authority.
- Provider calls consume durable per-Turn request/token reservations attributed
  to the current worker fence. Interaction waits close the broker gate, and all
  in-flight requests drain or abort before the next Turn dispatches.
- Native provider invocation or upstream credential injection accepts only one
  opaque aggregate binding the exact registered connection, validated request,
  and reservation/forwarding attempt. Mismatched identities fail before the
  one-send compare-and-swap or any upstream I/O.
- Request validation also binds the normalized request identity and its token
  estimate into one trusted aggregate before reservation, preventing a caller
  from pairing a request with another request's cheaper estimate.
- The installation carries the exact Hitch v2 service/schema identity
  (`schemaVersion = 1`, SQLite application ID `HIT2`) and live hard ceilings.
  Opening a legacy, unknown, partial, older, or newer root is a rejection,
  never a compatibility migration or reset.
- Installation ceilings may only narrow pinned Turn policy and resource limits;
  they include before-acceptance retry, memory, process, temporary-storage, and
  agent-output limits and are rechecked at admission, dispatch, launch, and
  broker boundaries.
- First-slice attachments are immutable private image copies. Their records
  retain MIME, byte length, digest, and opaque Hitch-owned blob reference, but
  never the caller's source path.

Identity and authorization decisions:

- Principals are stable, installation-scoped authorization subjects and may represent humans or independently managed
  services.
- Connector and local-peer subjects resolve through revocable `IdentityBinding` records. An identity binding maps to
  exactly one principal and is revoked/replaced rather than reassigned in place.
- Authentication evidence is request-specific, carries an assurance level, and is produced only by trusted adapters.
- Authentication-request retention contains only trusted, non-reusable adapter
  evidence and the decision correlation; raw peer credentials and socket paths
  are not durable domain data.
- The first private local peer bootstraps the initial administrator. Later local CLI callers resolve through their
  operating-system peer identity and receive only their principal's actual grants.
- Normal enrollment is administrator-created or uses a short-lived proof-of-possession invitation. Unknown connector
  identities receive no authority, and identities are never merged by display name or other unverified metadata.
- Identity, installation-role, and credential-management changes require elevated authentication; normal connector
  authentication is sufficient only for the actions granted to that principal at normal assurance.
- Installation roles are `admin` and `member`. Administrator status does not implicitly reveal private sessions.
- An administrator has content-blind operational authority over every session: inspect operational metadata, stop,
  quarantine, archive, suspend bindings, and revoke access. It may not read/prompt a private session or create a
  content-delivery binding without an explicit session grant.
- Session ownership is intrinsic and singular; delegated roles are `operator`, `participant`, `approver`, and `viewer`.
- Agent-profile, workspace, policy, extension, and provider-binding use grants target stable resources and follow all
  currently and future published revisions. Each session continues to pin the exact revisions it uses.
- Turn-policy use grants follow future published revisions of a stable policy, while each session and turn records the
  exact policy snapshot actually used.
- Session endpoint bindings route traffic and filter audiences; identity and access grants authorize every action.
- Disabled principals, revoked identity bindings, and revoked grants fail closed and are checked on every action.

Initial built-in role semantics:

- Installation `admin`: every installation permission and every content-blind session-administration permission, but no
  implicit private-session content permission.
- Installation `member`: `installation.read` and `session.create`, subject to configuration-resource use grants.
- Session owner: every session permission.
- Session `operator`: read, prompt, control, and create/update private bindings to the operator's own verified endpoints.
- Session `participant`: prompt and receive the originating response, but no private history, control, approval, or
  binding authority.
- Session `approver`: read and approve.
- Session `viewer`: read only.

Endpoint decisions:

- A private endpoint records the principal proven to control it. `session.bind-self` never permits binding another
  principal's endpoint.
- Shared endpoint binding, audience, context, activation, response, and
  endpoint-participant grant semantics are deferred. The preserved design
  considerations live in `docs/v2-deferred-design.md`.
- An `EndpointSessionSelection` is mutable private UI routing state. It does not
  grant access or alter session configuration.

Turn and dispatch decisions:

- A Turn is an immutable Hitch record with its own ID, origin-scoped idempotency key, requester evidence, exact input
  snapshot, model/reasoning choice, and turn-policy snapshot.
- At most one turn actively controls an agent session. Accepted pending work remains in a Hitch-owned bounded FIFO; only
  the queue head reaches an agent driver.
- Hitch allocates a durable `AgentDispatchAttemptId` and records it through
  `dispatching`, `submission-armed`, and `submitted-unconfirmed`.
  `submission-armed` precedes any prompt byte; after an uncertain write or
  restart it is non-replayable unless a live driver proves that no byte was
  written for that exact attempt.
- Complete protocol prompt submission is not prompt acceptance. Turns remain
  `submitted-unconfirmed` until an explicit acknowledgement, causally
  attributable work event, or terminal response provides evidence. Background
  session events do not count without a driver guarantee tying them to the exact
  dispatched Turn.
- A possibly accepted prompt is never replayed automatically. Exact driver reconciliation may resolve it; otherwise
  worker loss produces an `unknown` result and an explicit retry creates a new turn.
- Resolved-model Turns are projected explicitly into the agent and enforced by
  the selected inference control mode. Agent-selected Turns pin the first
  accepted provider/model choice as an immutable inference resolution and
  cannot switch models mid-Turn. Their exposed catalog is filtered to
  combinations supported by the exact driver/transport revision and requested
  reasoning intent.
- Requesters may cancel their own queued turns by immutable Turn ID.
  Operators/owners may cancel any queued turn. The repository removes it only
  if it remains pending; edit-in-place queue replacement is deferred.
- Requesters may also cancel their own active Turn through `turn.cancel`.
  Operators/owners use `session.control`, and a content-blind administrator uses
  `turn.admin.cancel`.
- Queued work is reauthorized before dispatch. Authority or endpoint-binding revocation cancels it.
- Loss of authority required to execute an active turn, including identity, origin binding, configuration-use,
  or credential revocation, blocks new privileged operations and initiates cancellation. Pending interactions fail
  closed; delivery performs a separate live authorization check.
- The initial active-work budget is extended by distinct tool invocations up to
  a hard maximum, matching the v1 dynamic deadline. Human interaction wait is
  accounted separately; v2.0 does not impose an additional fixed wall-clock cap.
- ACP permission requests are subordinate to Hitch execution policy and session approval authority. Agent-provided
  persistent choices never create Hitch grants and cannot be relabeled as one-time responses. Direct selections require
  an advertised one-operation disposition; otherwise a driver must guarantee safe one-operation mediation or Hitch
  fails closed. Durable interaction records preserve the sanitized request, tool context, authenticated resolver,
  authorization basis, normalized decision, original protocol option semantics, and actual driver response.
- Event callers do not choose durability. The persistence boundary derives it
  from payload kind and rejects invalid storage behavior: raw progress/message
  chunks remain transient, while finalized messages, interaction decisions,
  terminal results, and state transitions are durable.
- Turn completion and outbound delivery are separate state machines; delivery failure never rewrites a completed result.
- The terminal response projection is immutable and remains queryable after a
  disconnect. Each response delivery has a separately durable lifecycle and
  reauthorizes its private endpoint binding and recipient at send time.
- Operational audit records use a closed action-discriminated envelope; each
  action requires its exact ID correlations. They never contain prompt bodies,
  secret material, host paths, raw reasoning, or raw tool input/output.
- Resume handles are opaque protected references tied to the exact worker
  lease/fence, Turn, and dispatch attempt, with explicit expiry and retirement
  reasons. Recovery records couple each conservative outcome to only the prior
  lifecycle states that can produce it; possible submission is never heuristic
  replay evidence.

Structural invariants such as non-empty allowlists, unique providers, valid
default models, exact provider-connection and transport-bridge pins, compatible
profile/session resource lists, compatible workspace grants, one provider
binding per selected connection, private binding to a private Endpoint
controlled by the expected principal, positive timing values, invitation expiry
and single-use claims, origin-scoped idempotency, one active turn, one durable
dispatch-attempt ID through active lifecycle states, atomic FIFO claims and
complete cancellation transitions, one matching inference resolution per Turn,
positive finite inference ceilings, request-fingerprint reservation/forward
authorization, reservation/ledger conservation, drain-before-Turn handoff,
positive worker fencing tokens, terminal immutability,
driver-protocol-to-Hitch ID allocation, payload-derived event durability,
launch-time mount identity/destination validation, and active-grant
reauthorization will be enforced by runtime codecs as part of the first vertical
slice.

Runtime validation also rejects duplicate entries for one provider, conflicting
connections, connection/model/native-stack or credential-custody mismatches,
profile/SessionSpec resource drift, replayed forward authorizations,
request-selected origins, and image history beyond the exact model manifest.

The durable broker uniqueness key is `(TurnId, ProviderConnectionId,
InferenceRequestFingerprint)`. The reservation is the sole durable owner of
that normalized request identity. It survives a worker restart, and its one
forwarding-attempt record must atomically transition from `ready-for-one-send`
to `send-started` before at most one upstream/native send.

The execution trust boundary, credential leases, broker request rules, sanitized
agent configuration, and ephemeral supervisor launch authorization are
specified in `docs/v2-execution-security-design.md`. The driver, resource, prompt
submission, and inference transport contract is specified in
`docs/v2-agent-runtime-provider-design.md`.

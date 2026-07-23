# V2 Domain Model

This directory contains compile-only domain interfaces. It is intentionally
isolated from the operational v1 implementation while the model is reviewed.
It does not define storage schemas, runtime codecs, migrations, or adapters.

Current decisions:

- A session has one immutable `SessionSpec`.
- Each `SessionSpec` pins an append-only `TurnPolicySnapshot` separately from its execution policy.
- Agent profiles, workspaces, policies, and extension grants are append-only revisions or snapshots.
- Agent profiles allow providers and either all or an explicit list of their models.
- Every turn records either a resolved allowed provider/model or an explicit
  agent-selected choice (optionally constrained to one allowed provider).
- Provider credentials remain broker-owned and are referenced, never copied into a snapshot.
- Connector and local-client destinations are modeled as `Endpoint` records.
- Endpoints connect through mutable, suspendable, and revocable `SessionEndpointBinding` records.
- Endpoint binding policies are append-only snapshots and remain outside the immutable `SessionSpec`.
- Runtime state and display metadata are separate from session configuration.
- Every launch revalidates the immutable snapshot against current authority; immutability never defeats revocation.
- Host paths are confined to the trusted workspace catalog and supervisor boundary.

Identity and authorization decisions:

- Principals are stable, installation-scoped authorization subjects and may represent humans or independently managed
  services.
- Connector and local-peer subjects resolve through revocable `IdentityBinding` records. An identity binding maps to
  exactly one principal and is revoked/replaced rather than reassigned in place.
- Authentication evidence is request-specific, carries an assurance level, and is produced only by trusted adapters.
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
- Endpoint participant: prompt only through the exact shared binding named by the grant.
- Session `approver`: read and approve.
- Session `viewer`: read only.

Endpoint and group-chat decisions:

- A private endpoint records the principal proven to control it. `session.bind-self` never permits binding another
  principal's endpoint.
- Shared endpoints and their policy snapshots are session-owner managed. Administrators may blindly suspend or revoke
  them but cannot broaden their audience.
- Shared audience modes are owner-only, any already-authorized principal, or an allowlist that further filters
  already-authorized principals. Presence in a chat and an @mention never grant authority.
- Shared interaction modes are respond-to-all, bounded contextual listening with mention/reply/command activation, and
  mentions-only. Passive context capture never starts the agent or executes tools.
- Only audience-authorized messages may enter shared context. Normal output returns to the triggering endpoint according
  to its response policy and is never broadcast to every session binding.
- Authenticated-but-unenrolled guest participation is disabled in the initial model. It will require a separately
  reviewed endpoint-scoped guest actor, quotas, and audit policy if added later.
- Newly created shared bindings should default to authorized principals, mentions-only activation, a threaded/reply
  response when supported, ignored automated senders, no proactive delivery, and bounded per-sender/binding activation
  rates and turn queues.
- An `EndpointSessionSelection` is mutable UI routing state. It does not grant access or alter session configuration.

Turn and dispatch decisions:

- A Turn is an immutable Hitch record with its own ID, origin-scoped idempotency key, requester evidence, exact input
  snapshot, model choice, and turn-policy snapshot.
- At most one turn actively controls an agent session. Accepted pending work remains in a Hitch-owned bounded FIFO; only
  the queue head reaches an agent driver.
- A successful transport write is not prompt acceptance. Turns remain `submitted-unconfirmed` until an explicit
  acknowledgement, causally attributable work event, or terminal response provides evidence. Background session events
  do not count without a driver guarantee tying them to the exact dispatched Turn.
- A possibly accepted prompt is never replayed automatically. Exact driver reconciliation may resolve it; otherwise
  worker loss produces an `unknown` result and an explicit retry creates a new turn.
- Requesters may cancel or replace their own queued turns. Operators/owners may cancel any queued turn but may not replace
  another principal's turn. Replacement creates a new immutable turn in the same stable queue slot.
- Queue cancel/replace compares the slot revision, queued state, and current Turn ID atomically; mutation retries use a
  separate operation idempotency key.
- Queued work is reauthorized before dispatch. Authority, endpoint-binding, or binding-policy revocation cancels it.
- Loss of authority required to execute an active turn, including identity, origin binding/policy, configuration-use,
  or credential revocation, blocks new privileged operations and initiates cancellation. Pending interactions fail
  closed; delivery performs a separate live authorization check.
- Active-work and human-wait time are accounted separately, while an absolute wall-clock limit never pauses.
- ACP permission requests are subordinate to Hitch execution policy and session approval authority. Agent-provided
  persistent choices never create Hitch grants and cannot be relabeled as one-time responses. Direct selections require
  an advertised one-operation disposition; otherwise a driver must guarantee safe one-operation mediation or Hitch
  fails closed. Durable interaction records preserve the sanitized request, tool context, authenticated resolver,
  authorization basis, normalized decision, original protocol option semantics, and actual driver response.
- Event payload kinds constrain durability: raw progress/message chunks cannot be durable, while finalized messages,
  interaction decisions, terminal results, and state transitions cannot be transient.
- Turn completion and outbound delivery are separate state machines; delivery failure never rewrites a completed result.

Structural invariants such as non-empty allowlists, unique providers, valid default models, compatible workspace grants,
one provider binding per selected provider, endpoint/policy audience compatibility, self-binding ownership, non-empty
activation signals, positive context/rate/timing limits, invitation expiry and single-use claims, origin-scoped
idempotency, one active turn, atomic queue claims/replacements, terminal immutability, and active-grant reauthorization
will be enforced by runtime codecs after the interfaces are approved.

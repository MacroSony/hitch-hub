# Hitch v2 multi-user agentic MVP

Date: 2026-08-09

Status: accepted product and implementation boundary

Current implementation state and the next bounded assignment are maintained in
[`v2-status.md`](./v2-status.md). The detailed historical task catalog remains
in [`v2-implementation-plan.md`](./v2-implementation-plan.md).

This document supersedes [`v2-first-slice.md`](./v2-first-slice.md) as the
product boundary for new v2 work. The committed single-owner walking skeleton
and its tests remain valid foundation evidence; they do not yet satisfy this
multi-user MVP.

## Outcome

One Hitch installation serves multiple statically enrolled human principals.
Each principal authenticates remotely over a private network, owns private
sessions and a fixed workspace, and can run a constrained Pi agent in an
ephemeral Bubblewrap sandbox. Hitch derives identity from trusted transport
evidence, enforces owner-scoped authorization and resource limits, keeps
provider credentials outside every worker, persists a terminal Turn result,
and permits the owner to retrieve that result after disconnect.

The MVP is a private alpha for a small trusted user population. It is not a
public SaaS, collaboration system, general remote shell, or v1 connector
replacement.

## Fixed deployment and trust boundary

- There is one Linux Hitch service, one canonical SQLite database, and one
  installation trust domain.
- Remote access is available only through an operator-controlled private
  network such as WireGuard or a Tailnet.
- The remote protocol is bounded versioned JSONL over mutually authenticated
  TLS. Hitch validates the client certificate itself; it does not trust an
  unbound reverse-proxy identity header.
- The operator configures one exact client-certificate trust root. Hitch
  verifies the certificate chain, validity interval, client-authentication
  purpose, public-key policy, and minimum TLS version before application
  framing begins.
- The identity key is the lower-case `sha256:<64 hex>` digest of the complete
  DER-encoded X.509 client certificate. It resolves through one active
  immutable identity binding to exactly one Hitch principal. Requests never
  supply a principal ID, endpoint owner, grant, or authorization result.
- A successful binding resolution mints or resolves one private
  `remote-client` endpoint owned by that principal. Certificate replacement
  revokes the old binding rather than reassigning its identity in place.
- The bootstrap owner is the initial installation administrator. Additional
  users and replacement certificates are provisioned or revoked through a
  local administrator-only command accepted through the existing owner-private
  service boundary; the CLI still does not open SQLite. Remote enrollment and
  administration are not exposed.
- Root, the Hitch service account, and the host operator remain inside the
  documented host trust boundary. The MVP does not claim cryptographic privacy
  from the host administrator.

## Multi-user identity and authorization

- One installation may contain multiple active human principals.
- Installation roles are limited to `admin` and `member`.
- Administrator authority is content-blind for sessions owned by another
  principal. It may disable a principal, revoke an identity binding, cancel or
  quarantine work, and inspect operational metadata, but it does not imply
  permission to read prompts, workspace content, or results. Cross-owner
  containment is accepted only through the owner-private local administrator
  service boundary with elevated authentication; the remote mTLS protocol does
  not expose it.
- Sessions and Turns have exactly one owner. Only that owner may create,
  prompt, read, perform ordinary cancellation, or receive results for the
  session through the remote protocol. Local content-blind administrator
  containment is a distinct operation and never returns content.
- Session sharing, delegated roles, teams, group endpoints, and cross-principal
  context are rejected by executable codecs and services.
- Every admitted or dispatched Turn rechecks the principal, identity binding,
  session ownership, configuration-use grants, workspace binding, provider
  connection, and installation ceilings.
- Disabling a principal or revoking its identity binding denies new work and
  prevents queued work from dispatching. Active work follows bounded
  cancellation and sandbox cleanup.

## Agent and workspace boundary

- Each principal has one operator-provisioned canonical workspace root. The
  remote client cannot supply a host path.
- Each Turn launches a fresh Bubblewrap worker. No Pi worker, resume handle, or
  sandbox is reused across Turns in the MVP.
- The worker receives only its owner's exact workspace at `/workspace`, a
  private temporary directory, the reviewed Pi artifacts, and the generated
  bridge extension.
- Immediately before launch, Hitch revalidates source identity, canonical
  paths, ownership, symlinks, aliases, protected destinations, and mount
  overlap.
- Model-facing capabilities are limited to `read`, `write`, `edit`, and `ls`
  inside `/workspace`. Shell, process execution, worker networking, arbitrary
  mounts, MCP, package installation, ambient discovery, and user extensions
  are denied.
- Every worker has finite wall time, memory, process, temporary-storage, and
  output limits. The supervisor kills and confirms cleanup of the entire
  process tree before completing the Turn.
- At most one sandbox may execute for a principal at a time. A principal may
  have at most three pending Turns across all owned sessions. Admission and
  claim enforce those principal-wide limits atomically. Pending Turns use one
  deterministic principal-wide FIFO ordered by durable admission ordinal, not
  session lookup order. Installation-wide concurrency is a fixed operator
  ceiling.

## Provider and credential boundary

- The MVP exposes one exact Pi version, one provider connection, one model,
  and one reasoning/default policy revision.
- One administrator-managed provider credential may be shared by explicitly
  granted principals. Per-user provider accounts and user-managed credentials
  are deferred.
- The worker never receives an API key, OAuth token, auth-store path, provider
  origin, or unrestricted sidecar capability.
- The trusted sidecar uses the committed native Pi runtime and E01 egress
  containment. Production launch verifies every Pi, bridge, preload, and
  catalog artifact.
- A broker authorizes one normalized request for one active principal, Turn,
  worker, connection, model, and fixed token ceiling. The resulting opaque
  authorization can start at most one native provider invocation.
- Automatic provider retries are disabled. An uncertain send is recorded and
  never replayed automatically.
- The MVP enforces fixed per-Turn and per-principal request/token ceilings. It
  does not provide billing, provider-cost guarantees, or configurable quota
  administration.

## Turn lifecycle and client behavior

- The MVP accepts text prompts only. Existing local attachment work remains in
  the repository but remote production submission rejects attachments.
- A prompt is admitted durably before execution and retains origin-scoped
  idempotency.
- The coordinator claims only an authorized queue head, launches one ephemeral
  worker, normalizes bounded Pi events, persists the authoritative terminal
  result, and releases the principal execution slot.
- Interactive approvals and free-form input are not exposed. Policy-approved
  filesystem tools run; every other tool or interaction request is denied and
  the Turn fails closed.
- The remote CLI receives the durable submission receipt and may poll
  `turn show`. Live event streaming and independent push delivery are deferred.
- Cancellation closes broker authority, aborts the driver, and kills the
  complete sandbox process tree.
- After service restart, queued Turns may be reconsidered only after normal
  authorization. A Turn that may have submitted bytes or had an active worker
  is terminalized as `unknown/worker-lost`; the MVP does not resume it or infer
  success, and it never silently resubmits it.

## Required security verification

The existing deterministic suite remains required. New MVP work needs a
focused test set, not the original exhaustive final-acceptance program. Before
the private alpha is considered usable, automated tests must prove:

1. a client certificate maps to only its bound principal and cannot select a
   different identity in protocol data;
2. principal A cannot enumerate, create under, prompt, read, cancel, or receive
   any session or Turn owned by principal B;
3. administrator containment authority does not reveal another principal's
   prompt, result, or workspace content;
4. revoked bindings and disabled principals deny admission, dispatch, and
   result access at the correct live boundaries;
5. worker A cannot mount, read, or mutate worker B's workspace, data root,
   configuration, or runtime state, including through symlink or path races;
6. model tools cannot escape the exact workspace or obtain shell, network,
   process, credential, database, or arbitrary extension authority;
7. per-principal and installation concurrency/resource ceilings fail closed;
8. one broker authorization cannot cause two native invocations and an
   uncertain submission is not replayed after restart;
9. cancellation and normal completion both remove the entire worker process
   tree and revoke sidecar authority; and
10. the end-to-end two-principal test runs one real sandboxed agent Turn for
    principal A, persists its terminal result, returns it only to A, and proves
    principal B cannot access any A identifier or artifact.

One provider-backed smoke remains opt-in. Deterministic provider and transport
fakes run in the normal suite.

## Consolidated implementation sequence

Existing completed V2 tasks remain committed foundation. New work is grouped
by the smallest dependency-complete MVP slices:

1. **V2-M01 — multi-principal contract and schema**
   - revise executable codecs, configuration publication, canonical schema,
     and repository invariants for multiple active human principals;
   - add certificate identity bindings, `admin`/`member` installation roles,
     principal-owned workspace bindings, per-principal execution capacity, and
     private owner-only endpoints;
   - define the certificate identity as SHA-256 of the complete DER certificate
     and make one-active/three-pending principal-wide FIFO state relational and
     atomic;
   - reject every deferred shared/delegated discriminant.
2. **V2-M02 — mTLS ingress and local administration**
   - implement certificate verification and exact fingerprint-to-binding
     authentication evidence;
   - add local-only principal create/disable and certificate bind/revoke
     commands;
   - reuse the bounded connector protocol without accepting identity fields.
3. **V2-M03 — multi-user application enforcement**
   - generalize session creation, Turn admission/query/cancellation, live
     authorization reads, queue capacity, and audits from the bootstrap owner
     to the authenticated principal;
   - add the cross-principal denial matrix before any production runtime is
     connected.
4. **V2-M04 — minimal Pi driver and ephemeral sandbox**
   - complete the prompt/acknowledgement/event/cancel/terminal/close subset of
     V2-007;
   - complete V2-010A mount verification, Bubblewrap rendering, resource
     ceilings, per-principal scheduling, and confirmed process-tree cleanup;
   - omit worker reuse, resume, and live reconciliation.
5. **V2-M05 — verified sidecar, one-shot broker, and launch composition**
   - complete V2-006B artifact and production sidecar integration;
   - implement the minimal V2-011 request validation, fixed ceilings, opaque
     one-shot forwarding authorization, credential custody, and uncertain-send
     settlement;
   - compose the worker and sidecar through the V2-010B trust boundary.
6. **V2-M06 — thin Turn coordinator and durable query**
   - claim and reauthorize work, launch an ephemeral worker, persist trusted
     bounded events, cancel, terminalize, and release capacity;
   - terminalize uncertain or interrupted active work without resume or
     automatic replay;
   - return owner-authorized terminal results through `turn show` without a
     push-delivery worker.
7. **V2-M07 — production composition and private-alpha gate**
   - compose local administration, remote mTLS ingress, recovery scan, runtime,
     and graceful shutdown under production `serve`;
   - add the focused security tests above and one opt-in provider smoke;
   - publish operator guidance for certificate, user, workspace, credential,
     backup, revocation, and upgrade procedures.

V2-M01 and V2-M02 are committed. V2-M03 is independently reviewed in the
current working tree; after its frozen candidate is committed, V2-M04 is the
next dependency-ordered implementation assignment. V2-007 and pure V2-010A
work may proceed independently only when they do not encode the old
singleton-owner assumption.

## Explicitly deferred from this MVP

### Identity, administration, and collaboration

- public Internet exposure, browser access, passwords, OIDC, SSO, signup,
  self-service enrollment, invitations, account recovery, and remote admin;
- automated certificate issuance/renewal, multiple client trust roots, ACME,
  external PKI synchronization, and transparent certificate migration;
- shared sessions, session-role delegation, teams, group endpoints, participant
  grants, shared context, private approver routing, and collaborative history;
- dynamic policy/profile/workspace/provider administration and management UI;
- service principals, unattended producers, schedules, triggers, and
  subscriptions.

### Agent and provider breadth

- persistent or resumable Pi workers, exact live reconciliation, worker
  handoff, and automatic recovery of in-progress agent state;
- shell/process tools, model-controlled network access, arbitrary mounts,
  user-supplied MCP servers, extensions, packages, hot reload, and ambient
  resource discovery;
- interactive approvals, structured/free-form input, persistent approval
  choices, and background extension inference;
- multiple providers, models, reasoning profiles, user-managed credentials,
  model switching, agent-selected models, and provider fallback;
- PTY, ACP, non-Pi drivers, remote agents, and alternative sandbox engines.

### Input, delivery, and product surfaces

- production image/attachment submission, outbound media, automatic path
  discovery, and rich message formatting;
- live event streaming, attached response delivery, push notifications,
  delivery retries/expiry, and chat/IM/HTTP connectors;
- queued Turn editing/replacement, session fork/reconfiguration, and v1 data
  migration or connector parity.

### Reliability, scale, and assurance breadth

- high availability, horizontal scaling, SQLite replication, multi-host worker
  scheduling, zero-downtime migration, and public-service abuse/DDoS controls;
- configurable quotas, billing, cost guarantees, usage dashboards, and
  installation-wide fairness beyond fixed ceilings;
- automatic provider retries, heuristic prompt replay, and availability-first
  recovery after uncertain external writes;
- exhaustive crash injection at every boundary, fuzz/property campaigns,
  long-running soak/load tests, multiple operating systems, and the complete
  original 21-scenario V2-015 matrix.

Deferred testing breadth does not weaken the required security verification in
this document. Any deferred feature remains rejected, not dormant or partially
reachable, until its own contract and tests are accepted.

## MVP completion gate

The private multi-user agentic MVP is complete only when:

- at least two certificate-bound principals operate in one canonical Hitch
  installation and cannot cross identity, session, Turn, workspace, result, or
  runtime boundaries;
- each principal can submit a text Turn that runs the constrained Pi agent in
  a fresh denied-network Bubblewrap sandbox against only that principal's
  workspace;
- the worker uses one verified credential-isolated sidecar invocation and the
  owner can retrieve the durable terminal result after disconnect;
- revocation, capacity denial, cancellation, uncertain submission, restart,
  and complete worker cleanup pass the focused deterministic tests;
- production startup is fail-closed unless mTLS, schema identity, artifacts,
  egress, workspace, credential, and resource-limit configuration are exact;
  and
- the repository is clean, all required work is reviewed and committed, the
  existing suite remains green, and the private-alpha operator guide matches
  the executable configuration.

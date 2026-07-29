# Hitch v2 deferred design

Date: 2026-07-24

Status: preserved design considerations; not part of the v2.0 executable
contract.

This document keeps decisions that may be useful after the first private
vertical slice. The broader compile-only model may describe some of their
discriminants, but first-slice codecs, adapters, services, and repositories
must reject them until their authorization, persistence, and recovery behavior
has been tested end to end.

## Shared endpoint bindings

Ingress may identify an endpoint as `shared`, but v2.0 cannot bind it to a
session. Enabling shared bindings requires a separately reviewed authority and
lifecycle model covering membership changes, sender identity, context retention,
rate limiting, approvals, and delivery.

The current design direction remains:

- Chat membership, message visibility, and an @mention never grant Hitch
  authority.
- Each sender must resolve to an active Hitch principal and independently hold
  session authority.
- An endpoint-scoped participant grant may eventually permit prompting through
  one exact shared binding without granting private history, control, approval,
  or binding management.
- Audience policy may be owner-only, all already-authorized principals, or an
  allowlist that only narrows already-authorized principals.
- Interaction may respond to every authorized message, retain bounded authorized
  context until an activation signal, or ignore all non-activating messages.
- Activation signals may include direct mention, reply to the agent, or an
  explicit command.
- Context must be bounded by message count, age, characters, and attachment
  policy. Every retained contribution keeps its authenticated principal,
  connector message ID, and timestamp.
- The triggering principal is the sole requester. Context contributors lend no
  authority to the Turn.
- Response routing may target the same endpoint, origin thread, triggering
  message, or the originator's private endpoint when supported and authorized.
- Automated senders default to ignored. Per-sender and per-binding activation
  rates and queue depth are bounded.
- Binding policy is snapshotted for each admitted Turn. Revocation or a policy
  change before dispatch cancels queued work; active revocation fails closed.
- Approvals should be resolved through a private approver endpoint rather than
  exposing sensitive approval context to a group.

Safe defaults, if this feature is promoted, are already-authorized principals,
mention-only activation, thread/reply delivery when supported, no automated
senders, no proactive delivery, and conservative rate and queue limits.

## Same-position queued-turn replacement

V2.0 edits queued work by cancelling the immutable Turn and submitting a new
Turn at the FIFO tail. A future product may require editing an owned queued Turn
without losing its position.

That semantic requires a stable queue slot rather than a mutable Turn:

1. The slot has a session-local FIFO ordinal, a revision, a state, and a
   `currentTurnId`.
2. Replacement compares the expected slot revision, queued state, and exact
   current Turn ID in one transaction.
3. The old Turn becomes terminal as superseded; it is never mutated.
4. A new Turn and input snapshot are created and fully reauthorized in the same
   transaction.
5. The slot points to the new Turn while retaining its ordinal.
6. A queue-operation idempotency key prevents a retried replacement from
   creating multiple Turns.

Without all three preconditions, a delayed request could replace or cancel a
different Turn after the slot changed. This machinery should return only when
same-position replacement is a validated requirement.

No principal may replace another principal's Turn. Operators and owners cancel
it and submit new work under their own identity.

## Richer timing and health policy

The v2.0 policy exposes the v1-style dynamic active-work budget and interaction
wait. Runtime telemetry should determine whether later policy revisions need:

- a non-extendable absolute wall-clock cap
- agent-progress stall detection
- per-tool stall detection
- a configurable cancellation grace period
- different approval and structured-input deadlines

Until then, stall detection and bounded cancellation cleanup are installation or
supervisor safeguards rather than per-session configuration.

## Event storage evolution

V2.0 derives storage behavior from event payload kind at the persistence
boundary. If different retention backends later need it, the derived classes are:

- transient: message chunks and raw progress
- checkpoint: current plan, active sanitized tool status, and incremental usage
- durable: state transitions, acceptance evidence, immutable inference
  resolution, finalized messages and tool status, interactions, final usage,
  and terminal results

The classification must remain exhaustive and caller-independent. A future
storage API may expose separate typed write methods, but an adapter or driver
must never choose to persist raw reasoning or unsanitized tool input/output.

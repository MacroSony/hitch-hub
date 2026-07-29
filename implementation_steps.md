# V1 maintenance and rollout

Status: frozen maintenance baseline

This file contains only the remaining v1 maintenance and attended-rollout
work. Completed implementation and verification history lives in
[docs/completed-work.md](docs/completed-work.md). The original v1 roadmap lives
in [docs/security-sandbox-automation-roadmap.md](docs/security-sandbox-automation-roadmap.md).

V2 implementation status and ordering live in
[docs/v2-status.md](docs/v2-status.md). See the
[documentation map](docs/README.md) for the role and precedence of every
planning document.

## Maintenance boundary

V1 remains the only executable user-facing Hitch system, but it is not the
target for new architecture:

- Fix regressions, security defects, dependency incompatibilities, and
  operational failures.
- Preserve the existing Telegram, WeChat, Pi RPC, session, approval, media,
  delivery, audit, and sandbox behavior.
- Do not add the superseded unified-dispatch service, triggers, schedules,
  channels, backends, shared sessions, or other product expansion.
- Keep explicit direct execution classified as unsafe configuration-only mode.
- Keep group-shared sessions disabled.

## Repository security boundary

The implemented v1 default remote policy requires Linux Bubblewrap, confines
filesystem access to the selected workspace and explicit mounts, removes
model-facing shell/process access by default, and uses an allowlisted worker
environment.

Required Pi credential isolation further restricts the worker to guarded
workspace file tools plus optional native `hitch_send_media`. Provider
credentials still exist in the trusted Pi controller/config boundary; this is
model-tool confinement, not the v2 provider-broker guarantee.

The repository supports more than one configuration profile. An ignored live
configuration is not evidence in Git, so documentation must not state its
current credential-isolation setting without verifying the deployment host.

## Remaining attended rollout

- [ ] Verify the current systemd-managed deployment configuration on the host
  before relying on earlier rollout notes.
- [ ] Create a fresh chat-originated session under the verified restricted
  profile.
- [ ] Exercise ordinary prompt/final delivery, workspace create/read/edit/list,
  blocked outside-path and symlink reads, and native media delivery.
- [ ] Exercise chat-originated abort, worker restart, idle eviction, and
  post-restart fresh-session behavior.
- [ ] Record the tested Hitch commit, Pi version, configuration profile, and
  timestamp as a new dated verification snapshot.

The last repository-recorded restricted-provider check exercised workspace
create/read/edit/list, rejected `/agent-config` and a symlink escape, delivered
an immutable media snapshot, and cleaned its fixture. The 2026-07-19 rollout
note also recorded successful systemd restart after a deliberate main-process
kill. These are historical observations, not proof of current live state.

## Before adding a second principal

- [ ] Use `config_scope: hitch`.
- [ ] Keep `credential_isolation: required`.
- [ ] Provision a distinct, scoped, revocable provider identity for each
  principal out of band.
- [ ] Create fresh sessions; do not reuse the system Pi config or old
  transcripts across principals.
- [ ] Repeat route, mount, credential, media, cancellation, and restart
  isolation tests for both principals.

A shared provider credential is acceptable only as an explicitly acknowledged
single-principal attended boundary. Do not claim worker credential isolation,
enable unattended execution, or enable shared sessions from that profile.

## Verification

Repository verification is:

```sh
npm run check
```

Real provider and live channel checks remain opt-in because they require local
credentials, may consume quota, and can affect a running deployment.

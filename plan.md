# Lightweight Remote Coding Agent Hub — Project Plan

## 1. Project Goal

Build a lightweight, self-hosted, chat-native control plane for local coding agents.

The hub should let a user control agents such as Pi, Claude Code, Codex, OpenCode, Gemini CLI, or generic shell/PTY agents from IM apps such as Telegram, Discord, WeChat, QQ, and later Feishu/Lark.

The key differentiator is **not** to become another full dashboard, IDE, worktree manager, orchestration platform, or Electron app. The project should stay small while making the hard remote-control pieces first-class:

- Per-chat / per-thread sessions
- Real cwd / workspace binding by spawning or attaching to workers
- Rich attachments and artifact delivery
- Image input and output
- Approval prompts
- Native agent command pass-through
- Lightweight local deployment
- Backend-agnostic agent interface

## 2. Positioning

### One-line positioning

A lightweight, safe, chat-native control plane for local coding agents, with normalized sessions, media, artifacts, and approvals.

### Differentiation

Existing tools cover parts of this space:

- Multi-agent dashboards: Agent of Empires, CliDeck, Agent Deck
- Terminal/tmux remote bridges: CCGram
- IM-specific bridges: TelePi, Claude-to-IM Skill
- Agent backend abstraction: Sandbox Agent, Claw Orchestrator
- General assistant gateways: OpenClaw, Onlyne-style brokers

The intended gap:

- Small daemon, not a full UI platform
- Multi-IM, not Telegram-only
- Multi-agent, not Claude/Codex-only
- Structured media/artifacts/approvals, not just terminal text
- Real session/cwd ownership, not fake cwd inside a single extension
- Local-first, self-hosted, no cloud dependency by default

## 3. Core Architecture

```text
Telegram / Discord / WeChat / QQ
        ↓
Channel Adapters
        ↓
Remote Hub Core
        ↓
Session Router
        ↓
Media Manager + Approval Manager + Permission Policy
        ↓
Agent Backend Interface
        ↓
Pi RPC / Claude SDK / OpenCode Server / Codex App Server / PTY
```

## 4. Why Not Just a Pi Extension?

A Pi extension is not the right core architecture because a normal extension cannot cleanly rebind Pi's real cwd/project identity at runtime.

Pi extensions can register commands, tools, UI prompts, event handlers, and message renderers. They can be very useful as optional glue. However, full remote control needs process/session supervision outside Pi:

- Multiple remote chats/users
- Multiple cwd/workspace bindings
- Starting/stopping/resuming workers
- Real cwd ownership per worker process
- Media cache and platform tokens
- Permission policy and audit logging
- Cross-agent backend abstraction

Therefore, cwd should be treated as a property of the worker process/runtime, not as a mutable state inside one extension.

For Pi specifically, the clean path is:

```text
hub starts `pi --mode rpc` with cwd = target workspace
```

A `/cd` command should rebind the hub session to another worker or start a new worker in the requested cwd, not try to mutate Pi's cwd internally.

## 5. Core Components

### 5.1 Hub Core

Responsibilities:

- Load config
- Own event bus
- Own session registry
- Dispatch channel messages to sessions
- Dispatch agent events back to channels
- Apply permission policy
- Manage lifecycle of agent workers
- Persist audit logs
- Handle crash recovery and idle cleanup

### 5.2 Session Registry

Use SQLite for MVP.

Suggested schema concept:

```ts
type HubSession = {
  id: string;
  name?: string;

  platform: "telegram" | "discord" | "wechat" | "qq" | "feishu";
  chatId: string;
  threadId?: string;
  userId?: string;

  agent: "pi" | "claude" | "codex" | "opencode" | "gemini" | "pty";
  cwd: string;
  backendSessionId?: string;
  processId?: number;

  status: "idle" | "running" | "waiting_approval" | "error" | "stopped";

  createdAt: string;
  updatedAt: string;
};
```

Important policies:

- Default one active turn per session
- Queue or reject messages while an agent is running
- Support abort/interrupt
- Support idle timeout
- Lock cwd to prevent unsafe shared editing
- Show cwd/branch/session name in approval prompts

### 5.3 Media Manager

Responsibilities:

- Download inbound attachments
- Store local cache
- Compute SHA-256
- MIME sniffing
- Size validation
- Dedupe
- Optional image compression/conversion
- Optional OCR/transcription later
- Map media into each agent backend's supported format
- Upload outbound artifacts to chat platforms

Suggested model:

```ts
type HubAttachment = {
  id: string;
  source: "telegram" | "discord" | "wechat" | "qq" | "feishu";
  kind: "image" | "file" | "audio" | "video";
  filename?: string;
  mimeType?: string;
  size?: number;
  localPath: string;
  sha256: string;
  originalUrl?: string;
  textExtract?: string;
};
```

MVP behavior:

- Inbound image -> pass as native image input when supported
- Inbound file -> cache locally and pass safe local path reference
- Outbound image path -> send as native image/photo
- Outbound file path -> send as native document/file
- Long output -> send as text file fallback

### 5.4 Approval Manager

Normalize all agent approvals into one hub-level object.

```ts
type ApprovalRequest = {
  id: string;
  sessionId: string;
  agent: "pi" | "claude" | "codex" | "opencode" | "gemini" | "pty";
  actionKind: "shell" | "file_edit" | "network" | "mcp" | "unknown";
  cwd: string;
  title: string;
  preview: string;
  risk: "low" | "medium" | "high";
  raw: unknown;
  expiresAt?: string;
};
```

Channel rendering:

- Telegram: inline keyboard
- Discord: buttons/components
- QQ: inline keyboard when available, text fallback
- WeChat: text fallback, such as `approve <id>` / `deny <id>`

Approval decisions:

- Allow once
- Deny once
- Allow for session
- Allow for cwd/project
- Expire automatically
- Always log decision

### 5.5 Permission Policy

The hub should not rely entirely on the underlying agent approval system.

Required policy primitives:

```text
allowedRoots
readOnly / write / shell / network permissions
per-user allowlist
per-chat allowlist
per-agent permission defaults
dangerous command detection
approval expiry
audit log
```

Example config shape:

```yaml
users:
  james:
    telegram_ids: ["123456"]
    allowed_roots:
      - "~/programming"
      - "~/homelab"
    defaults:
      shell: ask
      write: ask
      network: ask

agents:
  pi:
    default_policy: ask
  codex:
    default_policy: ask
  pty:
    default_policy: restricted
```

## 6. Channel Adapter Interface

```ts
interface ChannelAdapter {
  receive(): AsyncIterable<InboundChatEvent>;

  sendText(
    target: ChatTarget,
    text: string,
    opts?: SendOptions
  ): Promise<void>;

  sendImage(
    target: ChatTarget,
    file: LocalFile,
    caption?: string
  ): Promise<void>;

  sendFile(
    target: ChatTarget,
    file: LocalFile,
    caption?: string
  ): Promise<void>;

  sendApproval(
    target: ChatTarget,
    approval: ApprovalRequest
  ): Promise<void>;

  editMessage?(
    target: ChatTarget,
    messageId: string,
    text: string
  ): Promise<void>;
}
```

### Channel capability model

```ts
type ChannelCapabilities = {
  buttons: boolean;
  selectMenu: boolean;
  fileUploadLimitMB: number;
  imageSend: boolean;
  fileSend: boolean;
  editMessage: boolean;
  threads: boolean;
};
```

## 7. Agent Backend Interface

```ts
interface AgentBackend {
  start(opts: {
    cwd: string;
    sessionId?: string;
    model?: string;
    resumeId?: string;
  }): Promise<AgentHandle>;

  send(input: {
    text: string;
    attachments?: HubAttachment[];
  }): Promise<void>;

  events(): AsyncIterable<AgentEvent>;

  approve(id: string, decision: "allow" | "deny"): Promise<void>;
  abort(): Promise<void>;
  stop(): Promise<void>;
  compact?(): Promise<void>;
  setModel?(model: string): Promise<void>;
  listNativeCommands?(): Promise<NativeCommand[]>;
}
```

### Normalized agent event model

```ts
type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "final"; text: string }
  | { type: "tool_call"; name: string; preview?: string }
  | { type: "tool_result"; name: string; text?: string; files?: FileRef[] }
  | { type: "approval_request"; approval: ApprovalRequest }
  | { type: "user_prompt"; prompt: UserPromptEvent }
  | { type: "artifact"; file: FileRef }
  | { type: "status"; state: "running" | "idle" | "waiting" | "error" };
```

### Interactive user prompt model

```ts
type UserPromptEvent = {
  id: string;
  kind: "confirm" | "select" | "input" | "question";
  title: string;
  body?: string;
  options?: string[];
};
```

## 8. Agent Backends

### 8.1 Pi RPC Backend

Priority: first backend.

Why:

- Structured JSONL RPC
- Headless mode
- Image input support
- Session operations
- Streaming events
- Extension command visibility
- Extension UI request/response support

Design:

```text
spawn `pi --mode rpc` in selected cwd
connect JSONL stdin/stdout
map Pi events into AgentEvent
map chat input into Pi prompt/follow-up
map image attachments into Pi image content
```

### 8.2 Claude Code Backend

Priority: second or third backend.

Use Claude Agent SDK rather than terminal scraping.

Capabilities:

- Long-lived sessions
- Streaming
- cwd option
- image input
- permission callbacks
- hooks
- slash commands
- skills/plugins

### 8.3 OpenCode Backend

Priority: second or third backend.

Use `opencode serve`.

Capabilities:

- Headless HTTP server
- SSE event stream
- Session endpoints
- Permission endpoints
- Diff/session/file endpoints
- Native commands/plugins loaded by OpenCode runtime

Design:

```text
spawn opencode serve per workspace/session group
connect via localhost HTTP + SSE
keep server password/token local
```

### 8.4 Codex Backend

Priority: later.

Start with two modes:

1. `codex exec --json` for simple one-shot backend
2. Codex app-server / SDK for interactive sessions

Capabilities:

- JSONL events in exec mode
- App-server JSON-RPC for rich clients
- Approvals for shell/patch operations
- Image input
- Skills/prompts/plugins/hooks

### 8.5 Generic PTY Backend

Priority: fallback.

Use for unsupported CLI agents.

Pros:

- Works with almost anything
- Easy cwd handling
- Good emergency compatibility

Cons:

- Weak structured events
- Weak approval semantics
- Poor image/artifact mapping
- Terminal scraping is brittle

Use only as a compatibility fallback, not as the main architecture.

## 9. Channel Adapters

### 9.1 Telegram

Priority: first channel.

Why:

- Easiest bot API
- Long polling works for local-first MVP
- Good file/image support
- Inline keyboards for approvals
- Topics can map to sessions

MVP support:

- Text
- Photos/images
- Documents/files
- Inline keyboard approvals
- Long output chunking
- File fallback

### 9.2 Discord

Priority: second channel.

Why:

- Good developer UX
- Buttons, slash commands, threads
- Good file/image support
- Strong session dashboard possibilities

MVP support:

- DMs or configured channels
- Mentions or slash commands
- Buttons for approvals
- Attachments
- Thread/session mapping

### 9.3 WeChat / Weixin

Priority: later, high-differentiation.

Likely implementation path:

- Use iLink / OpenClaw-style adapter if stable
- Keep behind adapter boundary
- Expect platform churn
- Text fallback for approvals
- Treat media support as platform-dependent

### 9.4 QQ

Priority: later, high-differentiation.

Likely implementation path:

- Official QQ Bot / OpenClaw-style adapter
- Support C2C first
- Group/channel later
- Buttons if available, text fallback otherwise

### 9.5 Feishu / Lark

Priority: optional.

Good enterprise adapter, but lower priority for personal remote coding.

## 10. Commands

Use two layers of commands.

### 10.1 Hub-native commands

Reserve a namespace to avoid collisions with agent-native slash commands.

Recommended forms:

```text
!new pi ~/repo
!switch api-bugfix
!sessions
!cwd
!cd ~/repo2
!status
!abort
!compact
!approve 123
!deny 123
!files
```

or:

```text
/hub new pi ~/repo
/hub switch api-bugfix
/hub approve 123
```

### 10.2 Agent-native commands

Pass through agent-native commands explicitly.

Examples:

```text
/agent /compact
/agent /model sonnet
/agent /review
/agent /prompts:draftpr FILES="src/api.ts"
```

For convenience, the hub may pass through unknown `/commands`, but this should be configurable.

### 10.3 Native command discovery

Where possible, each backend should expose native commands:

- Pi: RPC `get_commands`
- Claude: SDK session init command list
- OpenCode: config/command discovery or server metadata
- Codex: prompts/skills/plugins discovery where practical
- Gemini: later
- PTY: best effort only

## 11. Delivery Semantics

This is critical for usability.

Required behavior:

- Coalesce text deltas
- Edit previous message when platform supports it
- Chunk long output
- Send long output as `.txt` file fallback
- Dedupe repeated webhook events
- Retry with idempotency key
- Respect platform rate limits
- Track delivery state
- Provide heartbeat/status for long-running sessions
- Keep offline/backlog behavior simple and explicit

Suggested default:

```text
streaming mode:
  send small "agent started" message
  update every 1-3 seconds or significant event
  final message summarizes result
  attach files/artifacts separately
```

## 12. Security and Safety

### 12.1 Default security posture

- Bind all agent servers to localhost
- Do not expose Codex/OpenCode/Pi servers directly
- Store tokens locally
- Redact secrets in logs
- Use per-user allowlists
- Use cwd allowlists
- Ask approval for write/shell/network by default
- Keep audit logs
- Show cwd/branch/session in all approval prompts

### 12.2 Dangerous cases to handle

- User sends malicious file
- Agent tries to edit outside cwd
- Agent runs destructive shell command
- Two sessions edit same repo
- Wrong chat approves wrong session
- Bot token leaks
- IM webhook replay
- Model sends huge output
- Platform media upload fails
- Agent process crashes mid-task

## 13. Storage Layout

Example local layout:

```text
~/.remote-agent-hub/
  config.yaml
  hub.sqlite
  logs/
    hub.log
    audit.log
  media/
    inbound/
    outbound/
  sessions/
    <session-id>/
      metadata.json
      transcript.jsonl
      artifacts/
```

Per-project optional config:

```text
.repo/
  .remote-agent-hub.yaml
```

Local project config can define:

```yaml
name: my-project
allowed_agents: ["pi", "claude", "opencode"]
default_agent: pi
policy:
  shell: ask
  write: ask
  network: deny
```

## 14. MVP Scope

### MVP v0.1

Goal: prove architecture and daily usability.

Include:

- Telegram adapter
- Pi RPC backend
- SQLite session registry
- Local media cache
- One active turn per session
- Basic auth allowlist
- Cwd allowlist
- Commands:
  - `!new`
  - `!sessions`
  - `!switch`
  - `!cwd`
  - `!cd`
  - `!status`
  - `!abort`
  - `!compact`
- Inbound text -> Pi prompt
- Inbound image -> Pi image input
- Inbound file -> cached path reference
- Outbound image/file path -> Telegram upload
- Long output -> text file fallback
- Basic audit log
- Basic approval manager placeholder

### MVP v0.2

Goal: make it feel robust.

Add:

- Discord adapter
- Better delivery queue
- Message coalescing/editing
- Inline approval buttons
- User prompts / questions
- OpenCode backend
- Improved artifact discovery
- Configurable command namespace
- Crash recovery
- Idle timeout

### MVP v0.3

Goal: broaden agent support.

Add:

- Claude SDK backend
- Codex exec backend
- Codex app-server backend if stable enough
- Native command discovery
- Better permission policy
- Worktree warning/lock behavior
- Optional PTY backend

### MVP v0.4

Goal: high-differentiation platforms.

Add:

- QQ adapter
- WeChat/iLink adapter
- Text fallback approvals
- Media support validation per platform
- Better user/group permissions

## 15. Non-Goals for Early Versions

Avoid these until the core is solid:

- Full web dashboard
- Electron desktop app
- Built-in IDE/file browser
- Worktree manager
- Docker/container scheduler
- Multi-agent planner/reviewer/council
- Prompt/preset editor
- Memory/persona system
- Token/cost analytics
- Full TUI
- Cloud relay
- Public multi-user SaaS

These can be added later, but they should not define the MVP.

## 16. Suggested Tech Stack

### Option A: Node/TypeScript

Pros:

- Best IM SDK ecosystem
- Good Discord/Telegram libraries
- Good Claude SDK integration
- Easy JSON/RPC/process handling

Cons:

- Not single-binary by default
- Runtime dependency

Recommended if speed matters.

### Option B: Go

Pros:

- Single binary
- Lower memory
- Good process management
- Good SQLite support

Cons:

- Some agent SDKs may require subprocess wrappers
- IM ecosystem is fine but less ergonomic than Node

Recommended if lightweight deployment is the strongest priority.

### Option C: Rust

Pros:

- Excellent daemon/IPC quality
- Single binary
- Strong safety
- Similar spirit to Onlyne

Cons:

- Slower iteration
- Adapter libraries may be more work

Recommended later if rewriting the core for robustness.

### Practical recommendation

Start with TypeScript for speed and adapter availability. Keep internal interfaces clean enough that a Go/Rust rewrite is possible later.

## 17. Repository Structure

```text
remote-agent-hub/
  src/
    core/
      event-bus.ts
      session-registry.ts
      media-manager.ts
      approval-manager.ts
      permission-policy.ts
      delivery-queue.ts
      audit-log.ts

    channels/
      types.ts
      telegram.ts
      discord.ts
      qq.ts
      wechat.ts

    agents/
      types.ts
      pi-rpc.ts
      claude-sdk.ts
      opencode.ts
      codex-exec.ts
      codex-appserver.ts
      pty.ts

    commands/
      parser.ts
      hub-commands.ts
      agent-pass-through.ts

    config/
      load-config.ts
      schema.ts

    main.ts

  docs/
    architecture.md
    adapters.md
    security.md

  examples/
    config.example.yaml

  package.json
  README.md
```

## 18. Development Milestones

### Milestone 1: Skeleton

- Config loader
- SQLite setup
- Session model
- Command parser
- Basic Telegram bot connection

### Milestone 2: Pi RPC Worker

- Spawn Pi RPC process
- Send text prompt
- Read streaming events
- Return final output to Telegram
- Implement `!new`, `!status`, `!abort`

### Milestone 3: Media MVP

- Download Telegram image/file
- Cache locally
- Send image to Pi as image input
- Send file path reference to Pi
- Upload local output file/image back to Telegram

### Milestone 4: Session Management

- Multiple sessions
- `!sessions`
- `!switch`
- `!cwd`
- `!cd`
- Cwd allowlist
- Idle timeout

### Milestone 5: Delivery Robustness

- Chunking
- Coalescing
- Long output file fallback
- Retry/dedupe
- Audit log

### Milestone 6: Discord

- Discord adapter
- Buttons for approvals/status
- Thread/session mapping

### Milestone 7: Second Agent Backend

- OpenCode server backend or Claude SDK backend
- Normalize events
- Add backend capability model

## 19. Key Risks

### Platform risks

- WeChat/QQ APIs may be unstable or credential-heavy
- Media support differs heavily across platforms
- Discord/Telegram file limits require fallbacks

### Agent risks

- Codex app-server/SDK may evolve
- PTY fallback is brittle
- Approval semantics differ across agents
- Native commands/extensions are not universal

### Product risks

- Scope creep into dashboard/orchestrator
- Too many channels before core is stable
- Attachment pipeline becomes large
- Security policy becomes too complex

### Mitigation

- Start with Telegram + Pi RPC
- Keep strict interfaces
- Use capability flags
- Add platforms/backends gradually
- Avoid web/dashboard features early
- Treat safety/policy as core from v0.1

## 20. Open Questions

- Should the hub use `!` commands or `/hub` commands by default?
- Should `/unknown` pass through to agent by default, or require `/agent`?
- Should sessions map to chat, topic/thread, or explicit named session first?
- Should `!cd` create a new session or mutate the current session binding?
- Should inbound files be copied into workspace automatically after approval, or only referenced by cache path?
- Should worktree creation be a plugin later?
- Should Telegram local Bot API server be supported for large file mode?
- Should OpenCode or Claude SDK be the second backend?
- Should the first implementation be TypeScript or Go?

## 21. Recommended Immediate Next Step

Build a tiny proof of concept:

```text
Telegram text message
        ↓
hub
        ↓
Pi RPC process in selected cwd
        ↓
streamed Pi response
        ↓
Telegram reply
```

Then add image input before adding more backends or platforms. If Telegram + Pi RPC + images works cleanly, the architecture is validated.

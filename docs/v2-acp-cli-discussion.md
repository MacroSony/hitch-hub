# hitch v2 讨论纪要

日期：2026-07-23

---

## 一、ACP 协议定位

**Agent Client Protocol（agentclientprotocol.com）**——JSON-RPC 2.0，IDE ↔ Agent 通信标准，类似 LSP。

**结论：ACP 适合作为首选 `AgentDriver` 协议和互操作目标，不适合做整个 hitch 的底座，也不要求所有 agent 强制经过 ACP wrapper。**

| 能替代的 | 不能替代的 |
|---|---|
| Agent 通信协议（`AcpAgentDriver`） | Channel Adapters（IM/CLI 入口） |
| Agent 运行会话生命周期（new/resume/prompt/cancel） | Hitch `Session` / `SessionSpec` 领域生命周期 |
| Tool call 标准化 | Bubblewrap 沙箱 + ExecutionPolicy |
| Elicitation（权限请求/交互） | Delivery Coordinator（消息投递） |
| Slash command 发现 | Media Cache + Credential Guard |
| 多 agent 统一适配 | Audit Log + Workspace Resource 管理 |

**架构**：

```
Channel/CLI Adapters → Hub Core (Principal+Policy) → Worker Supervisor (Sandbox+Broker) → AgentDriver
                                                                                         ├→ ACP
                                                                                         ├→ Pi RPC
                                                                                         └→ PTY
```

ACP session ID 只是 agent runtime/resume handle，不能替代 Hitch 的 `SessionId` 或不可变 `SessionSpec`。ACP 权限请求、工作目录和 workspace roots 也不是授权或沙箱边界，最终决定仍由 Hitch policy、supervisor 和 credential broker 做出。建议先实现 v1 stable driver，把 v2 draft 隔离在 adapter 内。

Pi 初期保留原生 `PiRpcAgentDriver`，完整 TUI 使用 `PtyAgentDriver`。只有当 ACP wrapper 的能力、安全语义和生命周期达到等价时，才考虑移除原生 driver。

---

## 二、竞品全景

| 项目 | 定位 | 安全深度 | 与 hitch 关系 |
|---|---|---|---|
| **OpenACP** | ACP + IM bridge（三层架构） | 无 sandbox/principal | 最接近的架构，但停在"能跑" |
| **OpenClaw** (15K⭐) | 全功能 AI gateway | Docker sandbox（可选），不支持多用户 | 哲学相反：嵌入式 runtime vs 独立沙箱进程 |
| **cc-connect** | Claude Code 专属 IM 桥 | 无 | 专一但不通用 |
| **CowAgent** (20K⭐) | 多模型聊天助手 | 无 | chatbot，非 coding agent hub |
| **Lucarne** | 通知+审批+恢复 | 无 | 互补，非竞争 |

**核心发现：所有现有项目在"安全深度"轴上几乎空白。** 没有人做 Principal 模型、没有人做 Bubblewrap 强制沙箱、没有人做 Credential Guard。hitch 的护城河明确。

---

## 三、CLI 入口设计

**hitch 不只是 IM bridge，也应该是本地安全启动器。** 两种 CLI 模式：

```
hitch run pi ~/project        # PTY 透传 → 完整 Pi TUI + sandbox
hitch prompt "fix the bug"    # RPC 模式 → 结构化事件
```

### PTY 模式

- 启动 `bwrap ... pi`（默认 TUI 模式）
- 终端直接桥接给用户
- hitch 作为"带沙箱的 pi 命令"
- 代码量 ~100 行，全部复用现有 BubblewrapLauncher
- 用户得到完整 Pi TUI：`custom()`、编辑器组件、主题、快捷键

### RPC 模式

- 启动 `bwrap ... pi --mode rpc`
- 与 IM 渠道共享同一套 JSONL 事件消费逻辑
- 适用于一次性任务（`hitch prompt "fix the bug"`）
- CLI 端做简单终端渲染（text_delta → stdout，approval → stdin 交互）

### 关键认知

Pi 的 RPC 模式不支持 `custom()`、编辑器组件、主题等 TUI 专属功能——这是 Pi 的架构设计，不是 hitch 的问题。Pi 用 `ctx.mode === "tui"` 来守卫这些功能，RPC 模式下 `custom()` 直接返回 `undefined`。两个模式解决两个场景，不是 overcomplicate。

本地 CLI 也必须经过身份解析。首次安装时，service owner 的本地 peer identity 显式 bootstrap 为 installation admin；之后 daemon 通过 Unix socket peer credentials 把 OS 用户映射到 Hitch principal，并使用该 principal 的实际 grants。`hitch run` 无 daemon 的 standalone 调用可以使用仅限本次 session/workspace 的临时 owner authority，但不会自动成为持久 installation admin。

---

## 四、下一步建议

1. **先做 CLI PTY 模式**——最小成本验证 hitch 作为"安全启动器"的价值
2. **增加 ACP AgentDriver**——先 v1，与 Pi RPC 原生 driver 并存，逐步跟进 v2
3. **CLI structured 模式**——复用统一 dispatch service，按 profile 选择 ACP 或原生 driver
4. **统一 dispatch service**——按已有 roadmap phase 5-9

优先级：PTY 模式最快出价值，ACP 集成是长期架构优化。

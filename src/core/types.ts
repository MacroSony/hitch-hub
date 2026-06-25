export type Platform = "fake" | "telegram" | "discord" | "wechat" | "qq" | "feishu";
export type AgentName = "pi" | "claude" | "codex" | "opencode" | "gemini" | "pty";
export type SessionStatus = "idle" | "running" | "waiting_approval" | "error" | "stopped";

export type ChatTarget = {
  platform: Platform;
  chatId: string;
  threadId?: string;
  userId?: string;
};

export type HubSession = {
  id: string;
  platform: Platform;
  chatId: string;
  threadId?: string;
  userId?: string;
  agent: AgentName;
  cwd: string;
  backendSessionId?: string;
  processId?: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  type: string;
  at: string;
  sessionId?: string;
  target?: ChatTarget;
  details?: Record<string, unknown>;
};

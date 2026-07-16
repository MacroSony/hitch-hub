export type Platform = "fake" | "telegram" | "discord" | "wechat" | "qq" | "feishu";
export type AgentName = "pi" | "claude" | "codex" | "opencode" | "gemini" | "pty";
export type SessionStatus = "idle" | "running" | "waiting_approval" | "waiting_input" | "error" | "stopped";
export type SessionVisibility = "private" | "chat-shared";

export type ChatTarget = {
  platform: Platform;
  chatId: string;
  threadId?: string;
  userId?: string;
};

export type HubAttachment = {
  id: string;
  source: Platform;
  kind: "image" | "file" | "audio" | "video";
  filename?: string;
  mimeType?: string;
  size?: number;
  localPath: string;
  sha256: string;
  originalId?: string;
};

export type HubSession = {
  id: string;
  ownerPrincipalId: string;
  visibility: SessionVisibility;
  name?: string;
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
  selectedAt?: string;
};

export type AuditEvent = {
  type: string;
  at: string;
  sessionId?: string;
  target?: ChatTarget;
  details?: Record<string, unknown>;
};

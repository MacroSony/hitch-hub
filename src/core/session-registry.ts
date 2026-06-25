import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentName, ChatTarget, HubSession, Platform, SessionStatus } from "./types.js";

type SessionRow = {
  id: string;
  platform: Platform;
  chat_id: string;
  thread_id: string | null;
  user_id: string | null;
  agent: AgentName;
  cwd: string;
  backend_session_id: string | null;
  process_id: number | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
};

function rowToSession(row: SessionRow): HubSession {
  return {
    id: row.id,
    platform: row.platform,
    chatId: row.chat_id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.user_id ? { userId: row.user_id } : {}),
    agent: row.agent,
    cwd: row.cwd,
    ...(row.backend_session_id ? { backendSessionId: row.backend_session_id } : {}),
    ...(row.process_id ? { processId: row.process_id } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SessionRegistry {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "hub.sqlite"));
    this.migrate();
  }

  createSession(target: ChatTarget, agent: AgentName, cwd: string): HubSession {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO hub_sessions (
          id, platform, chat_id, thread_id, user_id, agent, cwd, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        target.platform,
        target.chatId,
        target.threadId ?? null,
        target.userId ?? null,
        agent,
        cwd,
        "idle",
        now,
        now,
      );

    const session = this.getById(id);
    if (!session) {
      throw new Error(`Session was not persisted: ${id}`);
    }
    return session;
  }

  getById(id: string): HubSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM hub_sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  getActiveForTarget(target: ChatTarget): HubSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM hub_sessions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND status != 'stopped'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(target.platform, target.chatId, target.threadId ?? null) as SessionRow | undefined;

    return row ? rowToSession(row) : undefined;
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare("UPDATE hub_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  setBackendProcess(id: string, processId: number | undefined): void {
    this.db
      .prepare("UPDATE hub_sessions SET process_id = ?, updated_at = ? WHERE id = ?")
      .run(processId ?? null, new Date().toISOString(), id);
  }

  createApproval(input: {
    sessionId: string;
    agent: AgentName;
    actionKind: string;
    cwd: string;
    title: string;
    preview: string;
    risk: string;
    raw: unknown;
    expiresAt?: string;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO approval_requests (
          id, session_id, agent, action_kind, cwd, title, preview, risk, raw_json, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.agent,
        input.actionKind,
        input.cwd,
        input.title,
        input.preview,
        input.risk,
        JSON.stringify(input.raw),
        "pending",
        input.expiresAt ?? null,
        now,
        now,
      );
    return id;
  }

  updateApprovalStatus(id: string, status: "allowed" | "denied"): boolean {
    const result = this.db
      .prepare("UPDATE approval_requests SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, new Date().toISOString(), id);
    return result.changes > 0;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        backend_session_id TEXT,
        process_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hub_sessions_target
        ON hub_sessions(platform, chat_id, thread_id, updated_at);

      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        risk TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approval_requests_session
        ON approval_requests(session_id, status, created_at);
    `);
  }
}

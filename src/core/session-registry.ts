import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentName, ChatTarget, HubSession, Platform, SessionStatus } from "./types.js";

type SessionRow = {
  id: string;
  name: string | null;
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
  selected_at: string | null;
};

type ApprovalRow = {
  id: string;
  session_id: string;
  agent: AgentName;
  action_kind: string;
  cwd: string;
  title: string;
  preview: string;
  risk: string;
  raw_json: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PendingApproval = {
  id: string;
  sessionId: string;
  agent: AgentName;
  actionKind: string;
  cwd: string;
  title: string;
  preview: string;
  risk: string;
  raw: unknown;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

function rowToSession(row: SessionRow): HubSession {
  return {
    id: row.id,
    ...(row.name ? { name: row.name } : {}),
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
    ...(row.selected_at ? { selectedAt: row.selected_at } : {}),
  };
}

function rowToPendingApproval(row: ApprovalRow): PendingApproval {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    actionKind: row.action_kind,
    cwd: row.cwd,
    title: row.title,
    preview: row.preview,
    risk: row.risk,
    raw: JSON.parse(row.raw_json) as unknown,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
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

  createSession(target: ChatTarget, agent: AgentName, cwd: string, name?: string): HubSession {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO hub_sessions (
          id, name, platform, chat_id, thread_id, user_id, agent, cwd, status, created_at, updated_at, selected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name?.trim() || null,
        target.platform,
        target.chatId,
        target.threadId ?? null,
        target.userId ?? null,
        agent,
        cwd,
        "idle",
        now,
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
         ORDER BY COALESCE(selected_at, updated_at) DESC, updated_at DESC
         LIMIT 1`,
      )
      .get(target.platform, target.chatId, target.threadId ?? null) as SessionRow | undefined;

    return row ? rowToSession(row) : undefined;
  }

  listForTarget(target: ChatTarget): HubSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hub_sessions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND status != 'stopped'
         ORDER BY COALESCE(selected_at, updated_at) DESC, updated_at DESC`,
      )
      .all(target.platform, target.chatId, target.threadId ?? null) as SessionRow[];

    return rows.map(rowToSession);
  }

  findForTarget(target: ChatTarget, ref: string): HubSession | undefined {
    const trimmed = ref.trim();
    if (!trimmed) {
      return undefined;
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM hub_sessions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND status != 'stopped'
           AND (id = ? OR id LIKE ? OR name = ?)
         ORDER BY updated_at DESC
         LIMIT 2`,
      )
      .all(target.platform, target.chatId, target.threadId ?? null, trimmed, `${trimmed}%`, trimmed) as SessionRow[];

    if (rows.length > 1) {
      throw new Error(`Session reference is ambiguous: ${trimmed}`);
    }

    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  selectSession(id: string): void {
    this.db
      .prepare("UPDATE hub_sessions SET selected_at = ?, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), id);
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

  updateApprovalStatus(id: string, status: "allowed" | "denied" | "expired"): boolean {
    const result = this.db
      .prepare("UPDATE approval_requests SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, new Date().toISOString(), id);
    return result.changes > 0;
  }

  getPendingApproval(id: string): PendingApproval | undefined {
    const row = this.db
      .prepare("SELECT * FROM approval_requests WHERE id = ? AND status = 'pending'")
      .get(id) as ApprovalRow | undefined;
    if (!row) {
      return undefined;
    }

    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      this.updateApprovalStatus(id, "expired");
      return undefined;
    }

    return rowToPendingApproval(row);
  }

  countPendingApprovalsForSession(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM approval_requests
         WHERE session_id = ?
           AND status = 'pending'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(sessionId, new Date().toISOString()) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
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
        updated_at TEXT NOT NULL,
        selected_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_hub_sessions_target
        ON hub_sessions(platform, chat_id, thread_id, selected_at, updated_at);

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

    this.addColumnIfMissing("hub_sessions", "name", "TEXT");
    this.addColumnIfMissing("hub_sessions", "selected_at", "TEXT");
  }

  private addColumnIfMissing(tableName: string, columnName: string, columnType: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }
}

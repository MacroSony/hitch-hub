import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatTarget, Platform } from "./types.js";

export type DeliveryKind = "text" | "artifact";
export type DeliveryStatus = "queued" | "sending" | "sent" | "failed" | "expired";
export type DeliveryTerminalStatus = Extract<DeliveryStatus, "sent" | "failed" | "expired">;

type DeliveryRow = {
  id: string;
  kind: DeliveryKind;
  platform: Platform;
  chat_id: string;
  thread_id: string | null;
  user_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  source: string | null;
  status: DeliveryStatus;
  content_length: number | null;
  attempt_count: number;
  queued_at: string;
  attempted_at: string | null;
  terminal_at: string | null;
  expires_at: string;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
};

export type DeliveryRecord = {
  id: string;
  kind: DeliveryKind;
  target: ChatTarget;
  sessionId?: string;
  turnId?: string;
  source?: string;
  status: DeliveryStatus;
  contentLength?: number;
  attemptCount: number;
  queuedAt: string;
  attemptedAt?: string;
  terminalAt?: string;
  expiresAt: string;
  errorCode?: string;
  errorMessage?: string;
  updatedAt: string;
};

export type DeliverySummary = {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  expired: number;
  recentFailures: number;
  recentExpirations: number;
  lastQueuedAt?: string;
  lastSentAt?: string;
  lastFailureAt?: string;
  lastError?: string;
};

export class DeliveryStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "hub.sqlite"));
    this.migrate();
  }

  create(input: {
    id: string;
    kind: DeliveryKind;
    target: ChatTarget;
    sessionId?: string;
    turnId?: string;
    source?: string;
    contentLength?: number;
    queuedAt: string;
    expiresAt: string;
  }): DeliveryRecord {
    this.db
      .prepare(
        `INSERT INTO outbound_deliveries (
          id, kind, platform, chat_id, thread_id, user_id, session_id, turn_id, source, status,
          content_length, attempt_count, queued_at, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.target.platform,
        input.target.chatId,
        input.target.threadId ?? null,
        input.target.userId ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.source ?? null,
        input.contentLength ?? null,
        input.queuedAt,
        input.expiresAt,
        input.queuedAt,
      );

    const record = this.get(input.id);
    if (!record) {
      throw new Error(`Delivery was not persisted: ${input.id}`);
    }
    return record;
  }

  get(id: string): DeliveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM outbound_deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
    return row ? rowToDelivery(row) : undefined;
  }

  markSending(id: string, attemptedAt: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbound_deliveries
         SET status = 'sending', attempted_at = ?, attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(attemptedAt, attemptedAt, id);
    return result.changes === 1;
  }

  markTerminal(
    id: string,
    status: DeliveryTerminalStatus,
    terminalAt: string,
    error?: { code: string; message: string },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbound_deliveries
         SET status = ?, terminal_at = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'sending')`,
      )
      .run(
        status,
        terminalAt,
        error?.code ?? null,
        error ? sanitizeError(error.message) : null,
        terminalAt,
        id,
      );
    return result.changes === 1;
  }

  expireQueuedIfDue(id: string, now: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbound_deliveries
         SET status = 'expired', terminal_at = ?, error_code = 'queue_expired',
             error_message = 'Delivery expired before its send attempt started', updated_at = ?
         WHERE id = ? AND status = 'queued' AND expires_at <= ?`,
      )
      .run(now, now, id, now);
    return result.changes === 1;
  }

  recoverInterrupted(now = new Date().toISOString()): number {
    const result = this.db
      .prepare(
        `UPDATE outbound_deliveries
         SET status = 'expired', terminal_at = ?, error_code = 'interrupted_restart',
             error_message = 'Hub restarted before delivery reached a terminal state', updated_at = ?
         WHERE status IN ('queued', 'sending')`,
      )
      .run(now, now);
    return Number(result.changes);
  }

  pruneTerminal(retentionMs: number, nowMs = Date.now()): number {
    if (retentionMs <= 0) {
      return 0;
    }
    const cutoff = new Date(nowMs - retentionMs).toISOString();
    const result = this.db
      .prepare(
        `DELETE FROM outbound_deliveries
         WHERE status IN ('sent', 'failed', 'expired') AND terminal_at < ?`,
      )
      .run(cutoff);
    return Number(result.changes);
  }

  summary(target: ChatTarget, recentWindowMs = 24 * 60 * 60 * 1_000): DeliverySummary {
    const recentCutoff = new Date(Date.now() - recentWindowMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
           SUM(CASE WHEN status = 'failed' AND terminal_at >= ? THEN 1 ELSE 0 END) AS recent_failures,
           SUM(CASE WHEN status = 'expired' AND terminal_at >= ? THEN 1 ELSE 0 END) AS recent_expirations,
           MAX(queued_at) AS last_queued_at,
           MAX(CASE WHEN status = 'sent' THEN terminal_at END) AS last_sent_at,
           MAX(CASE WHEN status IN ('failed', 'expired') THEN terminal_at END) AS last_failure_at
         FROM outbound_deliveries
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND COALESCE(user_id, '') = COALESCE(?, '')`,
      )
      .get(
        recentCutoff,
        recentCutoff,
        target.platform,
        target.chatId,
        target.threadId ?? null,
        target.userId ?? null,
      ) as
      | {
          queued: number | null;
          sending: number | null;
          sent: number | null;
          failed: number | null;
          expired: number | null;
          recent_failures: number | null;
          recent_expirations: number | null;
          last_queued_at: string | null;
          last_sent_at: string | null;
          last_failure_at: string | null;
        }
      | undefined;
    const lastErrorRow = this.db
      .prepare(
        `SELECT error_message
         FROM outbound_deliveries
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND COALESCE(user_id, '') = COALESCE(?, '')
           AND status IN ('failed', 'expired')
         ORDER BY terminal_at DESC
         LIMIT 1`,
      )
      .get(target.platform, target.chatId, target.threadId ?? null, target.userId ?? null) as
      | { error_message: string | null }
      | undefined;

    return {
      queued: row?.queued ?? 0,
      sending: row?.sending ?? 0,
      sent: row?.sent ?? 0,
      failed: row?.failed ?? 0,
      expired: row?.expired ?? 0,
      recentFailures: row?.recent_failures ?? 0,
      recentExpirations: row?.recent_expirations ?? 0,
      ...(row?.last_queued_at ? { lastQueuedAt: row.last_queued_at } : {}),
      ...(row?.last_sent_at ? { lastSentAt: row.last_sent_at } : {}),
      ...(row?.last_failure_at ? { lastFailureAt: row.last_failure_at } : {}),
      ...(lastErrorRow?.error_message ? { lastError: lastErrorRow.error_message } : {}),
    };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_deliveries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'artifact')),
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        source TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'expired')),
        content_length INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        queued_at TEXT NOT NULL,
        attempted_at TEXT,
        terminal_at TEXT,
        expires_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_target
        ON outbound_deliveries(platform, chat_id, thread_id, user_id, queued_at);

      CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_status
        ON outbound_deliveries(status, expires_at, terminal_at);
    `);
  }
}

function rowToDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    kind: row.kind,
    target: {
      platform: row.platform,
      chatId: row.chat_id,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.user_id ? { userId: row.user_id } : {}),
    },
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.source ? { source: row.source } : {}),
    status: row.status,
    ...(row.content_length === null ? {} : { contentLength: row.content_length }),
    attemptCount: row.attempt_count,
    queuedAt: row.queued_at,
    ...(row.attempted_at ? { attemptedAt: row.attempted_at } : {}),
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    expiresAt: row.expires_at,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    updatedAt: row.updated_at,
  };
}

function sanitizeError(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
}

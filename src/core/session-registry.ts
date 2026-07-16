import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  executionPolicySchema,
  mountPlanSchema,
  type SessionSecurityMetadata,
} from "../security/policy.js";
import type {
  AgentName,
  ChatTarget,
  HubSession,
  Platform,
  SessionStatus,
  SessionVisibility,
} from "./types.js";

type SessionRow = {
  id: string;
  owner_principal_id: string | null;
  authorization_state: "active" | "quarantined" | null;
  visibility: SessionVisibility | null;
  name: string | null;
  platform: Platform;
  chat_id: string;
  thread_id: string | null;
  user_id: string | null;
  agent: AgentName;
  cwd: string;
  state_path: string | null;
  execution_policy_json: string | null;
  mount_plan_json: string | null;
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

type PendingInteractionRow = {
  id: string;
  owner_principal_id: string | null;
  platform: Platform;
  chat_id: string;
  thread_id: string | null;
  user_id: string | null;
  session_id: string | null;
  owner: "hub" | "agent";
  kind: string;
  title: string;
  options_json: string;
  page_index: number;
  page_size: number;
  expires_at: string;
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

export type PendingInteractionOption = {
  label: string;
  description?: string;
  value: unknown;
};

export type PendingInteraction = {
  id: string;
  ownerPrincipalId: string;
  target: ChatTarget;
  sessionId?: string;
  owner: "hub" | "agent";
  kind: string;
  title: string;
  options: PendingInteractionOption[];
  pageIndex: number;
  pageSize: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function rowToSession(row: SessionRow): HubSession | undefined {
  if (!row.owner_principal_id || row.authorization_state !== "active") {
    return undefined;
  }
  const security = securityMetadataFromRow(row);
  if (!security) {
    return undefined;
  }
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    visibility: row.visibility === "chat-shared" ? "chat-shared" : "private",
    ...(row.name ? { name: row.name } : {}),
    platform: row.platform,
    chatId: row.chat_id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.user_id ? { userId: row.user_id } : {}),
    agent: row.agent,
    cwd: row.cwd,
    statePath: security.statePath,
    executionPolicy: security.executionPolicy,
    mountPlan: security.mountPlan,
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

function rowToPendingInteraction(row: PendingInteractionRow): PendingInteraction | undefined {
  if (!row.owner_principal_id) {
    return undefined;
  }
  return {
    id: row.id,
    ownerPrincipalId: row.owner_principal_id,
    target: {
      platform: row.platform,
      chatId: row.chat_id,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.user_id ? { userId: row.user_id } : {}),
    },
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    owner: row.owner,
    kind: row.kind,
    title: row.title,
    options: JSON.parse(row.options_json) as PendingInteractionOption[],
    pageIndex: row.page_index,
    pageSize: row.page_size,
    expiresAt: row.expires_at,
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

  createSession(
    target: ChatTarget,
    ownerPrincipalId: string,
    agent: AgentName,
    cwd: string,
    initializeSecurity: (sessionId: string) => SessionSecurityMetadata,
    name?: string,
  ): HubSession {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const security = initializeSecurity(id);
    if (
      security.mountPlan.sessionId !== id ||
      security.mountPlan.principalId !== ownerPrincipalId ||
      security.mountPlan.workspacePath !== cwd ||
      security.mountPlan.statePath !== security.statePath
    ) {
      throw new Error(`Session security metadata does not match the new session: ${id}`);
    }
    this.db
      .prepare(
        `INSERT INTO hub_sessions (
          id, owner_principal_id, visibility, name, platform, chat_id, thread_id, user_id, agent, cwd,
          state_path, execution_policy_json, mount_plan_json, backend_session_id, status,
          created_at, updated_at, selected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ownerPrincipalId,
        "private",
        name?.trim() || null,
        target.platform,
        target.chatId,
        target.threadId ?? null,
        target.userId ?? null,
        agent,
        cwd,
        security.statePath,
        JSON.stringify(security.executionPolicy),
        JSON.stringify(security.mountPlan),
        id,
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

  getActiveForTarget(target: ChatTarget, ownerPrincipalId: string): HubSession | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM hub_sessions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND owner_principal_id = ?
           AND authorization_state = 'active'
           AND status != 'stopped'
         ORDER BY COALESCE(selected_at, updated_at) DESC, updated_at DESC
         LIMIT 1`,
      )
      .get(target.platform, target.chatId, target.threadId ?? null, ownerPrincipalId) as SessionRow | undefined;

    return row ? rowToSession(row) : undefined;
  }

  listForTarget(target: ChatTarget, ownerPrincipalId: string): HubSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM hub_sessions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND owner_principal_id = ?
           AND authorization_state = 'active'
           AND status != 'stopped'
         ORDER BY COALESCE(selected_at, updated_at) DESC, updated_at DESC`,
      )
      .all(target.platform, target.chatId, target.threadId ?? null, ownerPrincipalId) as SessionRow[];

    return rows.flatMap((row) => {
      const session = rowToSession(row);
      return session ? [session] : [];
    });
  }

  findForTarget(target: ChatTarget, ownerPrincipalId: string, ref: string): HubSession | undefined {
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
           AND owner_principal_id = ?
           AND authorization_state = 'active'
           AND status != 'stopped'
           AND (id = ? OR id LIKE ? OR name = ?)
         ORDER BY updated_at DESC
         LIMIT 2`,
      )
      .all(
        target.platform,
        target.chatId,
        target.threadId ?? null,
        ownerPrincipalId,
        trimmed,
        `${trimmed}%`,
        trimmed,
      ) as SessionRow[];

    if (rows.length > 1) {
      throw new Error(`Session reference is ambiguous: ${trimmed}`);
    }

    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  selectSession(id: string, ownerPrincipalId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE hub_sessions
         SET selected_at = ?, updated_at = ?
         WHERE id = ?
           AND owner_principal_id = ?
           AND authorization_state = 'active'`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), id, ownerPrincipalId);
    return result.changes === 1;
  }

  assignLegacySessionOwners(
    resolvePrincipal: (
      target: ChatTarget,
      cwd: string,
    ) => { principalId: string; canonicalCwd: string } | undefined,
  ): number {
    const rows = this.db
      .prepare(
        "SELECT * FROM hub_sessions WHERE owner_principal_id IS NULL AND authorization_state = 'active'",
      )
      .all() as SessionRow[];
    let assigned = 0;
    const update = this.db.prepare(
      "UPDATE hub_sessions SET owner_principal_id = ?, cwd = ?, visibility = 'private', updated_at = ? WHERE id = ? AND owner_principal_id IS NULL",
    );
    for (const row of rows) {
      const resolved = resolvePrincipal(
        {
          platform: row.platform,
          chatId: row.chat_id,
          ...(row.thread_id ? { threadId: row.thread_id } : {}),
          ...(row.user_id ? { userId: row.user_id } : {}),
        },
        row.cwd,
      );
      if (!resolved) {
        continue;
      }
      assigned += Number(
        update
          .run(resolved.principalId, resolved.canonicalCwd, new Date().toISOString(), row.id)
          .changes,
      );
    }
    return assigned;
  }

  reconcileOwnedSessionCwds(
    resolveCanonicalCwd: (ownerPrincipalId: string, cwd: string) => string | undefined,
  ): { canonicalized: number; madeInaccessible: number } {
    const rows = this.db
      .prepare(
        "SELECT * FROM hub_sessions WHERE owner_principal_id IS NOT NULL AND authorization_state = 'active'",
      )
      .all() as SessionRow[];
    const updateCwd = this.db.prepare(
      "UPDATE hub_sessions SET cwd = ?, updated_at = ? WHERE id = ? AND owner_principal_id = ?",
    );
    const quarantine = this.db.prepare(
      `UPDATE hub_sessions
       SET authorization_state = 'quarantined', status = 'stopped', process_id = NULL,
           visibility = 'private', updated_at = ?
       WHERE id = ? AND owner_principal_id = ? AND authorization_state = 'active'`,
    );
    let canonicalized = 0;
    let madeInaccessible = 0;
    for (const row of rows) {
      const ownerPrincipalId = row.owner_principal_id;
      if (!ownerPrincipalId) {
        continue;
      }
      const canonicalCwd = resolveCanonicalCwd(ownerPrincipalId, row.cwd);
      if (!canonicalCwd) {
        madeInaccessible += Number(quarantine.run(new Date().toISOString(), row.id, ownerPrincipalId).changes);
        continue;
      }
      if (canonicalCwd !== row.cwd) {
        canonicalized += Number(
          updateCwd.run(canonicalCwd, new Date().toISOString(), row.id, ownerPrincipalId).changes,
        );
      }
    }
    return { canonicalized, madeInaccessible };
  }

  reconcileSessionSecurityMetadata(
    resolveMetadata: (
      sessionId: string,
      ownerPrincipalId: string,
      cwd: string,
      existing: SessionSecurityMetadata | undefined,
    ) => SessionSecurityMetadata | undefined,
  ): { initialized: number; quarantined: number } {
    const rows = this.db
      .prepare(
        "SELECT * FROM hub_sessions WHERE owner_principal_id IS NOT NULL AND authorization_state = 'active'",
      )
      .all() as SessionRow[];
    const initialize = this.db.prepare(
      `UPDATE hub_sessions
       SET state_path = ?, execution_policy_json = ?, mount_plan_json = ?, updated_at = ?
       WHERE id = ?
         AND owner_principal_id = ?
         AND state_path IS NULL
         AND execution_policy_json IS NULL
         AND mount_plan_json IS NULL
         AND authorization_state = 'active'`,
    );
    const quarantine = this.db.prepare(
      `UPDATE hub_sessions
       SET authorization_state = 'quarantined', status = 'stopped', process_id = NULL,
           visibility = 'private', updated_at = ?
       WHERE id = ? AND owner_principal_id = ? AND authorization_state = 'active'`,
    );
    let initialized = 0;
    let quarantined = 0;
    for (const row of rows) {
      const ownerPrincipalId = row.owner_principal_id;
      if (!ownerPrincipalId) {
        continue;
      }
      const existing = securityMetadataFromRow(row);
      const hasNoMetadata =
        row.state_path === null && row.execution_policy_json === null && row.mount_plan_json === null;
      let expected: SessionSecurityMetadata | undefined;
      try {
        expected = resolveMetadata(row.id, ownerPrincipalId, row.cwd, existing);
      } catch {
        expected = undefined;
      }
      if (!expected) {
        quarantined += Number(quarantine.run(new Date().toISOString(), row.id, ownerPrincipalId).changes);
        continue;
      }
      if (hasNoMetadata) {
        initialized += Number(
          initialize
            .run(
              expected.statePath,
              JSON.stringify(expected.executionPolicy),
              JSON.stringify(expected.mountPlan),
              new Date().toISOString(),
              row.id,
              ownerPrincipalId,
            )
            .changes,
        );
        continue;
      }
      if (!existing || !sameSecurityMetadata(existing, expected)) {
        quarantined += Number(quarantine.run(new Date().toISOString(), row.id, ownerPrincipalId).changes);
      }
    }
    return { initialized, quarantined };
  }

  migrateSystemAgentConfigMounts(agentConfigRoot: string): number {
    const canonicalAgentConfigRoot = path.resolve(agentConfigRoot);
    const rows = this.db
      .prepare(
        "SELECT * FROM hub_sessions WHERE owner_principal_id IS NOT NULL AND authorization_state = 'active'",
      )
      .all() as SessionRow[];
    const update = this.db.prepare(
      `UPDATE hub_sessions
       SET mount_plan_json = ?, updated_at = ?
       WHERE id = ? AND owner_principal_id = ? AND mount_plan_json = ? AND authorization_state = 'active'`,
    );
    let migrated = 0;
    for (const row of rows) {
      const metadata = securityMetadataFromRow(row);
      if (!metadata || !row.owner_principal_id || !row.mount_plan_json) {
        continue;
      }
      const agentConfigMounts = metadata.mountPlan.mounts.filter(
        (mount) => mount.purpose === "agent-config" && mount.sandboxPath === "/agent-config",
      );
      const [agentConfigMount] = agentConfigMounts;
      if (
        agentConfigMounts.length !== 1 ||
        !agentConfigMount ||
        agentConfigMount.mode !== "ro" ||
        path.resolve(agentConfigMount.hostPath) !== canonicalAgentConfigRoot
      ) {
        continue;
      }
      const mountPlan = mountPlanSchema.parse({
        ...metadata.mountPlan,
        mounts: metadata.mountPlan.mounts.map((mount) =>
          mount === agentConfigMount ? { ...mount, mode: "rw" as const } : mount,
        ),
      });
      migrated += Number(
        update.run(
          JSON.stringify(mountPlan),
          new Date().toISOString(),
          row.id,
          row.owner_principal_id,
          row.mount_plan_json,
        ).changes,
      );
    }
    return migrated;
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

  recoverInterruptedSessions(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE hub_sessions SET status = 'idle', process_id = NULL, updated_at = ? WHERE status IN ('running', 'waiting_approval', 'waiting_input')",
      )
      .run(now);
    // Backend PIDs belong to the previous hub process and are never reusable,
    // including for sessions that happened to persist as idle or error.
    this.db.prepare("UPDATE hub_sessions SET process_id = NULL WHERE process_id IS NOT NULL").run();
    this.db
      .prepare("UPDATE approval_requests SET status = 'expired', updated_at = ? WHERE status = 'pending'")
      .run(now);
  }

  close(): void {
    this.db.close();
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

  createPendingInteraction(
    target: ChatTarget,
    input: {
      ownerPrincipalId: string;
      owner: "hub" | "agent";
      kind: string;
      title: string;
      options: PendingInteractionOption[];
      sessionId?: string;
      pageSize?: number;
      expiresAt: string;
    },
  ): PendingInteraction {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.deletePendingInteractionForTarget(target, input.ownerPrincipalId);
    this.db
      .prepare(
        `INSERT INTO pending_interactions (
          id, owner_principal_id, platform, chat_id, thread_id, user_id, session_id, owner, kind, title,
          options_json, page_index, page_size, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerPrincipalId,
        target.platform,
        target.chatId,
        target.threadId ?? null,
        target.userId ?? null,
        input.sessionId ?? null,
        input.owner,
        input.kind,
        input.title,
        JSON.stringify(input.options),
        0,
        Math.max(1, Math.min(input.pageSize ?? 10, 10)),
        input.expiresAt,
        now,
        now,
      );

    const interaction = this.getPendingInteractionById(id);
    if (!interaction) {
      throw new Error(`Pending interaction was not persisted: ${id}`);
    }
    return interaction;
  }

  getPendingInteractionForTarget(target: ChatTarget, ownerPrincipalId: string): PendingInteraction | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM pending_interactions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND owner_principal_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(
        target.platform,
        target.chatId,
        target.threadId ?? null,
        ownerPrincipalId,
      ) as PendingInteractionRow | undefined;
    return row ? this.activeInteractionFromRow(row) : undefined;
  }

  updatePendingInteractionPage(id: string, ownerPrincipalId: string, pageIndex: number): PendingInteraction | undefined {
    this.db
      .prepare(
        "UPDATE pending_interactions SET page_index = ?, updated_at = ? WHERE id = ? AND owner_principal_id = ?",
      )
      .run(pageIndex, new Date().toISOString(), id, ownerPrincipalId);
    return this.getPendingInteractionById(id, ownerPrincipalId);
  }

  deletePendingInteraction(id: string, ownerPrincipalId: string): void {
    this.db
      .prepare("DELETE FROM pending_interactions WHERE id = ? AND owner_principal_id = ?")
      .run(id, ownerPrincipalId);
  }

  private deletePendingInteractionForTarget(target: ChatTarget, ownerPrincipalId: string): void {
    this.db
      .prepare(
        `DELETE FROM pending_interactions
         WHERE platform = ?
           AND chat_id = ?
           AND COALESCE(thread_id, '') = COALESCE(?, '')
           AND owner_principal_id = ?`,
      )
      .run(target.platform, target.chatId, target.threadId ?? null, ownerPrincipalId);
  }

  private getPendingInteractionById(id: string, ownerPrincipalId?: string): PendingInteraction | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM pending_interactions
         WHERE id = ?
           AND (? IS NULL OR owner_principal_id = ?)`,
      )
      .get(id, ownerPrincipalId ?? null, ownerPrincipalId ?? null) as PendingInteractionRow | undefined;
    return row ? this.activeInteractionFromRow(row) : undefined;
  }

  private activeInteractionFromRow(row: PendingInteractionRow): PendingInteraction | undefined {
    if (Date.parse(row.expires_at) <= Date.now()) {
      if (row.owner_principal_id) {
        this.deletePendingInteraction(row.id, row.owner_principal_id);
      }
      return undefined;
    }
    return rowToPendingInteraction(row);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_sessions (
        id TEXT PRIMARY KEY,
        owner_principal_id TEXT,
        authorization_state TEXT NOT NULL DEFAULT 'active' CHECK (authorization_state IN ('active', 'quarantined')),
        visibility TEXT NOT NULL DEFAULT 'private',
        name TEXT,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT,
        agent TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state_path TEXT,
        execution_policy_json TEXT,
        mount_plan_json TEXT,
        backend_session_id TEXT,
        process_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        selected_at TEXT
      );

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

      CREATE TABLE IF NOT EXISTS pending_interactions (
        id TEXT PRIMARY KEY,
        owner_principal_id TEXT,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT,
        session_id TEXT,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        options_json TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        page_size INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pending_interactions_target
        ON pending_interactions(platform, chat_id, thread_id, user_id, updated_at);
    `);

    this.addColumnIfMissing("hub_sessions", "name", "TEXT");
    this.addColumnIfMissing("hub_sessions", "selected_at", "TEXT");
    this.addColumnIfMissing("hub_sessions", "owner_principal_id", "TEXT");
    this.addColumnIfMissing("hub_sessions", "authorization_state", "TEXT NOT NULL DEFAULT 'active'");
    this.addColumnIfMissing("hub_sessions", "visibility", "TEXT NOT NULL DEFAULT 'private'");
    this.addColumnIfMissing("hub_sessions", "state_path", "TEXT");
    this.addColumnIfMissing("hub_sessions", "execution_policy_json", "TEXT");
    this.addColumnIfMissing("hub_sessions", "mount_plan_json", "TEXT");
    this.addColumnIfMissing("pending_interactions", "owner_principal_id", "TEXT");
    this.db
      .prepare(
        `UPDATE hub_sessions
         SET authorization_state = 'quarantined', status = 'stopped', process_id = NULL,
             visibility = 'private', updated_at = ?
         WHERE authorization_state IS NULL OR authorization_state NOT IN ('active', 'quarantined')`,
      )
      .run(new Date().toISOString());
    // Menus are short-lived and may contain session metadata. Old rows cannot
    // be attributed safely after an identity mapping change, so fail closed.
    this.db.prepare("DELETE FROM pending_interactions WHERE owner_principal_id IS NULL").run();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hub_sessions_principal_target
        ON hub_sessions(platform, chat_id, thread_id, owner_principal_id, selected_at, updated_at);
      CREATE INDEX IF NOT EXISTS idx_pending_interactions_principal_target_v2
        ON pending_interactions(platform, chat_id, thread_id, owner_principal_id, updated_at);
    `);
  }

  private addColumnIfMissing(tableName: string, columnName: string, columnType: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }
}

function securityMetadataFromRow(row: SessionRow): SessionSecurityMetadata | undefined {
  if (!row.state_path || !row.execution_policy_json || !row.mount_plan_json) {
    return undefined;
  }
  try {
    const executionPolicy = executionPolicySchema.parse(JSON.parse(row.execution_policy_json) as unknown);
    const mountPlan = mountPlanSchema.parse(JSON.parse(row.mount_plan_json) as unknown);
    if (
      mountPlan.sessionId !== row.id ||
      mountPlan.principalId !== row.owner_principal_id ||
      mountPlan.workspacePath !== row.cwd ||
      mountPlan.statePath !== row.state_path
    ) {
      return undefined;
    }
    return { statePath: row.state_path, executionPolicy, mountPlan };
  } catch {
    return undefined;
  }
}

function sameSecurityMetadata(left: SessionSecurityMetadata, right: SessionSecurityMetadata): boolean {
  return (
    left.statePath === right.statePath &&
    JSON.stringify(left.executionPolicy) === JSON.stringify(right.executionPolicy) &&
    JSON.stringify(left.mountPlan) === JSON.stringify(right.mountPlan)
  );
}

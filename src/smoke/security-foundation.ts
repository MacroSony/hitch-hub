import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HubConfig } from "../config/schema.js";
import { configSchema } from "../config/schema.js";
import { SessionRegistry } from "../core/session-registry.js";
import { PrincipalResolver } from "../security/authorization.js";
import { executionPolicySchema } from "../security/policy.js";

function main(): void {
  const cwd = path.resolve(".");
  const parsed = configSchema.parse({
    users: {
      alice: {
        telegram_ids: ["alice-user"],
        allowed_roots: [cwd],
        allowed_chat_ids: { telegram: ["shared-chat"] },
      },
      bob: {
        telegram_ids: ["bob-user"],
        allowed_roots: [path.dirname(cwd)],
        allowed_chat_ids: { telegram: ["shared-chat"] },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        allowed_chat_ids: ["shared-chat", "global-only"],
        unsafe_allow_all: false,
      },
    },
  });
  const config: HubConfig = {
    ...parsed,
    dataDir: path.join(cwd, "examples/.remote-agent-hub-smoke/security-foundation"),
    defaultCwd: cwd,
    allowedRoots: [cwd, path.dirname(cwd)],
    outboundRoots: [],
    principalRoots: { alice: [cwd], bob: [path.dirname(cwd)] },
  };
  const resolver = new PrincipalResolver(config);
  const alice = resolver.resolve({
    platform: "telegram",
    chatId: "shared-chat",
    userId: "alice-user",
  });
  const bob = resolver.resolve({
    platform: "telegram",
    chatId: "shared-chat",
    userId: "bob-user",
  });
  if (alice?.principal.id !== "alice" || alice.allowedRoots[0] !== cwd) {
    throw new Error(`Alice principal resolution failed: ${JSON.stringify(alice)}`);
  }
  if (bob?.principal.id !== "bob" || bob.allowedRoots[0] !== path.dirname(cwd)) {
    throw new Error(`Bob principal resolution failed: ${JSON.stringify(bob)}`);
  }
  if (resolver.resolve({ platform: "telegram", chatId: "shared-chat", userId: "mallory" })) {
    throw new Error("Unknown locked-down Telegram identity was authorized.");
  }
  if (resolver.resolve({ platform: "telegram", chatId: "global-only", userId: "alice-user" })) {
    throw new Error("Principal escaped its chat allowlist.");
  }

  const unsafeResolver = new PrincipalResolver({
    ...config,
    channels: {
      ...config.channels,
      telegram: { ...config.channels.telegram, unsafe_allow_all: true },
    },
  });
  const knownUnsafe = unsafeResolver.resolve({
    platform: "telegram",
    chatId: "other-chat",
    userId: "alice-user",
  });
  const unknownUnsafe = unsafeResolver.resolve({
    platform: "telegram",
    chatId: "other-chat",
    userId: "mallory",
  });
  const chatUnsafe = unsafeResolver.resolve({ platform: "telegram", chatId: "mallory" });
  if (
    knownUnsafe?.principal.id !== "alice" ||
    knownUnsafe.authorizationMode !== "unsafe_allow_all" ||
    !knownUnsafe.principal.capabilities.includes("unsafe_allow_all") ||
    !knownUnsafe.principal.allowedChatIds.telegram?.includes("other-chat") ||
    !unknownUnsafe?.principal.id.startsWith("__hitch_unsafe__:") ||
    unknownUnsafe.authorizationMode !== "unsafe_allow_all"
  ) {
    throw new Error("unsafe_allow_all did not preserve known principals while authorizing unknown identities.");
  }
  if (!chatUnsafe || chatUnsafe.principal.id === unknownUnsafe?.principal.id) {
    throw new Error("Unsafe user and no-user chat principals collided.");
  }

  assertRejected(
    () =>
      new PrincipalResolver({
        ...config,
        users: {
          ...config.users,
          duplicate: { telegram_ids: ["alice-user"], wechat_ids: [], allowed_roots: [cwd] },
        },
      }),
    "Ambiguous identity assignment was accepted.",
  );
  assertRejected(
    () =>
      configSchema.parse({
        users: {
          "__hitch_unsafe__:telegram:user:mallory": { allowed_roots: [cwd] },
        },
      }),
    "Reserved unsafe principal namespace was accepted in configuration.",
  );
  assertRejected(
    () =>
      new PrincipalResolver({ ...config, principalRoots: {} }).resolve({
        platform: "telegram",
        chatId: "shared-chat",
        userId: "alice-user",
      }),
    "A configured principal without resolved roots was authorized.",
  );
  assertRejected(
    () => executionPolicySchema.parse({ mounts: [{ host_path: "relative", sandbox_path: "/workspace", mode: "rw" }] }),
    "Relative policy mount was accepted.",
  );
  assertRejected(
    () =>
      executionPolicySchema.parse({
        mounts: [
          { host_path: cwd, sandbox_path: "/workspace", mode: "rw" },
          { host_path: path.dirname(cwd), sandbox_path: "/workspace", mode: "ro" },
        ],
      }),
    "Duplicate sandbox mount target was accepted.",
  );
  assertRejected(
    () => executionPolicySchema.parse({ filesystem: "host-unrestricted", sandbox: "required" }),
    "Unrestricted host policy was accepted with a required sandbox.",
  );

  verifySessionOwnership(cwd);
  verifyLegacySessionClaim(cwd);

  process.stdout.write("Security foundation smoke ok\n");
}

function verifySessionOwnership(cwd: string): void {
  const dataDir = path.join(cwd, "examples/.remote-agent-hub-smoke", `security-ownership-${process.pid}`);
  rmSync(dataDir, { force: true, recursive: true });
  const registry = new SessionRegistry(dataDir);
  const aliceTarget = { platform: "telegram" as const, chatId: "shared-chat", userId: "alice-user" };
  const bobTarget = { platform: "telegram" as const, chatId: "shared-chat", userId: "bob-user" };
  const alice = registry.createSession(aliceTarget, "alice", "pi", cwd, "alice-session");
  const bob = registry.createSession(bobTarget, "bob", "pi", cwd, "bob-session");

  if (registry.getActiveForTarget(aliceTarget, "alice")?.id !== alice.id) {
    throw new Error("Alice could not access her own private session.");
  }
  if (registry.getActiveForTarget(bobTarget, "bob")?.id !== bob.id) {
    throw new Error("Bob could not access his own private session.");
  }
  if (registry.findForTarget(bobTarget, "bob", alice.id) || registry.selectSession(alice.id, "bob")) {
    throw new Error("Bob accessed or selected Alice's private session.");
  }
  if (registry.listForTarget(aliceTarget, "alice").some((session) => session.ownerPrincipalId !== "alice")) {
    throw new Error("Alice's session list leaked another principal's session.");
  }
  const interaction = registry.createPendingInteraction(aliceTarget, {
    ownerPrincipalId: "alice",
    owner: "hub",
    kind: "hub.session.switch",
    title: "Alice sessions",
    options: [{ label: "Alice", value: { sessionId: alice.id } }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  if (registry.getPendingInteractionForTarget(aliceTarget, "bob")) {
    throw new Error("Bob could read Alice's pending interaction metadata.");
  }
  const aliceAlternateIdentity = { ...aliceTarget, userId: "alice-second-identity" };
  if (registry.getPendingInteractionForTarget(aliceAlternateIdentity, "alice")?.id !== interaction.id) {
    throw new Error("A second identity of Alice could not access Alice's pending interaction.");
  }
  if (registry.updatePendingInteractionPage(interaction.id, "bob", 1)) {
    throw new Error("Bob updated Alice's pending interaction.");
  }
  registry.deletePendingInteraction(interaction.id, "bob");
  if (!registry.getPendingInteractionForTarget(aliceTarget, "alice")) {
    throw new Error("Bob deleted Alice's pending interaction.");
  }
  registry.close();
  rmSync(dataDir, { force: true, recursive: true });
}

function verifyLegacySessionClaim(cwd: string): void {
  const dataDir = path.join(cwd, "examples/.remote-agent-hub-smoke", `security-legacy-${process.pid}`);
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "hub.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE hub_sessions (
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
  `);
  const now = new Date().toISOString();
  legacy
    .prepare(
      `INSERT INTO hub_sessions (
        id, platform, chat_id, user_id, agent, cwd, backend_session_id, status, created_at, updated_at, selected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("legacy-owned", "telegram", "shared-chat", "alice-user", "pi", cwd, "legacy-owned", "idle", now, now, now);
  legacy
    .prepare(
      `INSERT INTO hub_sessions (
        id, platform, chat_id, user_id, agent, cwd, backend_session_id, status, created_at, updated_at, selected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("legacy-unknown", "telegram", "shared-chat", "mallory", "pi", cwd, "legacy-unknown", "idle", now, now, now);
  legacy
    .prepare(
      `INSERT INTO hub_sessions (
        id, platform, chat_id, user_id, agent, cwd, backend_session_id, status, created_at, updated_at, selected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-outside-root",
      "telegram",
      "shared-chat",
      "alice-user",
      "pi",
      path.parse(cwd).root,
      "legacy-outside-root",
      "idle",
      now,
      now,
      now,
    );
  legacy.close();

  const registry = new SessionRegistry(dataDir);
  const assigned = registry.assignLegacySessionOwners((target, sessionCwd) =>
    target.platform === "telegram" && target.userId === "alice-user" && sessionCwd === cwd ? "alice" : undefined,
  );
  if (assigned !== 1 || registry.getById("legacy-owned")?.ownerPrincipalId !== "alice") {
    throw new Error("Resolvable legacy session was not privately claimed by its principal.");
  }
  if (registry.getById("legacy-unknown") !== undefined) {
    throw new Error("Unowned legacy session was exposed through direct registry lookup.");
  }
  if (registry.getById("legacy-outside-root") !== undefined) {
    throw new Error("Legacy session outside its principal's roots was revived.");
  }
  registry.close();

  const verify = new DatabaseSync(databasePath);
  const unresolved = verify
    .prepare("SELECT owner_principal_id FROM hub_sessions WHERE id = 'legacy-unknown'")
    .get() as { owner_principal_id: string | null } | undefined;
  verify.close();
  if (unresolved?.owner_principal_id !== null) {
    throw new Error("Unresolvable legacy session was assigned instead of remaining inaccessible.");
  }
  rmSync(dataDir, { force: true, recursive: true });
}

function assertRejected(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

main();

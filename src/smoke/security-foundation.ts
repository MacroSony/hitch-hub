import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import { configSchema } from "../config/schema.js";
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

  process.stdout.write("Security foundation smoke ok\n");
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

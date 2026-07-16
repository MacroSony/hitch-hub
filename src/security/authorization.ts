import type { HubConfig } from "../config/schema.js";
import type { ChatTarget, Platform } from "../core/types.js";
import { snapshotCanonicalAllowedRoots } from "../core/path-policy.js";
import {
  type AuthorizationContext,
  type Principal,
  type PrincipalIdentity,
  UNSAFE_DIRECT_EXECUTION_POLICY,
} from "./policy.js";

type ConfiguredPrincipal = HubConfig["users"][string];

export class PrincipalResolver {
  private readonly identities = new Map<string, string>();
  private readonly rootSnapshots = new Map<string, string[]>();
  private readonly unsafeRootSnapshot: string[];

  constructor(private readonly config: HubConfig) {
    this.unsafeRootSnapshot = snapshotCanonicalAllowedRoots(config.allowedRoots);
    for (const [principalId, principal] of Object.entries(config.users)) {
      const roots = config.principalRoots[principalId];
      if (!roots || roots.length === 0) {
        throw new Error(`Principal ${principalId} has no resolved allowed roots.`);
      }
      this.rootSnapshots.set(
        principalId,
        snapshotCanonicalAllowedRoots(roots, `Allowed root for principal ${principalId}`),
      );
      for (const identity of identitiesFor(principal)) {
        const key = identityKey(identity.platform, identity.userId);
        const existing = this.identities.get(key);
        if (existing && existing !== principalId) {
          throw new Error(
            `Identity ${identity.platform}:${identity.userId} is assigned to both ${existing} and ${principalId}.`,
          );
        }
        this.identities.set(key, principalId);
      }
    }
  }

  resolve(target: ChatTarget): AuthorizationContext | undefined {
    if (target.platform === "fake") {
      return this.resolveFake(target);
    }
    if (target.platform !== "telegram" && target.platform !== "wechat") {
      return undefined;
    }

    const channel = this.config.channels[target.platform];
    const principalId = target.userId
      ? this.identities.get(identityKey(target.platform, target.userId))
      : undefined;
    if (!principalId) {
      return channel.unsafe_allow_all ? this.syntheticUnsafeContext(target) : undefined;
    }

    const principalConfig = this.config.users[principalId];
    if (!principalConfig) {
      return undefined;
    }
    if (!channel.unsafe_allow_all) {
      if (!channel.allowed_chat_ids.includes(target.chatId)) {
        return undefined;
      }
      const principalChatIds = principalConfig.allowed_chat_ids?.[target.platform];
      if (principalChatIds && !principalChatIds.includes(target.chatId)) {
        return undefined;
      }
    }

    return this.contextFor(principalId, principalConfig, target, channel.unsafe_allow_all);
  }

  allowedRootsFor(principalId: string): string[] | undefined {
    if (this.config.users[principalId]) {
      return this.resolvedRootsFor(principalId);
    }
    return principalId.startsWith("__hitch_unsafe__:") ? [...this.unsafeRootSnapshot] : undefined;
  }

  private resolveFake(target: ChatTarget): AuthorizationContext | undefined {
    const configuredId = target.userId && this.config.users[target.userId] ? target.userId : undefined;
    const entries = Object.entries(this.config.users);
    const match = configuredId ? this.config.users[configuredId] : entries.length === 1 ? entries[0]?.[1] : undefined;
    const principalId = configuredId ?? (entries.length === 1 ? entries[0]?.[0] : undefined);
    if (principalId && match) {
      return this.contextFor(principalId, match, target);
    }
    return this.syntheticUnsafeContext(target);
  }

  private contextFor(
    principalId: string,
    principalConfig: ConfiguredPrincipal,
    target: ChatTarget,
    unsafeAllowAll = false,
  ): AuthorizationContext {
    const telegramChatIds = principalConfig.allowed_chat_ids?.telegram ?? this.config.channels.telegram.allowed_chat_ids;
    const wechatChatIds = principalConfig.allowed_chat_ids?.wechat ?? this.config.channels.wechat.allowed_chat_ids;
    const configuredCapabilities = principalConfig.capabilities ?? [];
    const principal: Principal = {
      id: principalId,
      identities: identitiesFor(principalConfig),
      allowedChatIds: {
        telegram:
          unsafeAllowAll && target.platform === "telegram"
            ? unique([...telegramChatIds, target.chatId])
            : telegramChatIds,
        wechat:
          unsafeAllowAll && target.platform === "wechat" ? unique([...wechatChatIds, target.chatId]) : wechatChatIds,
      },
      allowedRoots: this.resolvedRootsFor(principalId),
      capabilities: unsafeAllowAll ? unique([...configuredCapabilities, "unsafe_allow_all"]) : configuredCapabilities,
    };
    return {
      principal,
      target,
      allowedRoots: principal.allowedRoots,
      executionPolicy: this.config.agents.pi.execution_policy ?? UNSAFE_DIRECT_EXECUTION_POLICY,
      authorizationMode: unsafeAllowAll ? "unsafe_allow_all" : "configured",
    };
  }

  private syntheticUnsafeContext(target: ChatTarget): AuthorizationContext {
    const principalId = `__hitch_unsafe__:${target.platform}:${target.userId ? `user:${target.userId}` : `chat:${target.chatId}`}`;
    const principal: Principal = {
      id: principalId,
      identities: target.userId ? [{ platform: target.platform, userId: target.userId }] : [],
      allowedChatIds: { [target.platform]: [target.chatId] },
      allowedRoots: [...this.unsafeRootSnapshot],
      capabilities: ["unsafe_allow_all"],
    };
    return {
      principal,
      target,
      allowedRoots: principal.allowedRoots,
      executionPolicy: this.config.agents.pi.execution_policy ?? UNSAFE_DIRECT_EXECUTION_POLICY,
      authorizationMode: "unsafe_allow_all",
    };
  }

  private resolvedRootsFor(principalId: string): string[] {
    const roots = this.rootSnapshots.get(principalId);
    if (!roots || roots.length === 0) {
      throw new Error(`Principal ${principalId} has no resolved allowed roots.`);
    }
    return [...roots];
  }
}

function identitiesFor(principal: ConfiguredPrincipal): PrincipalIdentity[] {
  return [
    ...principal.telegram_ids.map((userId) => ({ platform: "telegram" as const, userId })),
    ...principal.wechat_ids.map((userId) => ({ platform: "wechat" as const, userId })),
  ];
}

function identityKey(platform: Platform, userId: string): string {
  return `${platform}\0${userId}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

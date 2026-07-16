import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { assertNoPiToolPolicyArguments } from "../agents/pi-policy.js";
import {
  canonicalizeAllowedRoots,
  canonicalizeExistingDirectory,
  isPathInsideAllowedRoots,
} from "../core/path-policy.js";
import { DEFAULT_REMOTE_EXECUTION_POLICY, type ExecutionPolicy } from "../security/policy.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";
import {
  assertWorkerEnvironmentAllowlist,
  assertWorkerEnvironmentCredentialNames,
} from "../security/worker-environment.js";
import { configSchema, type HubConfig, type HubConfigInput } from "./schema.js";

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function resolvePath(value: string, baseDir: string): string {
  return path.resolve(baseDir, expandHome(value));
}

export function loadConfig(configPath: string): HubConfig {
  const resolvedConfigPath = path.resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Config file not found: ${resolvedConfigPath}`);
  }

  const raw = readFileSync(resolvedConfigPath, "utf8");
  const parsed = YAML.parse(raw) as HubConfigInput;
  const config = configSchema.parse(parsed);
  assertLiveChannelAuthorization(config);
  assertPiConfigurationIsolation(config);
  assertPiCredentialIsolation(config);
  assertNoPiToolPolicyArguments(config.agents.pi.default_args);
  const channelCredentialNames = [config.channels.telegram.bot_token_env];
  assertWorkerEnvironmentCredentialNames(channelCredentialNames);
  assertWorkerEnvironmentAllowlist(config.agents.pi.env_allowlist ?? [], channelCredentialNames);
  const legacyStatePrincipal = config.agents.pi.legacy_state_principal;
  if (legacyStatePrincipal && !config.users[legacyStatePrincipal]) {
    throw new Error(`agents.pi.legacy_state_principal is not a configured principal: ${legacyStatePrincipal}`);
  }
  const configDir = path.dirname(resolvedConfigPath);
  const dataDir = resolvePath(config.data_dir, configDir);
  const piSystemConfigRoot =
    config.agents.pi.config_scope === "system"
      ? canonicalizePiSystemConfigRoot(
          resolvePath(config.agents.pi.system_config_root ?? path.join(os.homedir(), ".pi", "agent"), configDir),
        )
      : undefined;
  const piCredentialGuardSourcePath = isPiCredentialIsolationRequired(config)
    ? canonicalizeCredentialGuardPath(fileURLToPath(new URL("../../runtime/credential-guard.mjs", import.meta.url)))
    : undefined;

  const principalRoots = Object.fromEntries(
    Object.entries(config.users).map(([principalId, user]) => [
      principalId,
      canonicalizeAllowedRoots(
        user.allowed_roots.map((root) => resolvePath(root, configDir)),
        `Allowed root for principal ${principalId}`,
      ),
    ]),
  );
  const allowedRoots = Object.values(principalRoots).flat();
  if (
    piSystemConfigRoot &&
    (isPathInsideAllowedRoots(piSystemConfigRoot, allowedRoots) ||
      allowedRoots.some((root) => isPathInsideAllowedRoots(root, [piSystemConfigRoot])))
  ) {
    throw new Error("Pi system config root must not overlap any principal's allowed filesystem roots.");
  }
  const outboundRoots = canonicalizeAllowedRoots(
    config.media.outbound_roots.map((root) => resolvePath(root, configDir)),
    "Outbound media root",
  );
  const defaultCwd = config.default_cwd
    ? canonicalizeExistingDirectory(resolvePath(config.default_cwd, configDir), "Default cwd")
    : allowedRoots[0];
  const piCredentialGuardPath = piCredentialGuardSourcePath
    ? new SessionRuntimeStore(dataDir).provisionCredentialGuard(piCredentialGuardSourcePath)
    : undefined;

  return {
    ...config,
    dataDir,
    ...(defaultCwd ? { defaultCwd } : {}),
    allowedRoots,
    outboundRoots,
    principalRoots,
    ...(piSystemConfigRoot ? { piSystemConfigRoot } : {}),
    ...(piCredentialGuardPath ? { piCredentialGuardPath } : {}),
  };
}

function isPiCredentialIsolationRequired(config: ReturnType<typeof configSchema.parse>): boolean {
  return config.agents.pi.credential_isolation === "required";
}

function canonicalizeCredentialGuardPath(candidate: string): string {
  if (!existsSync(candidate)) {
    throw new Error(`Credential guard runtime is missing: ${candidate}`);
  }
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isFile()) {
    throw new Error(`Credential guard runtime is not a regular file: ${canonical}`);
  }
  return canonical;
}

const GUARDED_PI_TOOLS = new Set(["read", "write", "edit", "ls", "hitch_send_media"]);
const GUARDED_PI_FORBIDDEN_ARGUMENTS = new Set([
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--approve",
  "-a",
]);

function assertPiCredentialIsolation(config: ReturnType<typeof configSchema.parse>): void {
  if (!isPiCredentialIsolationRequired(config)) {
    return;
  }
  const policies: Array<readonly [string, ExecutionPolicy]> = [
    ["agents.pi", config.agents.pi.execution_policy ?? DEFAULT_REMOTE_EXECUTION_POLICY],
  ];
  for (const [principalId, principal] of Object.entries(config.users)) {
    if (principal.execution_policy) {
      policies.push([principalId, principal.execution_policy]);
    }
  }
  for (const [principalId, policy] of policies) {
    if (policy.sandbox !== "required") {
      throw new Error(`Credential-isolated Pi requires execution_policy.sandbox=required for ${principalId}.`);
    }
    if (policy.filesystem !== "workspace-write" && policy.filesystem !== "read-only") {
      throw new Error(`Credential-isolated Pi requires a workspace-only filesystem policy for ${principalId}.`);
    }
    if (policy.process || policy.tools.some((tool) => !GUARDED_PI_TOOLS.has(tool))) {
      throw new Error(
        `Credential-isolated Pi allows only read, write, edit, ls, and hitch_send_media tools with process=false for ${principalId}.`,
      );
    }
  }
  const forbiddenArgument = config.agents.pi.default_args.find(
    (argument) =>
      GUARDED_PI_FORBIDDEN_ARGUMENTS.has(argument) ||
      [...GUARDED_PI_FORBIDDEN_ARGUMENTS].some(
        (flag) => flag.startsWith("--") && argument.startsWith(`${flag}=`),
      ) ||
      argument.startsWith("@"),
  );
  if (forbiddenArgument) {
    throw new Error(
      `Credential-isolated Pi cannot load caller-supplied resources or secrets from default_args: ${forbiddenArgument}`,
    );
  }
}

function canonicalizePiSystemConfigRoot(candidate: string): string {
  const canonical = canonicalizeExistingDirectory(candidate, "Pi system config root");
  const forbidden = new Set([
    path.parse(canonical).root,
    path.resolve(os.homedir()),
    ...["/bin", "/dev", "/etc", "/home", "/lib", "/lib64", "/proc", "/root", "/run", "/sys", "/tmp", "/usr", "/var"]
      .filter((root) => existsSync(root))
      .map((root) => path.resolve(root)),
  ]);
  if (forbidden.has(canonical)) {
    throw new Error(`Pi system config root is too broad to mount into a worker: ${canonical}`);
  }
  try {
    accessSync(canonical, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`Pi system config root must be readable and writable by Hitch: ${canonical}`);
  }
  return canonical;
}

function assertPiConfigurationIsolation(config: ReturnType<typeof configSchema.parse>): void {
  if (config.agents.pi.config_scope !== "system") {
    return;
  }
  if (Object.keys(config.users).length !== 1) {
    throw new Error(
      "agents.pi.config_scope=system shares one Pi identity and is allowed only with one configured principal. Use config_scope=hitch for multi-user isolation.",
    );
  }
  if (
    (config.channels.telegram.enabled && config.channels.telegram.unsafe_allow_all) ||
    (config.channels.wechat.enabled && config.channels.wechat.unsafe_allow_all)
  ) {
    throw new Error(
      "agents.pi.config_scope=system cannot be combined with unsafe_allow_all. Use config_scope=hitch for isolated principals.",
    );
  }
}

function assertLiveChannelAuthorization(config: HubConfigInput): void {
  const telegram = config.channels?.telegram;
  if (telegram?.enabled && !telegram.unsafe_allow_all) {
    const allowedChatIds = telegram.allowed_chat_ids ?? [];
    const allowedUserIds = Object.values(config.users ?? {}).flatMap((user) => user.telegram_ids ?? []);
    if (allowedChatIds.length === 0 || allowedUserIds.length === 0) {
      throw new Error(
        "Telegram is enabled but not explicitly locked down. Set channels.telegram.allowed_chat_ids and at least one users.*.telegram_ids value, or set channels.telegram.unsafe_allow_all: true for local testing.",
      );
    }
  }

  const wechat = config.channels?.wechat;
  if (wechat?.enabled && !wechat.unsafe_allow_all) {
    const allowedChatIds = wechat.allowed_chat_ids ?? [];
    const allowedUserIds = Object.values(config.users ?? {}).flatMap((user) => user.wechat_ids ?? []);
    if (allowedChatIds.length === 0 || allowedUserIds.length === 0) {
      throw new Error(
        "WeChat is enabled but not explicitly locked down. Set channels.wechat.allowed_chat_ids and at least one users.*.wechat_ids value, or set channels.wechat.unsafe_allow_all: true for local testing.",
      );
    }
  }
}

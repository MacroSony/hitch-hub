import { z } from "zod";
import { executionPolicySchema } from "../security/policy.js";

const userSchema = z.object({
  telegram_ids: z.array(z.union([z.string(), z.number()]).pipe(z.coerce.string())).default([]),
  wechat_ids: z.array(z.string()).default([]),
  allowed_roots: z.array(z.string()).min(1),
  allowed_chat_ids: z
    .object({
      telegram: z.array(z.union([z.string(), z.number()]).pipe(z.coerce.string())).default([]),
      wechat: z.array(z.string()).default([]),
    })
    .optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  execution_policy: executionPolicySchema.optional(),
});

const fakeChannelSchema = z.object({
  enabled: z.boolean().default(true),
});

const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  bot_token_env: z.string().default("TELEGRAM_BOT_TOKEN"),
  allowed_chat_ids: z.array(z.union([z.string(), z.number()]).pipe(z.coerce.string())).default([]),
  unsafe_allow_all: z.boolean().default(false),
});

const wechatChannelSchema = z.object({
  enabled: z.boolean().default(false),
  allowed_chat_ids: z.array(z.string()).default([]),
  bot_type: z.string().default("3"),
  send_min_interval_ms: z.number().int().min(0).default(4_000),
  failure_cooldown_ms: z.number().int().min(0).default(60_000),
  unsafe_allow_all: z.boolean().default(false),
});

const piAgentSchema = z
  .object({
    command: z.string().default("pi"),
    default_args: z.array(z.string()).default(["--mode", "rpc"]),
    // Accepted only for configuration compatibility. ExecutionPolicy replaces
    // this formerly security-looking but unenforced field.
    default_policy: z.enum(["ask", "deny", "allow"]).optional(),
    config_scope: z.enum(["hitch", "system"]).default("hitch"),
    credential_isolation: z.enum(["required", "disabled"]).optional(),
    system_config_root: z.string().min(1).optional(),
    legacy_state_principal: z.string().min(1).optional(),
    env_allowlist: z.array(z.string()).optional(),
    execution_policy: executionPolicySchema.optional(),
  })
  .transform((config) => ({
    ...config,
    credential_isolation:
      config.credential_isolation ?? (config.config_scope === "system" ? "required" : "disabled"),
  }));

const mediaSchema = z.object({
  max_inbound_bytes: z.number().int().positive().default(20 * 1024 * 1024),
  max_outbound_bytes: z.number().int().positive().default(50 * 1024 * 1024),
  auto_discovery: z.boolean().default(false),
  outbound_roots: z.array(z.string()).default([]),
});

const deliverySchema = z.object({
  full_tool_output: z.boolean().default(false),
  tool_status_mode: z.enum(["all", "failures", "none"]).default("all"),
  tool_status_batch_ms: z.number().int().min(0).default(0),
  send_timeout_ms: z.number().int().positive().default(30_000),
  queue_ttl_ms: z.number().int().positive().default(5 * 60 * 1000),
  retention_ms: z.number().int().min(0).default(30 * 24 * 60 * 60 * 1000),
});

const auditSchema = z.object({
  max_bytes: z.number().int().positive().default(10 * 1024 * 1024),
  max_files: z.number().int().min(1).max(100).default(5),
});

export const configSchema = z.object({
  data_dir: z.string().default(".remote-agent-hub"),
  default_cwd: z.string().optional(),
  agent_turn_timeout_ms: z.number().int().positive().default(300_000),
  worker_idle_timeout_ms: z.number().int().min(0).default(30 * 60 * 1000),
  approval_timeout_ms: z.number().int().positive().default(300_000),
  media: mediaSchema.default({
    max_inbound_bytes: 20 * 1024 * 1024,
    max_outbound_bytes: 50 * 1024 * 1024,
    auto_discovery: false,
    outbound_roots: [],
  }),
  delivery: deliverySchema.default({
    full_tool_output: false,
    tool_status_mode: "all",
    tool_status_batch_ms: 0,
    send_timeout_ms: 30_000,
    queue_ttl_ms: 5 * 60 * 1000,
    retention_ms: 30 * 24 * 60 * 60 * 1000,
  }),
  audit: auditSchema.default({
    max_bytes: 10 * 1024 * 1024,
    max_files: 5,
  }),
  users: z
    .record(
      z
        .string()
        .min(1)
        .refine((value) => !value.startsWith("__hitch_unsafe__:"), "Principal ID uses a reserved Hitch prefix."),
      userSchema,
    )
    .default({}),
  channels: z
    .object({
      fake: fakeChannelSchema.default({ enabled: true }),
      telegram: telegramChannelSchema.default({
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
        unsafe_allow_all: false,
      }),
      wechat: wechatChannelSchema.default({
        enabled: false,
        allowed_chat_ids: [],
        bot_type: "3",
        send_min_interval_ms: 4_000,
        failure_cooldown_ms: 60_000,
        unsafe_allow_all: false,
      }),
    })
    .default({
      fake: { enabled: true },
      telegram: {
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
        unsafe_allow_all: false,
      },
      wechat: {
        enabled: false,
        allowed_chat_ids: [],
        bot_type: "3",
        send_min_interval_ms: 4_000,
        failure_cooldown_ms: 60_000,
        unsafe_allow_all: false,
      },
    }),
  agents: z
    .object({
      pi: piAgentSchema.default({
        command: "pi",
        default_args: ["--mode", "rpc"],
        config_scope: "hitch",
        credential_isolation: "disabled",
      }),
    })
    .default({
      pi: {
        command: "pi",
        default_args: ["--mode", "rpc"],
        config_scope: "hitch",
        credential_isolation: "disabled",
      },
    }),
});

export type HubConfigInput = z.input<typeof configSchema>;
export type HubConfig = z.output<typeof configSchema> & {
  dataDir: string;
  defaultCwd?: string;
  allowedRoots: string[];
  outboundRoots: string[];
  principalRoots: Record<string, string[]>;
  piSystemConfigRoot?: string;
  piCredentialGuardPath?: string;
};

import { z } from "zod";

const userSchema = z.object({
  telegram_ids: z.array(z.union([z.string(), z.number()]).pipe(z.coerce.string())).default([]),
  wechat_ids: z.array(z.string()).default([]),
  allowed_roots: z.array(z.string()).min(1),
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
  unsafe_allow_all: z.boolean().default(false),
});

const piAgentSchema = z.object({
  command: z.string().default("pi"),
  default_args: z.array(z.string()).default(["--mode", "rpc"]),
  default_policy: z.enum(["ask", "deny", "allow"]).default("ask"),
  config_scope: z.enum(["hitch", "system"]).default("hitch"),
});

const mediaSchema = z.object({
  max_inbound_bytes: z.number().int().positive().default(20 * 1024 * 1024),
  max_outbound_bytes: z.number().int().positive().default(50 * 1024 * 1024),
});

export const configSchema = z.object({
  data_dir: z.string().default(".remote-agent-hub"),
  default_cwd: z.string().optional(),
  agent_turn_timeout_ms: z.number().int().positive().default(300_000),
  approval_timeout_ms: z.number().int().positive().default(300_000),
  media: mediaSchema.default({
    max_inbound_bytes: 20 * 1024 * 1024,
    max_outbound_bytes: 50 * 1024 * 1024,
  }),
  users: z.record(z.string(), userSchema).default({}),
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
        unsafe_allow_all: false,
      },
    }),
  agents: z
    .object({
      pi: piAgentSchema.default({
        command: "pi",
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
        config_scope: "hitch",
      }),
    })
    .default({
      pi: {
        command: "pi",
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
        config_scope: "hitch",
      },
    }),
});

export type HubConfigInput = z.input<typeof configSchema>;
export type HubConfig = z.output<typeof configSchema> & {
  dataDir: string;
  defaultCwd?: string;
  allowedRoots: string[];
};

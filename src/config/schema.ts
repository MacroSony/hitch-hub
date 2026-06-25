import { z } from "zod";

const userSchema = z.object({
  telegram_ids: z.array(z.string()).default([]),
  allowed_roots: z.array(z.string()).min(1),
});

const fakeChannelSchema = z.object({
  enabled: z.boolean().default(true),
});

const telegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  bot_token_env: z.string().default("TELEGRAM_BOT_TOKEN"),
  allowed_chat_ids: z.array(z.string()).default([]),
});

const piAgentSchema = z.object({
  command: z.string().default("pi"),
  default_args: z.array(z.string()).default(["--mode", "rpc"]),
  default_policy: z.enum(["ask", "deny", "allow"]).default("ask"),
});

export const configSchema = z.object({
  data_dir: z.string().default(".remote-agent-hub"),
  users: z.record(z.string(), userSchema).default({}),
  channels: z
    .object({
      fake: fakeChannelSchema.default({ enabled: true }),
      telegram: telegramChannelSchema.default({
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
      }),
    })
    .default({
      fake: { enabled: true },
      telegram: {
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
      },
    }),
  agents: z
    .object({
      pi: piAgentSchema.default({
        command: "pi",
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
      }),
    })
    .default({
      pi: {
        command: "pi",
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
      },
    }),
});

export type HubConfigInput = z.input<typeof configSchema>;
export type HubConfig = z.output<typeof configSchema> & {
  dataDir: string;
  allowedRoots: string[];
};

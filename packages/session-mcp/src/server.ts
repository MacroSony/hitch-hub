#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const sendMediaResultShape = {
  deliveryId: z.string(),
  status: z.enum(["sent", "failed"]),
  platform: z.string(),
  path: z.string(),
  kind: z.enum(["image", "file"]).optional(),
  size: z.number().optional(),
  message: z.string().optional(),
};
const sendMediaResultSchema = z.object(sendMediaResultShape);
type SendMediaResult = z.infer<typeof sendMediaResultSchema>;
const MAX_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const env = readToolEnv();
const server = new McpServer({
  name: "hitch-session-mcp",
  version: "0.1.0",
});

const OUTBOUND_MEDIA_PROMPT = [
  "You are connected to Hitch, a local hub that owns outbound chat delivery.",
  "",
  "When a user asks you to generate, paint, edit, export, or otherwise produce an image or file that should be visible in the remote chat:",
  "1. Create the media file locally and wait until it exists on disk.",
  "2. Call the MCP tool `hitch.send_media` with the absolute local file path.",
  "3. Include a short caption when useful, and set `kind` to `image` for generated images.",
  "4. Report the structured delivery result truthfully to the user.",
  "",
  "Do not only mention the file path in your final message when the user expects the chat to receive the media.",
  "Do not send directly to Telegram, WeChat, or another chat provider. Hitch chooses the active chat target and enforces path policy.",
].join("\n");

server.registerTool(
  "hitch.send_media",
  {
    title: "Send media to the active Hitch chat",
    description: "Send a local image or file through the active Hitch session. The chat target is chosen by Hitch.",
    inputSchema: {
      path: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value), "Path must be absolute.").describe("Absolute local path to the media file."),
      caption: z.string().max(3900).optional().describe("Optional caption to send with the media."),
      kind: z.enum(["image", "file"]).optional().describe("Optional media kind. Hitch verifies this against detected file content."),
    },
    outputSchema: sendMediaResultShape,
  },
  async ({ path: mediaPath, caption, kind }, extra) => {
    const result = await requestSendMedia(env, {
      path: mediaPath,
      ...(caption ? { caption } : {}),
      ...(kind ? { kind } : {}),
    }, extra.signal);
    return {
      isError: result.status === "failed",
      content: [
        {
          type: "text",
          text:
            result.status === "sent"
              ? `Media sent to ${result.platform}: ${path.basename(result.path)}`
              : `Media delivery failed: ${result.message ?? "unknown error"}`,
        },
      ],
      structuredContent: result,
    };
  },
);

server.registerPrompt(
  "hitch.outbound_media",
  {
    title: "Hitch Outbound Media",
    description: "Instructions for sending generated images and files through Hitch using hitch.send_media.",
  },
  async () => ({
    description: "Use Hitch's explicit media tool when generated media should be delivered to the active remote chat.",
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: OUTBOUND_MEDIA_PROMPT,
        },
      },
    ],
  }),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

type ToolEnv = {
  token: string;
  outboxPath: string;
  resultDir: string;
  timeoutMs: number;
};

function readToolEnv(): ToolEnv {
  const token = process.env.HITCH_TOOL_TOKEN;
  const outboxPath = process.env.HITCH_TOOL_OUTBOX;
  const resultDir = process.env.HITCH_TOOL_RESULT_DIR;
  if (!token || !outboxPath || !resultDir) {
    throw new Error("Hitch MCP server requires HITCH_TOOL_TOKEN, HITCH_TOOL_OUTBOX, and HITCH_TOOL_RESULT_DIR.");
  }

  const timeoutMs = Number(process.env.HITCH_TOOL_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TOOL_TIMEOUT_MS) {
    throw new Error(`HITCH_TOOL_TIMEOUT_MS must be a positive integer no greater than ${MAX_TOOL_TIMEOUT_MS}.`);
  }

  return {
    token,
    outboxPath,
    resultDir,
    timeoutMs,
  };
}

async function requestSendMedia(
  env: ToolEnv,
  input: { path: string; caption?: string; kind?: "image" | "file" },
  signal: AbortSignal,
): Promise<SendMediaResult> {
  signal.throwIfAborted();
  mkdirSync(path.dirname(env.outboxPath), { recursive: true });
  mkdirSync(env.resultDir, { recursive: true });
  const id = randomUUID();
  appendFileSync(
    env.outboxPath,
    `${JSON.stringify({
      id,
      type: "send_media",
      token: env.token,
      ...input,
    })}\n`,
    "utf8",
  );

  const resultPath = path.join(env.resultDir, `${id}.json`);
  const deadline = Date.now() + env.timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (existsSync(resultPath)) {
      return sendMediaResultSchema.parse(JSON.parse(readFileSync(resultPath, "utf8")));
    }
    await sleep(Math.min(250, deadline - Date.now()), undefined, { signal });
  }

  return {
    deliveryId: id,
    status: "failed",
    platform: "unknown",
    path: input.path,
    message: `Timed out waiting for Hitch media delivery result after ${env.timeoutMs}ms.`,
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

type SendMediaResult = {
  deliveryId: string;
  status: "sent" | "failed";
  platform: string;
  path: string;
  kind?: "image" | "file";
  size?: number;
  message?: string;
};

const env = readToolEnv();
const server = new McpServer({
  name: "hitch-session-tools",
  version: "0.1.0",
});

server.registerTool(
  "hitch.send_media",
  {
    title: "Send media to the active Hitch chat",
    description: "Send a local image or file through the active Hitch session. The chat target is chosen by Hitch.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute local path to the media file."),
      caption: z.string().optional().describe("Optional caption to send with the media."),
      kind: z.enum(["image", "file"]).optional().describe("Optional media kind. Hitch verifies this against detected file content."),
    },
    outputSchema: {
      deliveryId: z.string(),
      status: z.enum(["sent", "failed"]),
      platform: z.string(),
      path: z.string(),
      kind: z.enum(["image", "file"]).optional(),
      size: z.number().optional(),
      message: z.string().optional(),
    },
  },
  async ({ path: mediaPath, caption, kind }) => {
    const result = await requestSendMedia(env, {
      path: mediaPath,
      ...(caption ? { caption } : {}),
      ...(kind ? { kind } : {}),
    });
    return {
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

  return {
    token,
    outboxPath,
    resultDir,
    timeoutMs: Number(process.env.HITCH_TOOL_TIMEOUT_MS ?? 300_000),
  };
}

async function requestSendMedia(env: ToolEnv, input: { path: string; caption?: string; kind?: "image" | "file" }): Promise<SendMediaResult> {
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
    if (existsSync(resultPath)) {
      return JSON.parse(readFileSync(resultPath, "utf8")) as SendMediaResult;
    }
    await sleep(250);
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

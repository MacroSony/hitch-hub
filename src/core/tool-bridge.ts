import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatTarget } from "./types.js";
import {
  type HubToolDeliveryContext,
  type HubToolService,
  type SendMediaInput,
  type SendMediaResult,
} from "./hub-tools.js";

export type AgentToolContext = {
  sessionId: string;
  token: string;
  outboxPath: string;
  resultDir: string;
};

type ToolRequest = {
  id?: unknown;
  type?: unknown;
  token?: unknown;
  path?: unknown;
  caption?: unknown;
  kind?: unknown;
};

export class AgentToolBridge {
  private readonly contexts = new Map<string, AgentToolContext>();
  private readonly cursors = new Map<string, { offset: number }>();

  constructor(private readonly dataDir: string) {}

  contextFor(sessionId: string): AgentToolContext {
    const existing = this.contexts.get(sessionId);
    if (existing) {
      return existing;
    }

    const toolDir = path.join(this.dataDir, "tools", sessionId);
    const resultDir = path.join(toolDir, "results");
    mkdirSync(resultDir, { recursive: true });
    const context: AgentToolContext = {
      sessionId,
      token: randomBytes(32).toString("hex"),
      outboxPath: path.join(toolDir, "outbox.jsonl"),
      resultDir,
    };
    this.contexts.set(sessionId, context);
    return context;
  }

  async processPending(
    context: AgentToolContext,
    target: ChatTarget,
    tools: HubToolService,
    deliveryContext: HubToolDeliveryContext = { sessionId: context.sessionId },
  ): Promise<void> {
    if (!existsSync(context.outboxPath)) {
      return;
    }

    for (const line of this.readPendingLines(context)) {
      if (!line.trim()) {
        continue;
      }

      let request: ToolRequest;
      try {
        request = JSON.parse(line) as ToolRequest;
      } catch {
        continue;
      }

      const id = typeof request.id === "string" ? request.id : undefined;
      if (!id || existsSync(this.resultPath(context, id))) {
        continue;
      }

      const result = await this.handleRequest(context, target, tools, request, id, deliveryContext);
      this.writeResult(context, id, result);
    }
  }

  private async handleRequest(
    context: AgentToolContext,
    target: ChatTarget,
    tools: HubToolService,
    request: ToolRequest,
    id: string,
    deliveryContext: HubToolDeliveryContext,
  ): Promise<SendMediaResult> {
    if (request.token !== context.token) {
      return failedToolResult(id, target, String(request.path ?? ""), "Invalid Hitch tool token.");
    }
    if (request.type !== "send_media") {
      return failedToolResult(id, target, String(request.path ?? ""), `Unsupported Hitch tool request: ${String(request.type)}`);
    }
    if (typeof request.path !== "string" || request.path.length === 0) {
      return failedToolResult(id, target, "", "send_media requires a path.");
    }

    const input: SendMediaInput = {
      path: request.path,
      ...(typeof request.caption === "string" && request.caption.length > 0 ? { caption: request.caption } : {}),
      ...(request.kind === "image" || request.kind === "file" ? { kind: request.kind } : {}),
    };
    return tools.sendMedia(target, input, { source: "agent_tool", notifyOnFailure: true, deliveryContext });
  }

  private writeResult(context: AgentToolContext, id: string, result: SendMediaResult): void {
    mkdirSync(context.resultDir, { recursive: true });
    writeFileSync(this.resultPath(context, id), `${JSON.stringify(result)}\n`, "utf8");
  }

  private resultPath(context: AgentToolContext, id: string): string {
    return path.join(context.resultDir, `${safeResultId(id)}.json`);
  }

  private readPendingLines(context: AgentToolContext): string[] {
    const cursor = this.cursors.get(context.sessionId) ?? { offset: 0 };
    const size = statSync(context.outboxPath).size;
    if (size < cursor.offset) {
      cursor.offset = 0;
    }
    if (size === cursor.offset) {
      this.cursors.set(context.sessionId, cursor);
      return [];
    }

    const length = size - cursor.offset;
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(context.outboxPath, "r");
    try {
      let bytesRead = 0;
      while (bytesRead < length) {
        const count = readSync(descriptor, buffer, bytesRead, length - bytesRead, cursor.offset + bytesRead);
        if (count === 0) {
          break;
        }
        bytesRead += count;
      }
      const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNewline < 0) {
        this.cursors.set(context.sessionId, cursor);
        return [];
      }
      cursor.offset += lastNewline + 1;
      const parts = buffer.subarray(0, lastNewline + 1).toString("utf8").split(/\r?\n/);
      parts.pop();
      this.cursors.set(context.sessionId, cursor);
      return parts;
    } finally {
      closeSync(descriptor);
    }
  }
}

function failedToolResult(id: string, target: ChatTarget, mediaPath: string, message: string): SendMediaResult {
  return {
    deliveryId: id,
    status: "failed",
    platform: target.platform,
    path: mediaPath,
    message,
  };
}

function safeResultId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

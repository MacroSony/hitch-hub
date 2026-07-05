import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatTarget } from "./types.js";
import { type HubToolService, type SendMediaInput, type SendMediaResult } from "./hub-tools.js";

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
  private readonly processed = new Map<string, Set<string>>();

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

  async processPending(context: AgentToolContext, target: ChatTarget, tools: HubToolService): Promise<void> {
    if (!existsSync(context.outboxPath)) {
      return;
    }

    const processed = this.processedFor(context.sessionId);
    const lines = readFileSync(context.outboxPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
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
      if (!id || processed.has(id)) {
        continue;
      }
      processed.add(id);

      const result = await this.handleRequest(context, target, tools, request, id);
      this.writeResult(context, id, result);
    }
  }

  private async handleRequest(
    context: AgentToolContext,
    target: ChatTarget,
    tools: HubToolService,
    request: ToolRequest,
    id: string,
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
    return tools.sendMedia(target, input, { source: "agent_tool", notifyOnFailure: true });
  }

  private writeResult(context: AgentToolContext, id: string, result: SendMediaResult): void {
    mkdirSync(context.resultDir, { recursive: true });
    writeFileSync(path.join(context.resultDir, `${safeResultId(id)}.json`), `${JSON.stringify(result)}\n`, "utf8");
  }

  private processedFor(sessionId: string): Set<string> {
    const existing = this.processed.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Set<string>();
    this.processed.set(sessionId, created);
    return created;
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

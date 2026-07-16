import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { secureSessionBridgePaths } from "../security/session-runtime.js";
import { isPathInsideAllowedRoots } from "./path-policy.js";
import type { ChatTarget, HubSession } from "./types.js";
import {
  type HubToolDeliveryContext,
  type HubToolService,
  type SendMediaInput,
  type SendMediaResult,
} from "./hub-tools.js";

export type AgentToolContext = {
  sessionId: string;
  token: string;
  statePath: string;
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

  contextFor(session: Pick<HubSession, "id" | "statePath">): AgentToolContext {
    const bridge = secureSessionBridgePaths(session.statePath);
    const existing = this.contexts.get(session.id);
    if (existing) {
      if (
        existing.statePath !== session.statePath ||
        existing.outboxPath !== bridge.outboxPath ||
        existing.resultDir !== bridge.resultDir
      ) {
        throw new Error(`Session tool bridge paths changed unexpectedly: ${session.id}`);
      }
      return existing;
    }

    const context: AgentToolContext = {
      sessionId: session.id,
      token: randomBytes(32).toString("hex"),
      statePath: session.statePath,
      outboxPath: bridge.outboxPath,
      resultDir: bridge.resultDir,
    };
    this.contexts.set(session.id, context);
    return context;
  }

  async processPending(
    context: AgentToolContext,
    target: ChatTarget,
    tools: HubToolService,
    deliveryContext: HubToolDeliveryContext = { sessionId: context.sessionId },
  ): Promise<void> {
    this.assertContextPaths(context);
    if (!existsSync(context.outboxPath)) {
      return;
    }
    assertRegularFileInside(context.outboxPath, path.dirname(context.outboxPath), "Tool outbox");

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
      if (!id || this.resultExists(context, id)) {
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
    this.assertContextPaths(context);
    const resultPath = this.resultPath(context, id);
    if (existsSync(resultPath)) {
      assertRegularFileInside(resultPath, context.resultDir, "Tool result");
    }
    const descriptor = openSync(
      resultPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag(),
      0o600,
    );
    try {
      writeSync(descriptor, `${JSON.stringify(result)}\n`, undefined, "utf8");
    } finally {
      closeSync(descriptor);
    }
  }

  private resultPath(context: AgentToolContext, id: string): string {
    return path.join(context.resultDir, `${safeResultId(id)}.json`);
  }

  private readPendingLines(context: AgentToolContext): string[] {
    const cursor = this.cursors.get(context.sessionId) ?? { offset: 0 };
    const descriptor = openSync(context.outboxPath, constants.O_RDONLY | noFollowFlag());
    const size = fstatSync(descriptor).size;
    if (size < cursor.offset) {
      cursor.offset = 0;
    }
    if (size === cursor.offset) {
      this.cursors.set(context.sessionId, cursor);
      closeSync(descriptor);
      return [];
    }

    const length = size - cursor.offset;
    const buffer = Buffer.alloc(length);
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

  private resultExists(context: AgentToolContext, id: string): boolean {
    const resultPath = this.resultPath(context, id);
    if (!existsSync(resultPath)) {
      return false;
    }
    assertRegularFileInside(resultPath, context.resultDir, "Tool result");
    return true;
  }

  private assertContextPaths(context: AgentToolContext): void {
    const bridge = secureSessionBridgePaths(context.statePath);
    if (bridge.outboxPath !== context.outboxPath || bridge.resultDir !== context.resultDir) {
      throw new Error(`Session tool bridge escaped its private state: ${context.sessionId}`);
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

function assertRegularFileInside(filePath: string, allowedRoot: string, label: string): void {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink file: ${filePath}`);
  }
  const canonical = realpathSync.native(filePath);
  if (!isPathInsideAllowedRoots(canonical, [allowedRoot])) {
    throw new Error(`${label} escaped its private state directory: ${filePath}`);
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

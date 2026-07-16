import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { ChannelAdapter, OutboundArtifact } from "../channels/types.js";
import { sniffMimeType } from "./media-cache.js";
import { isPathInsideAllowedRoots } from "./path-policy.js";
import type { ChatTarget } from "./types.js";
import type { AuditLog } from "./audit-log.js";

export type SendMediaInput = {
  path: string;
  caption?: string;
  kind?: "image" | "file";
};

export type SendMediaResult = {
  deliveryId: string;
  status: "sent" | "failed";
  platform: ChatTarget["platform"];
  path: string;
  kind?: "image" | "file";
  size?: number;
  message?: string;
};

type SendMediaOptions = {
  source?: "hub_command" | "auto_discovery" | "agent_tool";
  notifyOnFailure?: boolean;
  extraAllowedRoots?: string[];
  deliveryContext?: HubToolDeliveryContext;
};

export type ArtifactDeliveryRequest = {
  deliveryId: string;
  source: NonNullable<SendMediaOptions["source"]>;
  contentLength: number;
  deliveryContext?: HubToolDeliveryContext;
};

export type HubToolDeliveryContext = {
  sessionId?: string;
  turnId?: string;
};

export class HubToolService {
  constructor(
    private readonly config: HubConfig,
    private readonly channel: ChannelAdapter,
    private readonly audit: AuditLog,
    private readonly sendText: (
      target: ChatTarget,
      text: string,
      deliveryContext?: HubToolDeliveryContext,
    ) => Promise<void> = (target, text) =>
      channel.sendText(target, text),
    private readonly sendArtifact: (
      target: ChatTarget,
      artifact: OutboundArtifact,
      request: ArtifactDeliveryRequest,
    ) => Promise<void> = (target, artifact) => {
      if (!channel.sendArtifact) {
        throw new Error(`Channel does not support media delivery: ${target.platform}`);
      }
      return channel.sendArtifact(target, artifact);
    },
    private readonly deliveryContextFor: (target: ChatTarget) => HubToolDeliveryContext = () => ({}),
  ) {}

  async sendMedia(target: ChatTarget, input: SendMediaInput, options: SendMediaOptions = {}): Promise<SendMediaResult> {
    const deliveryId = randomUUID();
    const source = options.source ?? "agent_tool";
    const context = options.deliveryContext ?? this.deliveryContextFor(target);

    try {
      const artifact = this.validateMediaInput(input, options.extraAllowedRoots ?? []);
      const size = statSync(artifact.path).size;
      await this.sendArtifact(target, artifact, {
        deliveryId,
        source,
        contentLength: size,
        ...(context.sessionId || context.turnId ? { deliveryContext: context } : {}),
      });
      const result: SendMediaResult = {
        deliveryId,
        status: "sent",
        platform: target.platform,
        path: artifact.path,
        kind: artifact.kind,
        size,
      };
      await this.audit.write({
        type: "artifact.delivery",
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        target,
        details: {
          deliveryId,
          source,
          path: result.path,
          kind: result.kind,
          status: result.status,
          size: result.size,
          ...(context.turnId ? { turnId: context.turnId } : {}),
        },
      });
      return result;
    } catch (error) {
      const message = formatError(error);
      const auditStatus = error instanceof Error && error.name === "DeliveryExpiredError" ? "expired" : "failed";
      const result: SendMediaResult = {
        deliveryId,
        status: "failed",
        platform: target.platform,
        path: input.path,
        message,
      };
      await this.audit.write({
        type: "artifact.delivery",
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        target,
        details: {
          deliveryId,
          source,
          path: input.path,
          ...(input.kind ? { kind: input.kind } : {}),
          status: auditStatus,
          error: message,
          ...(context.turnId ? { turnId: context.turnId } : {}),
        },
      });
      if (options.notifyOnFailure) {
        await this.notifyFailure(target, input.path, message, context);
      }
      return result;
    }
  }

  private validateMediaInput(input: SendMediaInput, extraAllowedRoots: string[]): OutboundArtifact {
    const realPath = realpathSync(input.path);
    const stats = statSync(realPath);
    if (!stats.isFile()) {
      throw new Error(`Media path is not a file: ${input.path}`);
    }
    if (stats.size > this.config.media.max_outbound_bytes) {
      throw new Error(`Media is too large (${stats.size} bytes > ${this.config.media.max_outbound_bytes} byte limit)`);
    }

    const allowedRoots = [hubOutboundRoot(this.config), ...this.config.outboundRoots, ...extraAllowedRoots];
    if (!isPathInsideAllowedRoots(realPath, allowedRoots)) {
      throw new Error(`Media path is outside outbound roots: ${realPath}`);
    }

    const sniffedMimeType = sniffMimeType(readFileSync(realPath));
    const mimeType = sniffedMimeType ?? mimeTypeFromFilename(realPath);
    const inferredKind = sniffedMimeType?.startsWith("image/") ? "image" : "file";
    const kind = input.kind ?? inferredKind;
    if (kind === "image" && !sniffedMimeType?.startsWith("image/")) {
      throw new Error(`Media kind image does not match detected MIME type: ${mimeType ?? "unknown"}`);
    }

    return {
      path: realPath,
      kind,
      ...(input.caption ? { caption: input.caption } : {}),
    };
  }

  private async notifyFailure(
    target: ChatTarget,
    mediaPath: string,
    message: string,
    deliveryContext: HubToolDeliveryContext,
  ): Promise<void> {
    try {
      await this.sendText(
        target,
        `Media delivery failed for ${path.basename(mediaPath)}: ${message}`,
        deliveryContext,
      );
    } catch (error) {
      process.stderr.write(`[hitch] Media delivery failure notification failed: ${formatError(error)}\n`);
    }
  }
}

function hubOutboundRoot(config: HubConfig): string {
  return path.join(config.dataDir, "media", "outbound");
}

function mimeTypeFromFilename(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    default:
      return undefined;
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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
  requiredAllowedRoots?: string[];
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

    let prepared: PreparedMedia | undefined;
    try {
      prepared = this.prepareMediaInput(
        input,
        options.extraAllowedRoots ?? [],
        options.requiredAllowedRoots ?? [],
      );
      await this.sendArtifact(target, prepared.artifact, {
        deliveryId,
        source,
        contentLength: prepared.size,
        ...(context.sessionId || context.turnId ? { deliveryContext: context } : {}),
      });
      const result: SendMediaResult = {
        deliveryId,
        status: "sent",
        platform: target.platform,
        path: prepared.sourcePath,
        kind: prepared.artifact.kind,
        size: prepared.size,
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
    } finally {
      if (prepared?.snapshotPath && existsSync(prepared.snapshotPath)) {
        unlinkSync(prepared.snapshotPath);
      }
    }
  }

  private prepareMediaInput(
    input: SendMediaInput,
    extraAllowedRoots: string[],
    requiredAllowedRoots: string[],
  ): PreparedMedia {
    const realPath = realpathSync(input.path);
    const allowedRoots = [hubOutboundRoot(this.config), ...this.config.outboundRoots, ...extraAllowedRoots];
    if (!isPathInsideAllowedRoots(realPath, allowedRoots)) {
      throw new Error(`Media path is outside outbound roots: ${realPath}`);
    }
    if (requiredAllowedRoots.length > 0 && !isPathInsideAllowedRoots(realPath, requiredAllowedRoots)) {
      throw new Error(`Media path is outside the active session mounts: ${realPath}`);
    }

    const descriptor = openSync(realPath, constants.O_RDONLY | noFollowFlag());
    let bytes: Buffer;
    let openedPath = realPath;
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) {
        throw new Error(`Media path is not a file: ${input.path}`);
      }
      if (stats.size > this.config.media.max_outbound_bytes) {
        throw new Error(`Media is too large (${stats.size} bytes > ${this.config.media.max_outbound_bytes} byte limit)`);
      }
      openedPath = canonicalPathForDescriptor(descriptor, realPath);
      if (!isPathInsideAllowedRoots(openedPath, allowedRoots)) {
        throw new Error(`Opened media file is outside outbound roots: ${openedPath}`);
      }
      if (requiredAllowedRoots.length > 0 && !isPathInsideAllowedRoots(openedPath, requiredAllowedRoots)) {
        throw new Error(`Opened media file is outside the active session mounts: ${openedPath}`);
      }
      bytes = readSnapshotBytes(descriptor, stats.size);
    } finally {
      closeSync(descriptor);
    }
    const sniffedMimeType = sniffMimeType(bytes);
    const mimeType = sniffedMimeType ?? mimeTypeFromFilename(realPath);
    const inferredKind = sniffedMimeType?.startsWith("image/") ? "image" : "file";
    const kind = input.kind ?? inferredKind;
    if (kind === "image" && !sniffedMimeType?.startsWith("image/")) {
      throw new Error(`Media kind image does not match detected MIME type: ${mimeType ?? "unknown"}`);
    }

    const snapshotPath = writePrivateSnapshot(this.config, openedPath, bytes);
    return {
      sourcePath: openedPath,
      snapshotPath,
      size: bytes.length,
      artifact: {
        path: snapshotPath,
        kind,
        ...(input.caption ? { caption: input.caption } : {}),
      },
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

type PreparedMedia = {
  sourcePath: string;
  snapshotPath: string;
  size: number;
  artifact: OutboundArtifact;
};

function readSnapshotBytes(descriptor: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, offset, size - offset, offset);
    if (count === 0) {
      break;
    }
    offset += count;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

function canonicalPathForDescriptor(descriptor: number, fallback: string): string {
  if (process.platform !== "linux") {
    return fallback;
  }
  try {
    return realpathSync.native(`/proc/self/fd/${descriptor}`);
  } catch {
    throw new Error("Media file changed while Hitch opened it for validation.");
  }
}

function writePrivateSnapshot(config: HubConfig, sourcePath: string, bytes: Buffer): string {
  const outboundRoot = ensurePrivateSnapshotDirectory(config);
  const baseName = path.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "artifact";
  const snapshotPath = path.join(outboundRoot, `${randomUUID()}-${baseName}`);
  try {
    const descriptor = openSync(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      }
    } finally {
      closeSync(descriptor);
    }
    chmodSync(snapshotPath, 0o400);
    return snapshotPath;
  } catch (error) {
    if (existsSync(snapshotPath)) {
      unlinkSync(snapshotPath);
    }
    throw error;
  }
}

function ensurePrivateSnapshotDirectory(config: HubConfig): string {
  const outboundRoot = hubOutboundRoot(config);
  mkdirSync(outboundRoot, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(outboundRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Hitch outbound snapshot root is not a real directory: ${outboundRoot}`);
  }
  chmodSync(outboundRoot, 0o700);
  return realpathSync.native(outboundRoot);
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
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

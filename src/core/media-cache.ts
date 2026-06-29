import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { HubAttachment, Platform } from "./types.js";

export type StoreAttachmentInput = {
  source: Platform;
  kind: HubAttachment["kind"];
  data: Buffer;
  filename?: string;
  mimeType?: string;
  originalId?: string;
};

export class MediaCache {
  private readonly inboundDir: string;

  constructor(dataDir: string) {
    this.inboundDir = path.join(dataDir, "media", "inbound");
    mkdirSync(this.inboundDir, { recursive: true });
  }

  storeInbound(input: StoreAttachmentInput): HubAttachment {
    const sha256 = crypto.createHash("sha256").update(input.data).digest("hex");
    const mimeType = sniffMimeType(input.data) ?? input.mimeType ?? mimeTypeFromFilename(input.filename);
    const extension = extensionFor(input.filename, mimeType);
    const localPath = path.join(this.inboundDir, `${sha256}${extension}`);
    if (!existsSync(localPath)) {
      writeFileSync(localPath, input.data, { flag: "wx" });
    }

    return {
      id: crypto.randomUUID(),
      source: input.source,
      kind: input.kind,
      ...(input.filename ? { filename: input.filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      size: input.data.byteLength,
      localPath,
      sha256,
      ...(input.originalId ? { originalId: input.originalId } : {}),
    };
  }
}

function sniffMimeType(data: Buffer): string | undefined {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 5 && data.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (looksLikeUtf8Text(data)) {
    return "text/plain";
  }
  return undefined;
}

function looksLikeUtf8Text(data: Buffer): boolean {
  if (data.length === 0) {
    return false;
  }
  if (data.includes(0)) {
    return false;
  }
  const sample = data.subarray(0, Math.min(data.length, 4096)).toString("utf8");
  return !sample.includes("\uFFFD");
}

function mimeTypeFromFilename(filename: string | undefined): string | undefined {
  switch (path.extname(filename ?? "").toLowerCase()) {
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

function extensionFor(filename: string | undefined, mimeType: string | undefined): string {
  if (filename) {
    const extension = path.extname(filename);
    if (/^\.[a-zA-Z0-9]{1,12}$/.test(extension)) {
      return extension;
    }
  }

  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

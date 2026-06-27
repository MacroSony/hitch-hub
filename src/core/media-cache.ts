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
    const extension = extensionFor(input.filename, input.mimeType);
    const localPath = path.join(this.inboundDir, `${sha256}${extension}`);
    if (!existsSync(localPath)) {
      writeFileSync(localPath, input.data, { flag: "wx" });
    }

    return {
      id: crypto.randomUUID(),
      source: input.source,
      kind: input.kind,
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      size: input.data.byteLength,
      localPath,
      sha256,
      ...(input.originalId ? { originalId: input.originalId } : {}),
    };
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

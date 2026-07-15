import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "./types.js";

export type AuditLogOptions = {
  maxBytes?: number;
  maxFiles?: number;
};

export class AuditLog {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private tail = Promise.resolve();

  constructor(dataDir: string, options: AuditLogOptions = {}) {
    this.filePath = path.join(dataDir, "logs", "audit.jsonl");
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
  }

  async write(event: Omit<AuditEvent, "at">): Promise<void> {
    const payload: AuditEvent = {
      ...event,
      at: new Date().toISOString(),
    };
    const line = `${JSON.stringify(payload)}\n`;
    const write = this.tail.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded(Buffer.byteLength(line));
      await appendFile(this.filePath, line, "utf8");
    });
    this.tail = write.catch(() => undefined);
    await write;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  private async rotateIfNeeded(nextBytes: number): Promise<void> {
    const currentBytes = await fileSize(this.filePath);
    if (currentBytes === 0 || currentBytes + nextBytes <= this.maxBytes) {
      return;
    }

    if (this.maxFiles === 1) {
      await rm(this.filePath, { force: true });
      return;
    }

    const lastRotation = this.maxFiles - 1;
    await rm(`${this.filePath}.${lastRotation}`, { force: true });
    for (let index = lastRotation - 1; index >= 1; index -= 1) {
      await renameIfExists(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
    }
    await renameIfExists(this.filePath, `${this.filePath}.1`);
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }
}

async function renameIfExists(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

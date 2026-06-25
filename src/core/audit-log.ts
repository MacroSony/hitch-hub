import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "./types.js";

export class AuditLog {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "logs", "audit.jsonl");
  }

  async write(event: Omit<AuditEvent, "at">): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: AuditEvent = {
      ...event,
      at: new Date().toISOString(),
    };
    await appendFile(this.filePath, `${JSON.stringify(payload)}\n`, "utf8");
  }
}

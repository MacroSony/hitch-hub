import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { AuditEvent } from "./types.js";

export class AuditLog {
  private readonly filePath: string;
  private tail = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "logs", "audit.jsonl");
  }

  async write(event: Omit<AuditEvent, "at">): Promise<void> {
    const payload: AuditEvent = {
      ...event,
      at: new Date().toISOString(),
    };
    const write = this.tail.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(payload)}\n`, "utf8");
    });
    this.tail = write.catch(() => undefined);
    await write;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

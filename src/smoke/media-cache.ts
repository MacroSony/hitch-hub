import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { MediaCache } from "../core/media-cache.js";
import { isPathInsideAllowedRoots } from "../core/path-policy.js";

type CliArgs = {
  configPath: string;
};

function parseArgs(argv: string[]): CliArgs {
  let configPath = "examples/config.smoke.yaml";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      configPath = value;
      index += 1;
    }
  }

  return { configPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const cache = new MediaCache(config.dataDir);
  const data = Buffer.from("hitch media smoke\n", "utf8");

  const first = cache.storeInbound({
    source: "telegram",
    kind: "file",
    data,
    filename: "note.txt",
    mimeType: "text/plain",
    originalId: "smoke-1",
  });
  const second = cache.storeInbound({
    source: "telegram",
    kind: "file",
    data,
    filename: "note.txt",
    mimeType: "text/plain",
    originalId: "smoke-2",
  });

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.localPath, second.localPath);
  assert.equal(first.size, data.byteLength);
  assert.equal(first.mimeType, "text/plain");
  assert.ok(existsSync(first.localPath));
  assert.ok(isPathInsideAllowedRoots(first.localPath, [path.join(config.dataDir, "media")]));

  process.stdout.write(`Media cache smoke ok: sha256=${first.sha256} path=${first.localPath}\n`);
}

main();

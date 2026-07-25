import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { DeterministicTestAccounting } from "./test-accounting.js";

async function discoverTests(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return discoverTests(path);
      }
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
    }),
  );
  return discovered.flat().sort();
}

const v2Root = fileURLToPath(new URL("../", import.meta.url));
const testFiles = await discoverTests(v2Root);

if (testFiles.length === 0) {
  throw new Error("no v2 deterministic test files were discovered");
}

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    ...testFiles,
  ],
  { stdio: ["inherit", "pipe", "inherit"] },
);

if (child.stdout === null) {
  throw new Error("v2 test runner did not provide a TAP output stream");
}

const accounting = new DeterministicTestAccounting();
const outputComplete = (async (): Promise<void> => {
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    process.stdout.write(`${line}\n`);
    accounting.observeTapLine(line);
  }
})();

const childExit = new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      reject(new Error(`v2 test runner terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

const [exitCode] = await Promise.all([childExit, outputComplete]);
try {
  accounting.assertAcceptable();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
if (process.exitCode !== 1) {
  process.exitCode = exitCode;
}

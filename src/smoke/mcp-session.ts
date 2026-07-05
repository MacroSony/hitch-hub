import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-mcp-smoke");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const mediaPath = path.join(dataDir, "mcp.png");
  writeFileSync(
    mediaPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  );

  const token = "mcp-smoke-token";
  const outboxPath = path.join(dataDir, "tools", "session", "outbox.jsonl");
  const resultDir = path.join(dataDir, "tools", "session", "results");
  mkdirSync(resultDir, { recursive: true });

  const client = new Client({ name: "hitch-mcp-smoke", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/session-server.ts"],
    cwd: path.resolve("."),
    env: {
      HITCH_TOOL_TOKEN: token,
      HITCH_TOOL_OUTBOX: outboxPath,
      HITCH_TOOL_RESULT_DIR: resultDir,
      HITCH_TOOL_TIMEOUT_MS: "5000",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "hitch.send_media")) {
      throw new Error("Expected hitch.send_media tool to be registered.");
    }

    const call = client.callTool({
      name: "hitch.send_media",
      arguments: {
        path: mediaPath,
        caption: "MCP smoke caption",
        kind: "image",
      },
    });

    const request = await waitForOutboxRequest(outboxPath);
    if (request.type !== "send_media" || request.token !== token || request.path !== mediaPath || request.caption !== "MCP smoke caption") {
      throw new Error(`Unexpected MCP outbox request: ${JSON.stringify(request)}`);
    }

    writeFileSync(
      path.join(resultDir, `${request.id}.json`),
      `${JSON.stringify({
        deliveryId: request.id,
        status: "sent",
        platform: "fake",
        path: mediaPath,
        kind: "image",
        size: 68,
      })}\n`,
      "utf8",
    );

    const result = await call;
    const structured = result.structuredContent as { status?: unknown; platform?: unknown } | undefined;
    if (structured?.status !== "sent" || structured.platform !== "fake") {
      throw new Error(`Unexpected MCP tool result: ${JSON.stringify(result)}`);
    }
  } finally {
    await client.close();
  }

  process.stdout.write("MCP session smoke ok\n");
}

async function waitForOutboxRequest(outboxPath: string): Promise<Record<string, string>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(outboxPath)) {
      const line = readFileSync(outboxPath, "utf8").trim().split(/\r?\n/).find(Boolean);
      if (line) {
        return JSON.parse(line) as Record<string, string>;
      }
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for MCP outbox request.");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

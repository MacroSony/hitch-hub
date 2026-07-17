import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const serverPath = process.env.HITCH_MCP_SERVER_PATH ?? path.resolve("packages/session-mcp/dist/server.js");
  const serverCwd = process.env.HITCH_MCP_SERVER_CWD ?? path.resolve(".");
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
    args: [serverPath],
    cwd: serverCwd,
    env: {
      HITCH_TOOL_TOKEN: token,
      HITCH_TOOL_OUTBOX: outboxPath,
      HITCH_TOOL_RESULT_DIR: resultDir,
      HITCH_TOOL_TIMEOUT_MS: process.env.HITCH_MCP_TOOL_TIMEOUT_MS ?? "1000",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const prompts = await client.listPrompts();
    if (!prompts.prompts.some((prompt) => prompt.name === "hitch.outbound_media")) {
      throw new Error("Expected hitch.outbound_media prompt to be registered.");
    }
    const prompt = await client.getPrompt({ name: "hitch.outbound_media" });
    const promptText = prompt.messages
      .map((message) => (message.content.type === "text" ? message.content.text : ""))
      .join("\n");
    if (!promptText.includes("hitch.send_media") || !promptText.includes("Do not only mention the file path")) {
      throw new Error(`Unexpected MCP prompt content: ${JSON.stringify(prompt)}`);
    }

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

    const failedCall = client.callTool({
      name: "hitch.send_media",
      arguments: { path: mediaPath, kind: "image" },
    });
    const failedRequest = await waitForOutboxRequest(outboxPath, [request.id]);
    writeFileSync(
      path.join(resultDir, `${failedRequest.id}.json`),
      `${JSON.stringify({
        deliveryId: failedRequest.id,
        status: "failed",
        platform: "fake",
        path: mediaPath,
        message: "rejected by hub",
      })}\n`,
      "utf8",
    );
    const failedResult = await failedCall;
    const failedStructured = failedResult.structuredContent as { status?: unknown; message?: unknown } | undefined;
    if (!failedResult.isError || failedStructured?.status !== "failed" || failedStructured.message !== "rejected by hub") {
      throw new Error(`Failed media delivery was not returned as an MCP error: ${JSON.stringify(failedResult)}`);
    }

    const malformedCall = client.callTool({
      name: "hitch.send_media",
      arguments: { path: mediaPath, kind: "image" },
    });
    const malformedRequest = await waitForOutboxRequest(outboxPath, [request.id, failedRequest.id]);
    writeFileSync(path.join(resultDir, `${malformedRequest.id}.json`), "{malformed", "utf8");
    const malformedResult = await malformedCall;
    if (!malformedResult.isError) {
      throw new Error(`Malformed Hitch result was accepted: ${JSON.stringify(malformedResult)}`);
    }

    const timeoutCall = client.callTool({
      name: "hitch.send_media",
      arguments: { path: mediaPath, kind: "image" },
    }, undefined, { timeout: 5_000 });
    const timeoutRequest = await waitForOutboxRequest(outboxPath, [request.id, failedRequest.id, malformedRequest.id]);
    const timeoutResult = await timeoutCall;
    const timeoutStructured = timeoutResult.structuredContent as { status?: unknown; message?: unknown } | undefined;
    if (!timeoutResult.isError || timeoutStructured?.status !== "failed" || !String(timeoutStructured.message).includes("Timed out")) {
      throw new Error(`MCP result timeout was not reported cleanly: ${JSON.stringify(timeoutResult)}`);
    }

    const controller = new AbortController();
    const cancelledCall = client.callTool(
      { name: "hitch.send_media", arguments: { path: mediaPath, kind: "image" } },
      undefined,
      { signal: controller.signal, timeout: 5_000 },
    );
    await waitForOutboxRequest(outboxPath, [request.id, failedRequest.id, malformedRequest.id, timeoutRequest.id]);
    const cancellationStartedAt = Date.now();
    controller.abort();
    let cancelled = false;
    let cancellationDetail = "resolved";
    try {
      const result = await cancelledCall;
      cancellationDetail = `resolved: ${JSON.stringify(result)}`;
    } catch (error) {
      cancelled = true;
      cancellationDetail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    if (!cancelled || Date.now() - cancellationStartedAt > 500) {
      throw new Error(`Cancelled MCP media request did not reject promptly: ${cancellationDetail}`);
    }
  } finally {
    await client.close();
  }

  process.stdout.write("MCP session smoke ok\n");
}

type OutboxRequest = Record<string, string> & { id: string };

async function waitForOutboxRequest(outboxPath: string, excludeIds: readonly string[] = []): Promise<OutboxRequest> {
  const excluded = new Set(excludeIds);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(outboxPath)) {
      const requests = readFileSync(outboxPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
        .filter(isOutboxRequest);
      const request = requests.find((candidate) => !excluded.has(candidate.id));
      if (request) {
        return request;
      }
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for MCP outbox request.");
}

function isOutboxRequest(value: unknown): value is OutboxRequest {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string";
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

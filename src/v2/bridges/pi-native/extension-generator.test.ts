import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { CodecDecodeError } from "../../codecs/errors.js";
import { scenarioCase } from "../../acceptance/runner.js";
import {
  withDisposableDataRoot,
  type DisposableDataRoot,
} from "../../test-support/disposable-data-root.js";
import {
  PI_NATIVE_EXTENSION_SOCKET_PATH,
  decodePiNativeExtensionSemanticManifest,
  generatePiNativeBridgeExtension,
  piNativeBridgeBindingFromManifest,
} from "./extension-generator.js";
import {
  decodePiNativeBridgeClientFrame,
  type PiNativeInvokeFrame,
} from "./frames.js";

const STACK_DIGEST = `sha256:${"a".repeat(64)}`;
const CATALOG_DIGEST = `sha256:${"b".repeat(64)}`;

interface GeneratedEventStream extends AsyncIterable<Record<string, unknown>> {
  result(): Promise<Record<string, unknown>>;
}

interface RegisteredPiProvider {
  readonly models: readonly Record<string, unknown>[];
  streamSimple(
    model: Record<string, unknown>,
    context: unknown,
    options?: Readonly<Record<string, unknown>>,
  ): GeneratedEventStream;
}

interface ExecutedGeneratedStream {
  readonly events: readonly Record<string, unknown>[];
  readonly invoke: PiNativeInvokeFrame;
  readonly result: Record<string, unknown>;
}

function manifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    bridgeId: "pi-native-sidecar-v1",
    compatibility: {
      piCodingAgentVersion: "0.82.0",
      piAiVersion: "0.82.0",
      nativeStackDigest: STACK_DIGEST,
    },
    nativeCatalogDigest: CATALOG_DIGEST,
    provider: {
      id: "openai-codex",
      displayName: "OpenAI Codex through Hitch",
      model: {
        id: "gpt-5.4-mini",
        displayName: "GPT-5.4 mini",
        api: "openai-codex-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindowTokens: 272_000,
        maximumOutputTokens: 128_000,
      },
    },
  };
}

function reorderedManifest(): Record<string, unknown> {
  return {
    provider: {
      model: {
        maximumOutputTokens: 128_000,
        contextWindowTokens: 272_000,
        input: ["text", "image"],
        reasoning: true,
        api: "openai-codex-responses",
        displayName: "GPT-5.4 mini",
        id: "gpt-5.4-mini",
      },
      displayName: "OpenAI Codex through Hitch",
      id: "openai-codex",
    },
    nativeCatalogDigest: CATALOG_DIGEST,
    compatibility: {
      nativeStackDigest: STACK_DIGEST,
      piAiVersion: "0.82.0",
      piCodingAgentVersion: "0.82.0",
    },
    bridgeId: "pi-native-sidecar-v1",
    manifestVersion: 1,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function sidecarBase(invoke: PiNativeInvokeFrame): Record<string, unknown> {
  return {
    protocolVersion: invoke.protocolVersion,
    correlationId: invoke.correlationId,
    compatibility: invoke.compatibility,
    binding: invoke.binding,
  };
}

function writeSidecarFrames(
  socket: Socket,
  invoke: PiNativeInvokeFrame,
  frames: readonly Record<string, unknown>[],
): void {
  socket.write(
    frames
      .map((frame) => JSON.stringify({ ...sidecarBase(invoke), ...frame }))
      .join("\n") + "\n",
  );
}

async function loadGeneratedProvider(
  root: DisposableDataRoot,
): Promise<RegisteredPiProvider> {
  const generated = generatePiNativeBridgeExtension(manifest());
  const socketPath = root.resolve("pi-native.sock");
  const modulePath = root.resolve(generated.fileName);
  const fixedSocketLiteral = JSON.stringify(PI_NATIVE_EXTENSION_SOCKET_PATH);
  assert.equal(generated.source.split(fixedSocketLiteral).length - 1, 1);
  await writeFile(
    modulePath,
    generated.source.replace(fixedSocketLiteral, JSON.stringify(socketPath)),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const loaded = await import(pathToFileURL(modulePath).href) as {
    readonly default: (pi: {
      registerProvider(id: string, provider: RegisteredPiProvider): void;
    }) => void;
  };
  let provider: RegisteredPiProvider | undefined;
  loaded.default({
    registerProvider: (_id, registered) => {
      provider = registered;
    },
  });
  assert.ok(provider);
  return provider;
}

async function executeGeneratedStream(
  context: unknown,
  respond: (socket: Socket, invoke: PiNativeInvokeFrame) => Promise<void> | void,
): Promise<ExecutedGeneratedStream> {
  return withDisposableDataRoot(async (root) => {
    const socketPath = root.resolve("pi-native.sock");

    const sockets = new Set<Socket>();
    let resolveResponse!: () => void;
    let rejectResponse!: (error: unknown) => void;
    const responseCompleted = new Promise<void>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    let resolveInvoke!: (invoke: PiNativeInvokeFrame) => void;
    let rejectInvoke!: (error: unknown) => void;
    const invocation = new Promise<PiNativeInvokeFrame>((resolve, reject) => {
      resolveInvoke = resolve;
      rejectInvoke = reject;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let buffer = "";
      let received = false;
      socket.on("data", (chunk) => {
        if (received) return;
        buffer += chunk.toString("utf8");
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd < 0) return;
        received = true;
        try {
          const decoded = decodePiNativeBridgeClientFrame(
            JSON.parse(buffer.slice(0, lineEnd)),
            { binding: piNativeBridgeBindingFromManifest(manifest()) },
          );
          if (decoded.kind !== "invoke") {
            throw new Error("generated extension sent a non-invoke first frame");
          }
          resolveInvoke(decoded);
          void Promise.resolve(respond(socket, decoded)).then(
            resolveResponse,
            (error) => {
              rejectResponse(error);
              socket.destroy();
            },
          );
        } catch (error) {
          rejectInvoke(error);
          rejectResponse(error);
          socket.destroy();
        }
      });
    });

    await listen(server, socketPath);
    try {
      const provider = await loadGeneratedProvider(root);
      const model = provider.models[0];
      assert.ok(model);
      const stream = provider.streamSimple(model, context);
      const events: Record<string, unknown>[] = [];
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      const invoke = await invocation;
      await responseCompleted;
      return { events, invoke, result };
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });
}

async function executeRejectedGeneratedContext(
  context: unknown,
): Promise<{
  readonly receivedBytes: number;
  readonly result: Record<string, unknown>;
}> {
  return withDisposableDataRoot(async (root) => {
    const socketPath = root.resolve("pi-native.sock");
    const sockets = new Set<Socket>();
    let receivedBytes = 0;
    let resolveConnectionClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk) => {
        receivedBytes += chunk.length;
      });
      socket.once("close", () => {
        sockets.delete(socket);
        resolveConnectionClosed();
      });
    });

    await listen(server, socketPath);
    try {
      const provider = await loadGeneratedProvider(root);
      const model = provider.models[0];
      assert.ok(model);
      const stream = provider.streamSimple(model, context);
      for await (const _event of stream) {
        // Drain the bounded generated stream to its error terminal.
      }
      const result = await stream.result();
      await connectionClosed;
      return { receivedBytes, result };
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });
}

test("Pi native extension generator is content addressed and independent from caller mutation", () => {
  const input = manifest();
  const first = generatePiNativeBridgeExtension(input);
  const second = generatePiNativeBridgeExtension(reorderedManifest());
  assert.equal(first.source, second.source);
  assert.equal(first.semanticManifestDigest, second.semanticManifestDigest);
  assert.equal(first.artifactDigest, second.artifactDigest);
  assert.equal(first.fileName, "hitch-pi-native-bridge-0.82.0.mjs");
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.semanticManifest));

  ((input.provider as Record<string, unknown>).model as Record<string, unknown>).id = "attacker-model";
  assert.equal(first.semanticManifest.provider.model.id, "gpt-5.4-mini");
  assert.throws(() => {
    (first.semanticManifest.provider.model as { id: string }).id = "attacker-model";
  }, TypeError);
  const bytes = first.sourceUtf8();
  bytes[0] = 0;
  assert.equal(new TextDecoder().decode(first.sourceUtf8()).startsWith("// Generated by Hitch"), true);

  const parsed = ts.createSourceFile(first.fileName, first.source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  assert.deepEqual((parsed as unknown as { readonly parseDiagnostics: readonly unknown[] }).parseDiagnostics, []);
});

test("Pi native extension semantic manifest is exact and rejects source/config/authority injection", () => {
  const decoded = decodePiNativeExtensionSemanticManifest(manifest());
  assert.equal(decoded.provider.id, "openai-codex");
  assert.deepEqual(piNativeBridgeBindingFromManifest(manifest()), {
    bridgeId: "pi-native-sidecar-v1",
    nativeStackDigest: STACK_DIGEST,
    nativeCatalogDigest: CATALOG_DIGEST,
  });
  for (const forbidden of ["source", "args", "env", "path", "command", "loader", "origin", "headers", "auth", "credential"] as const) {
    assert.throws(
      () => decodePiNativeExtensionSemanticManifest({ ...manifest(), [forbidden]: "attacker-selected" }),
      CodecDecodeError,
      forbidden,
    );
  }
  assert.throws(
    () => decodePiNativeExtensionSemanticManifest({ ...manifest(), compatibility: { ...(manifest().compatibility as Record<string, unknown>), piAiVersion: "0.83.0" } }),
    CodecDecodeError,
  );
  assert.throws(
    () => decodePiNativeExtensionSemanticManifest({ ...manifest(), provider: { ...(manifest().provider as Record<string, unknown>), model: { ...((manifest().provider as Record<string, unknown>).model as Record<string, unknown>), input: ["image"] } } }),
    CodecDecodeError,
  );
  assert.throws(
    () => decodePiNativeExtensionSemanticManifest({ ...manifest(), provider: { ...(manifest().provider as Record<string, unknown>), model: { ...((manifest().provider as Record<string, unknown>).model as Record<string, unknown>), maximumOutputTokens: 300_000 } } }),
    CodecDecodeError,
  );
});

function assertGeneratedExtensionHasOnlyReviewedAuthority(): void {
  const source = generatePiNativeBridgeExtension(manifest()).source;
  assert.match(source, /maxRetries: 0/u);
  assert.match(source, /transport: "sse"/u);
  assert.match(source, new RegExp(JSON.stringify(PI_NATIVE_EXTENSION_SOCKET_PATH).replaceAll("/", "\\/"), "u"));
  assert.equal((source.match(/pi\.registerProvider/gu) ?? []).length, 1);
  for (const forbidden of [
    "process.env",
    "AuthStorage",
    "auth.json",
    "registerCommand",
    "registerTool",
    "pi.on(",
    "setInterval",
    "eval(",
    "new Function",
    "child_process",
    "fetch(",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
}

test("generated Pi extension uses the fixed local bridge and has no ambient auth/provider/background authority", () => {
  assertGeneratedExtensionHasOnlyReviewedAuthority();
});

test("generated Pi extension executes multiline Unicode context over its bounded local stream", { timeout: 5_000 }, async () => {
  const executed = await executeGeneratedStream(
    {
      messages: [
        {
          role: "user",
          content: "first line\nsecond line 😀",
          timestamp: 1,
        },
      ],
    },
    (socket, invoke) => {
      writeSidecarFrames(socket, invoke, [
        { kind: "started" },
        { kind: "text-start", contentIndex: 0 },
        { kind: "text-delta", contentIndex: 0, delta: "hello\n" },
        { kind: "text-end", contentIndex: 0, content: "hello\nworld" },
        {
          kind: "terminal",
          reason: "stop",
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 5,
          },
        },
      ]);
    },
  );

  assert.equal(executed.invoke.context.messages[0]?.content, "first line\nsecond line 😀");
  assert.deepEqual(
    executed.events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_end", "done"],
  );
  assert.equal(executed.result.stopReason, "stop");
  const content = executed.result.content as readonly Record<string, unknown>[];
  assert.equal(content[0]?.text, "hello\nworld");
});

test("generated Pi extension rejects cumulative text beyond its closed stream bound", { timeout: 5_000 }, async () => {
  const executed = await executeGeneratedStream(
    { messages: [{ role: "user", content: "bounded", timestamp: 1 }] },
    (socket, invoke) => {
      writeSidecarFrames(socket, invoke, [
        { kind: "started" },
        { kind: "text-start", contentIndex: 0 },
        { kind: "text-delta", contentIndex: 0, delta: "x".repeat(262_144) },
        { kind: "text-delta", contentIndex: 0, delta: "y" },
      ]);
    },
  );

  assert.equal(executed.result.stopReason, "error");
  assert.equal(
    executed.result.errorMessage,
    "The Hitch native bridge returned an invalid bounded frame.",
  );
  const content = executed.result.content as readonly Record<string, unknown>[];
  assert.equal((content[0]?.text as string).length, 262_144);
});

test("generated Pi extension rejects oversized aggregate tool arguments", { timeout: 5_000 }, async () => {
  const executed = await executeGeneratedStream(
    { messages: [{ role: "user", content: "bounded", timestamp: 1 }] },
    (socket, invoke) => {
      writeSidecarFrames(socket, invoke, [
        { kind: "started" },
        { kind: "tool-start", contentIndex: 0 },
        {
          kind: "tool-end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "tool-call-1",
            name: "read",
            arguments: Object.fromEntries(
              Array.from(
                { length: 5 },
                (_, index) => [`argument${index}`, "x".repeat(65_536)],
              ),
            ),
          },
        },
      ]);
    },
  );

  assert.equal(executed.result.stopReason, "error");
  assert.equal(
    executed.result.errorMessage,
    "The Hitch native bridge returned an invalid bounded frame.",
  );
});

test("generated Pi extension rejects non-tool content and non-object tool arguments at tool-end", { timeout: 5_000 }, async () => {
  const executeToolEnd = (toolCall: Record<string, unknown>) =>
    executeGeneratedStream(
      { messages: [{ role: "user", content: "bounded", timestamp: 1 }] },
      (socket, invoke) => {
        writeSidecarFrames(socket, invoke, [
          { kind: "started" },
          { kind: "tool-start", contentIndex: 0 },
          { kind: "tool-end", contentIndex: 0, toolCall },
        ]);
      },
    );

  const textContent = await executeToolEnd({
    type: "text",
    text: "not a tool call",
  });
  assert.equal(textContent.result.stopReason, "error");

  const arrayArguments = await executeToolEnd({
    type: "toolCall",
    id: "tool-call-1",
    name: "read",
    arguments: [],
  });
  assert.equal(arrayArguments.result.stopReason, "error");
});

test("generated Pi extension rejects non-object outbound tool schemas before writing an invoke frame", { timeout: 5_000 }, async () => {
  const executed = await executeRejectedGeneratedContext({
    messages: [{ role: "user", content: "bounded", timestamp: 1 }],
    tools: [
      {
        name: "read",
        description: "Read one approved resource.",
        parameters: [],
      },
    ],
  });

  assert.equal(executed.result.stopReason, "error");
  assert.equal(executed.receivedBytes, 0);
});

test("generated Pi extension rejects an unbounded sidecar event stream", { timeout: 5_000 }, async () => {
  const executed = await executeGeneratedStream(
    { messages: [{ role: "user", content: "bounded", timestamp: 1 }] },
    (socket, invoke) => {
      writeSidecarFrames(socket, invoke, [
        { kind: "started" },
        ...Array.from(
          { length: 4_096 },
          () => ({ kind: "oauth-status", state: "refresh-started" }),
        ),
      ]);
    },
  );

  assert.equal(executed.result.stopReason, "error");
  assert.equal(
    executed.result.errorMessage,
    "The Hitch native bridge returned an invalid bounded frame.",
  );
});

scenarioCase({
  scenarioId: "V2-S14",
  caseId: "pi-native-generated-extension-no-ambient-authority",
  title: "the generated Pi bridge artifact contains only its fixed local seam and no auth-store, ambient discovery, or background prompt hooks",
  run: assertGeneratedExtensionHasOnlyReviewedAuthority,
});

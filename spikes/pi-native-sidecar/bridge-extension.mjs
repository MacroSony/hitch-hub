import { existsSync } from "node:fs";
import net from "node:net";
import process from "node:process";
import { randomUUID } from "node:crypto";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const PROVIDER_SECRET_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
];

class BridgeEventStream {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.done = false;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  push(event) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result) {
    if (this.done) {
      return;
    }
    this.done = true;
    this.resolveResult(result);
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  result() {
    return this.resultPromise;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function decodeManifest() {
  const encoded = process.env.HITCH_SPIKE_MODEL_MANIFEST_B64;
  if (!encoded) {
    throw new Error("The Hitch sidecar model manifest is missing.");
  }
  const manifest = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.protocolVersion !== 1 ||
    typeof manifest.connectionId !== "string" ||
    typeof manifest.turnId !== "string" ||
    typeof manifest.catalogDigest !== "string" ||
    typeof manifest.providerId !== "string" ||
    !manifest.model ||
    typeof manifest.model.id !== "string"
  ) {
    throw new Error("The Hitch sidecar model manifest is invalid.");
  }
  return manifest;
}

function errorMessage(model, message, aborted = false) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

function streamThroughSidecar(manifest, model, context, options = {}) {
  const output = new BridgeEventStream();
  const requestId = randomUUID();
  const socketPath = process.env.HITCH_SPIKE_SOCKET;
  const capability = options.apiKey;
  if (!socketPath || !capability) {
    const message = errorMessage(model, "The Hitch sidecar capability is unavailable.");
    output.push({ type: "error", reason: "error", error: message });
    output.end(message);
    return output;
  }

  const socket = net.createConnection(socketPath);
  let buffer = "";
  let completed = false;
  const cancel = () => {
    if (!socket.destroyed) {
      socket.write(
        `${JSON.stringify({
          protocolVersion: 1,
          type: "cancel",
          requestId,
        })}\n`,
      );
    }
  };
  options.signal?.addEventListener("abort", cancel, { once: true });

  const fail = (message) => {
    if (completed) {
      return;
    }
    completed = true;
    options.signal?.removeEventListener("abort", cancel);
    const result = errorMessage(model, message, options.signal?.aborted);
    output.push({
      type: "error",
      reason: result.stopReason,
      error: result,
    });
    output.end(result);
    socket.destroy();
  };

  socket.once("connect", () => {
    const request = {
      protocolVersion: 1,
      type: "invoke",
      capability,
      requestId,
      turnId: manifest.turnId,
      connectionId: manifest.connectionId,
      catalogDigest: manifest.catalogDigest,
      providerId: manifest.providerId,
      modelId: manifest.model.id,
      context: JSON.parse(JSON.stringify(context)),
      options: {
        ...(Number.isSafeInteger(options.maxTokens)
          ? { maxTokens: options.maxTokens }
          : {}),
        ...(typeof options.reasoning === "string"
          ? { reasoning: options.reasoning }
          : {}),
        ...(typeof options.sessionId === "string"
          ? { sessionId: options.sessionId }
          : {}),
        ...(typeof options.cacheRetention === "string"
          ? { cacheRetention: options.cacheRetention }
          : {}),
      },
    };
    socket.write(`${JSON.stringify(request)}\n`);
    if (options.signal?.aborted) {
      cancel();
    }
  });
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      fail("The Hitch sidecar response exceeded its size limit.");
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail("The Hitch sidecar returned invalid JSON.");
        return;
      }
      if (message.requestId !== requestId) {
        continue;
      }
      if (message.type === "event") {
        output.push(message.event);
        continue;
      }
      if (message.type === "rejected") {
        fail(`The Hitch sidecar rejected the request (${message.code}).`);
        return;
      }
      if (message.type === "complete") {
        completed = true;
        options.signal?.removeEventListener("abort", cancel);
        output.end(message.result);
        socket.end();
        return;
      }
    }
  });
  socket.once("error", () => fail("The Hitch sidecar connection failed."));
  socket.once("close", () => {
    if (!completed) {
      fail("The Hitch sidecar closed before completing the request.");
    }
  });
  return output;
}

export default function registerHitchNativeSidecar(pi) {
  for (const name of PROVIDER_SECRET_ENV) {
    if (process.env[name]) {
      throw new Error(`The sandboxed Pi worker received forbidden ${name}.`);
    }
  }
  const forbiddenAuthPath = process.env.HITCH_SPIKE_FORBIDDEN_AUTH_PATH;
  if (forbiddenAuthPath && existsSync(forbiddenAuthPath)) {
    throw new Error("The sandboxed Pi worker can see the real Pi auth store.");
  }

  const manifest = decodeManifest();
  pi.registerProvider(manifest.providerId, {
    name: `Hitch bridge: ${manifest.providerId}`,
    baseUrl: "http://hitch-native-sidecar.invalid",
    apiKey: "$HITCH_SPIKE_CAPABILITY",
    api: "hitch-native-sidecar-v1",
    models: [
      {
        id: manifest.model.id,
        name: manifest.model.name,
        api: "hitch-native-sidecar-v1",
        reasoning: manifest.model.reasoning,
        input: manifest.model.input,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: manifest.model.contextWindow,
        maxTokens: manifest.maximumOutputTokens,
      },
    ],
    streamSimple: (model, context, options) =>
      streamThroughSidecar(manifest, model, context, options),
  });
}

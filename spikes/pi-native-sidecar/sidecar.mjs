import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import { isIP } from "node:net";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  digestJson,
  loadPiModules,
  nativeStackDigest,
  publicModelManifest,
  REQUIRED_PI_VERSION,
  resolvePiPackage,
} from "./pi-package.mjs";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const ALLOWED_REASONING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

class MemoryCredentialStore {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.chains = new Map();
  }

  async read(providerId) {
    return this.entries.get(providerId);
  }

  async list() {
    return [...this.entries].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(providerId, fn) {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = this.entries.get(providerId);
      const replacement = await fn(current);
      if (replacement !== undefined) {
        this.entries.set(providerId, replacement);
      }
      return this.entries.get(providerId);
    });
    this.chains.set(providerId, next.catch(() => undefined));
    return next;
  }

  async delete(providerId) {
    this.entries.delete(providerId);
  }
}

class AuditedCredentialStore {
  constructor(inner) {
    this.inner = inner;
    this.counts = { read: 0, list: 0, modify: 0, delete: 0 };
  }

  async read(providerId) {
    this.counts.read += 1;
    return this.inner.read(providerId);
  }

  async list() {
    this.counts.list += 1;
    return this.inner.list();
  }

  async modify(providerId, fn) {
    this.counts.modify += 1;
    return this.inner.modify(providerId, fn);
  }

  async delete(providerId) {
    this.counts.delete += 1;
    return this.inner.delete(providerId);
  }

  snapshot() {
    return { ...this.counts };
  }
}

function decodeConfiguration() {
  const encoded = process.env.HITCH_SPIKE_CONNECTION_B64;
  if (!encoded) {
    throw new Error("HITCH_SPIKE_CONNECTION_B64 is required.");
  }
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    value.protocolVersion !== 1 ||
    typeof value.socketPath !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.connectionId !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.modelId !== "string" ||
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length === 0 ||
    !value.allowedOrigins.every(
      (origin) =>
        typeof origin === "string" &&
        new URL(origin).origin === origin &&
        new URL(origin).protocol === "https:",
    ) ||
    !["faux", "builtin"].includes(value.runtimeMode) ||
    !Number.isSafeInteger(value.maximumOutputTokens) ||
    value.maximumOutputTokens <= 0
  ) {
    throw new Error("The sidecar connection configuration is invalid.");
  }
  return value;
}

function capabilityMatches(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") {
    return false;
  }
  const left = createHash("sha256").update(received).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function installFetchGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  const nativeFetch = globalThis.fetch;
  const audit = [];
  if (typeof nativeFetch !== "function") {
    throw new Error("The pinned Node runtime does not expose fetch.");
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method =
      init.method ??
      (typeof input === "object" && input && "method" in input
        ? input.method
        : "GET");
    if (!allowed.has(url.origin)) {
      audit.push({ outcome: "blocked-origin", origin: url.origin, method });
      throw new Error(`Egress origin is not registered: ${url.origin}`);
    }
    if (url.protocol !== "https:") {
      audit.push({ outcome: "blocked-scheme", origin: url.origin, method });
      throw new Error(`Egress scheme is not allowed: ${url.protocol}`);
    }
    if (isPrivateLiteral(url.hostname)) {
      audit.push({ outcome: "blocked-address", origin: url.origin, method });
      throw new Error(`Egress address is not public: ${url.hostname}`);
    }
    let response;
    try {
      response = await nativeFetch(input, { ...init, redirect: "manual" });
    } catch (error) {
      audit.push({
        outcome: "network-error",
        origin: url.origin,
        method,
        errorName: error instanceof Error ? error.name : "unknown",
        causeCode:
          error instanceof Error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause
            ? String(error.cause.code)
            : undefined,
      });
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      audit.push({
        outcome: "blocked-redirect",
        origin: url.origin,
        method,
        status: response.status,
      });
      throw new Error(`Provider redirect is denied (${response.status}).`);
    }
    audit.push({
      outcome: "allowed",
      origin: url.origin,
      method,
      status: response.status,
    });
    return response;
  };
  return audit;
}

function isPrivateLiteral(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (version === 4) {
    const octets = normalized.split(".").map(Number);
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] === 0
    );
  }
  if (version === 6) {
    const lower = normalized.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe8") ||
      lower.startsWith("fe9") ||
      lower.startsWith("fea") ||
      lower.startsWith("feb")
    );
  }
  return false;
}

function strictKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateContext(context) {
  if (
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    !strictKeys(context, new Set(["systemPrompt", "messages", "tools"])) ||
    !Array.isArray(context.messages) ||
    context.messages.length === 0 ||
    context.messages.length > 200 ||
    (context.systemPrompt !== undefined &&
      typeof context.systemPrompt !== "string") ||
    (context.tools !== undefined &&
      (!Array.isArray(context.tools) || context.tools.length > 128))
  ) {
    return false;
  }
  for (const message of context.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["user", "assistant", "toolResult"].includes(message.role)
    ) {
      return false;
    }
  }
  return Buffer.byteLength(JSON.stringify(context)) <= MAX_CONTEXT_BYTES;
}

function validateOptions(options, maximumOutputTokens) {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    !strictKeys(
      options,
      new Set(["maxTokens", "reasoning", "sessionId", "cacheRetention"]),
    )
  ) {
    return false;
  }
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) ||
      options.maxTokens <= 0 ||
      options.maxTokens > maximumOutputTokens)
  ) {
    return false;
  }
  if (
    options.reasoning !== undefined &&
    !ALLOWED_REASONING.has(options.reasoning)
  ) {
    return false;
  }
  if (
    options.sessionId !== undefined &&
    (typeof options.sessionId !== "string" ||
      options.sessionId.length === 0 ||
      options.sessionId.length > 200)
  ) {
    return false;
  }
  return (
    options.cacheRetention === undefined ||
    ["none", "short", "long"].includes(options.cacheRetention)
  );
}

function usageOf(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    reasoning: usage.reasoning ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

function send(socket, message) {
  if (!socket.destroyed) {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}

function rejection(socket, requestId, code, message) {
  send(socket, {
    protocolVersion: 1,
    type: "rejected",
    requestId,
    code,
    message,
  });
}

function textOfUserMessage(message) {
  if (message.role !== "user") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function hasImage(context) {
  return context.messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((item) => item.type === "image"),
  );
}

async function runOAuthRefreshSelfTest(ModelRuntime, piAi) {
  const providerId = "hitch-oauth-selftest";
  const api = "hitch-oauth-selftest-api";
  const store = new AuditedCredentialStore(
    new MemoryCredentialStore({
      [providerId]: {
        type: "oauth",
        access: "expired-access-sentinel",
        refresh: "refresh-sentinel",
        expires: 0,
      },
    }),
  );
  const faux = piAi.fauxProvider({
    api,
    provider: providerId,
    models: [{ id: "oauth-model", reasoning: false, input: ["text"] }],
  });
  faux.setResponses([piAi.fauxAssistantMessage("oauth-refresh-ok")]);
  let refreshCount = 0;
  const provider = piAi.createProvider({
    id: providerId,
    name: "Hitch OAuth Self-Test",
    auth: {
      oauth: {
        name: "Hitch OAuth Self-Test",
        async login() {
          throw new Error("Login is not part of the refresh self-test.");
        },
        async refresh(credential) {
          refreshCount += 1;
          return {
            ...credential,
            access: "refreshed-access-sentinel",
            expires: Date.now() + 60_000,
          };
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: faux.models,
    api: {
      stream: (...args) => faux.provider.stream(...args),
      streamSimple: (...args) => faux.provider.streamSimple(...args),
    },
  });
  const runtime = await ModelRuntime.create({
    credentials: store,
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(provider);
  const model = runtime.getModel(providerId, "oauth-model");
  if (!model) {
    throw new Error("OAuth self-test model was not registered.");
  }
  const result = await runtime.completeSimple(
    model,
    { messages: [{ role: "user", content: "refresh" }] },
    { maxRetries: 0, maxTokens: 8 },
  );
  if (
    refreshCount !== 1 ||
    store.counts.modify !== 1 ||
    result.stopReason !== "stop"
  ) {
    throw new Error("Injected CredentialStore OAuth refresh self-test failed.");
  }
  return {
    passed: true,
    refreshCount,
    credentialStoreModifyCount: store.counts.modify,
  };
}

async function main() {
  const connection = decodeConfiguration();
  const capability = process.env.HITCH_SPIKE_CAPABILITY;
  if (!capability || capability.length < 32) {
    throw new Error("The sidecar capability is missing or too short.");
  }
  const piPackage = resolvePiPackage();
  const stackDigest = nativeStackDigest(piPackage);
  if (
    connection.piVersion !== REQUIRED_PI_VERSION ||
    connection.nativeStackDigest !== stackDigest
  ) {
    throw new Error("The configured Pi native stack revision does not match.");
  }

  const httpDispatcherModule = await import(
    pathToFileURL(
      join(piPackage.packageRoot, "dist", "core", "http-dispatcher.js"),
    )
  );
  httpDispatcherModule.configureHttpDispatcher();
  const fetchAudit = installFetchGuard(connection.allowedOrigins);
  let egressGuardSelfTest = false;
  try {
    await fetch("http://127.0.0.1:1/forbidden");
  } catch (error) {
    egressGuardSelfTest =
      error instanceof Error &&
      error.message.includes("Egress origin is not registered");
  }
  if (!egressGuardSelfTest) {
    throw new Error("The sidecar egress guard did not fail closed.");
  }

  const { codingAgent, piAi } = await loadPiModules(piPackage);
  const authStorageModule = await import(
    pathToFileURL(
      join(piPackage.packageRoot, "dist", "core", "auth-storage.js"),
    )
  );
  const baseCredentialStore =
    connection.runtimeMode === "builtin"
      ? authStorageModule.AuthStorage.create(process.env.HITCH_SPIKE_AUTH_PATH)
      : new MemoryCredentialStore();
  const credentials = new AuditedCredentialStore(baseCredentialStore);
  const runtime = await codingAgent.ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });

  if (connection.runtimeMode === "faux") {
    const faux = piAi.fauxProvider({
      api: "hitch-native-faux-v1",
      provider: connection.providerId,
      models: [
        {
          id: connection.modelId,
          name: "Hitch Native Sidecar Faux",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: connection.maximumOutputTokens,
        },
      ],
      tokensPerSecond: 20,
      tokenSize: { min: 1, max: 2 },
    });
    const responseFactory = (context, options) => {
      if (options?.maxRetries !== 0) {
        throw new Error("The sidecar did not force maxRetries to zero.");
      }
      const prompt = context.messages.map(textOfUserMessage).join("\n");
      if (prompt.includes("SPIKE_EVENT_MATRIX")) {
        return piAi.fauxAssistantMessage(
          [
            piAi.fauxThinking("deterministic-thinking"),
            piAi.fauxText(
              hasImage(context)
                ? "image-and-stream-ok"
                : "stream-ok",
            ),
            piAi.fauxToolCall(
              "read",
              { path: "README.md" },
              { id: "tool:spike-read" },
            ),
          ],
          { stopReason: "toolUse" },
        );
      }
      if (prompt.includes("SPIKE_CANCEL")) {
        return piAi.fauxAssistantMessage(
          `cancel-me-${"slow-stream-".repeat(80)}`,
        );
      }
      if (prompt.includes("SPIKE_ERROR")) {
        return piAi.fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "deterministic-provider-error",
        });
      }
      return piAi.fauxAssistantMessage("HITCH_NATIVE_BRIDGE_OK");
    };
    faux.setResponses(Array.from({ length: 32 }, () => responseFactory));
    runtime.registerNativeProvider(faux.provider);
  }

  const model = runtime.getModel(connection.providerId, connection.modelId);
  if (!model) {
    throw new Error(
      `The pinned native model is unavailable: ${connection.providerId}/${connection.modelId}`,
    );
  }
  const modelOrigin = model.baseUrl ? new URL(model.baseUrl).origin : undefined;
  if (
    connection.runtimeMode === "builtin" &&
    modelOrigin &&
    !connection.allowedOrigins.includes(modelOrigin)
  ) {
    throw new Error(`The model origin is not registered: ${modelOrigin}`);
  }
  if (model.api !== connection.expectedApi) {
    throw new Error(
      `The model API changed: expected ${connection.expectedApi}, found ${model.api}.`,
    );
  }

  const modelManifest = publicModelManifest(model);
  const catalogDigest = digestJson({
    piVersion: piPackage.version,
    nativeStackDigest: stackDigest,
    connectionId: connection.connectionId,
    allowedOrigins: connection.allowedOrigins,
    model: modelManifest,
  });
  const oauthRefreshSelfTest = await runOAuthRefreshSelfTest(
    codingAgent.ModelRuntime,
    piAi,
  );
  const credentialMetadata = await credentials.list();
  const selectedCredential = credentialMetadata.find(
    (entry) => entry.providerId === connection.providerId,
  );

  const usedRequestIds = new Set();
  const usedRequestFingerprints = new Set();
  const activeRequests = new Map();
  const server = net.createServer((socket) => {
    let buffer = "";
    const socketRequests = new Set();
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        socket.destroy(new Error("Bridge request exceeded the line limit."));
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
          rejection(socket, undefined, "invalid-json", "Invalid bridge JSON.");
          continue;
        }
        if (message.type === "cancel") {
          if (
            message.protocolVersion === 1 &&
            typeof message.requestId === "string"
          ) {
            activeRequests.get(message.requestId)?.abort();
          }
          continue;
        }
        void handleInvocation(socket, message).catch(() => {
          rejection(
            socket,
            message?.requestId,
            "sidecar-failure",
            "The native sidecar failed the request.",
          );
        });
      }
    });
    socket.on("close", () => {
      for (const requestId of socketRequests) {
        activeRequests.get(requestId)?.abort();
      }
    });

    async function handleInvocation(client, request) {
      const requestId =
        typeof request?.requestId === "string" ? request.requestId : undefined;
      if (
        !request ||
        typeof request !== "object" ||
        !strictKeys(
          request,
          new Set([
            "protocolVersion",
            "type",
            "capability",
            "requestId",
            "turnId",
            "connectionId",
            "catalogDigest",
            "providerId",
            "modelId",
            "context",
            "options",
          ]),
        ) ||
        request.protocolVersion !== 1 ||
        request.type !== "invoke" ||
        !requestId
      ) {
        rejection(client, requestId, "invalid-envelope", "Invalid bridge envelope.");
        return;
      }
      if (!capabilityMatches(request.capability, capability)) {
        rejection(client, requestId, "unauthorized", "Bridge authorization failed.");
        return;
      }
      if (
        request.turnId !== connection.turnId ||
        request.connectionId !== connection.connectionId ||
        request.catalogDigest !== catalogDigest ||
        request.providerId !== connection.providerId ||
        request.modelId !== connection.modelId
      ) {
        rejection(
          client,
          requestId,
          "connection-mismatch",
          "Bridge connection or model mismatch.",
        );
        return;
      }
      if (
        !validateContext(request.context) ||
        !validateOptions(request.options, connection.maximumOutputTokens)
      ) {
        rejection(
          client,
          requestId,
          "invalid-native-request",
          "Invalid structured native request.",
        );
        return;
      }

      const requestFingerprint = digestJson({
        turnId: request.turnId,
        connectionId: request.connectionId,
        catalogDigest: request.catalogDigest,
        providerId: request.providerId,
        modelId: request.modelId,
        context: request.context,
        options: request.options,
      });
      if (
        usedRequestIds.has(requestId) ||
        usedRequestFingerprints.has(requestFingerprint)
      ) {
        rejection(client, requestId, "replay", "Bridge request replay denied.");
        return;
      }
      usedRequestIds.add(requestId);
      usedRequestFingerprints.add(requestFingerprint);
      const controller = new AbortController();
      activeRequests.set(requestId, controller);
      socketRequests.add(requestId);
      const fetchStart = fetchAudit.length;
      const credentialStart = credentials.snapshot();
      let payloadCount = 0;
      let responseCount = 0;
      try {
        const nativeStream = runtime.streamSimple(model, request.context, {
          maxTokens:
            request.options.maxTokens ?? connection.maximumOutputTokens,
          ...(request.options.reasoning
            ? { reasoning: request.options.reasoning }
            : {}),
          ...(request.options.sessionId
            ? { sessionId: request.options.sessionId }
            : {}),
          ...(request.options.cacheRetention
            ? { cacheRetention: request.options.cacheRetention }
            : {}),
          signal: controller.signal,
          maxRetries: 0,
          transport: "sse",
          onPayload(payload) {
            payloadCount += 1;
            if (
              payload &&
              typeof payload === "object" &&
              "model" in payload &&
              payload.model !== connection.modelId
            ) {
              throw new Error("Native provider payload changed the pinned model.");
            }
          },
          onResponse() {
            responseCount += 1;
          },
        });
        for await (const event of nativeStream) {
          const outboundEvent =
            event.type === "error"
              ? {
                  ...event,
                  error: {
                    ...event.error,
                    errorMessage: `${event.error.errorMessage ?? "Provider error"} [hitch-spike-egress=${JSON.stringify(fetchAudit.slice(fetchStart))}]`,
                  },
                }
              : event;
          send(client, {
            protocolVersion: 1,
            type: "event",
            requestId,
            event: outboundEvent,
          });
        }
        const result = await nativeStream.result();
        const credentialEnd = credentials.snapshot();
        send(client, {
          protocolVersion: 1,
          type: "complete",
          requestId,
          result,
          observation: {
            maxRetries: 0,
            transport: "sse",
            payloadCount,
            responseCount,
            usage: usageOf(result),
            credentialOperations: Object.fromEntries(
              Object.keys(credentialEnd).map((key) => [
                key,
                credentialEnd[key] - credentialStart[key],
              ]),
            ),
            egress: fetchAudit.slice(fetchStart),
          },
        });
      } finally {
        activeRequests.delete(requestId);
        socketRequests.delete(requestId);
      }
    }
  });

  if (existsSync(connection.socketPath)) {
    rmSync(connection.socketPath);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(connection.socketPath, resolve);
  });

  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      protocolVersion: 1,
      pid: process.pid,
      socketName: basename(connection.socketPath),
      piVersion: piPackage.version,
      nativeStackDigest: stackDigest,
      catalogDigest,
      turnId: connection.turnId,
      connectionId: connection.connectionId,
      model: modelManifest,
      allowedOrigins: connection.allowedOrigins,
      credentialType: selectedCredential?.type ?? null,
      egressGuardSelfTest,
      oauthRefreshSelfTest,
    })}\n`,
  );

  const shutdown = () => {
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
    server.close(() => {
      if (existsSync(connection.socketPath)) {
        rmSync(connection.socketPath);
      }
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

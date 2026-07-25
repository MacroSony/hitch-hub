import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  invokeBridge,
  requestEnvelope,
} from "./bridge-client.mjs";
import {
  loadPiModules,
  nativeStackDigest,
  resolvePiPackage,
} from "./pi-package.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SIDECAR_PATH = join(HERE, "sidecar.mjs");
const EXTENSION_SANDBOX_PATH =
  "/workspace/spikes/pi-native-sidecar/bridge-extension.mjs";

const TARGETS = {
  faux: {
    runtimeMode: "faux",
    connectionId: "pi-native-faux-v1",
    providerId: "hitch-native-spike",
    modelId: "faux-1",
    expectedApi: "hitch-native-faux-v1",
    allowedOrigins: ["https://allowed.example"],
    maximumOutputTokens: 128,
  },
  deepseek: {
    runtimeMode: "builtin",
    connectionId: "pi-native-deepseek-v1",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    expectedApi: "openai-completions",
    allowedOrigins: ["https://api.deepseek.com"],
    maximumOutputTokens: 512,
  },
  "openai-codex": {
    runtimeMode: "builtin",
    connectionId: "pi-native-openai-codex-v1",
    providerId: "openai-codex",
    modelId: "gpt-5.4-mini",
    expectedApi: "openai-codex-responses",
    allowedOrigins: [
      "https://chatgpt.com",
      "https://auth.openai.com",
    ],
    maximumOutputTokens: 128,
  },
};

function parseArgs(argv) {
  const result = { real: false, realTargets: ["deepseek", "openai-codex"] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--real") {
      result.real = true;
      continue;
    }
    if (argument === "--provider") {
      const provider = argv[index + 1];
      if (!["deepseek", "openai-codex", "all"].includes(provider)) {
        throw new Error(
          "--provider must be deepseek, openai-codex, or all.",
        );
      }
      result.real = true;
      result.realTargets =
        provider === "all"
          ? ["deepseek", "openai-codex"]
          : [provider];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function waitForLine(child, predicate, timeoutMs, stderr) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) {
          continue;
        }
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (predicate(value)) {
          finish(resolvePromise, value);
          return;
        }
      }
    };
    const onError = (error) => finish(rejectPromise, error);
    const onExit = (code, signal) =>
      finish(
        rejectPromise,
        new Error(
          `Process exited before readiness: code=${code ?? ""} signal=${signal ?? ""} stderr=${stderr()}`,
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          rejectPromise,
          new Error(`Timed out waiting for process output. stderr=${stderr()}`),
        ),
      timeoutMs,
    );
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    const giveUp = setTimeout(resolvePromise, 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      clearTimeout(giveUp);
      resolvePromise();
    });
  });
}

async function startSidecar({
  target,
  scratch,
  capability,
  piPackage,
  authPath,
}) {
  const bridgeDirectory = join(scratch, "bridge");
  mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(bridgeDirectory, "sidecar.sock");
  const connection = {
    protocolVersion: 1,
    ...target,
    socketPath,
    turnId: randomUUID(),
    piVersion: piPackage.version,
    nativeStackDigest: nativeStackDigest(piPackage),
  };
  let stderr = "";
  const child = spawn(
    process.execPath,
    ["--use-env-proxy", SIDECAR_PATH],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        HITCH_PI_COMMAND: piPackage.executable,
        HITCH_SPIKE_CAPABILITY: capability,
        HITCH_SPIKE_CONNECTION_B64: Buffer.from(
          JSON.stringify(connection),
        ).toString("base64url"),
        ...(target.runtimeMode === "builtin"
          ? { HITCH_SPIKE_AUTH_PATH: authPath }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
  });
  const ready = await waitForLine(
    child,
    (value) => value?.type === "ready",
    30_000,
    () => stderr,
  );
  return { child, ready, socketPath, bridgeDirectory, stderr: () => stderr };
}

async function runNativeStackMismatchCheck(piPackage) {
  const scratch = mkdtempSync(
    join(os.tmpdir(), "hitch-pi-sidecar-stack-mismatch-"),
  );
  const bridgeDirectory = join(scratch, "bridge");
  mkdirSync(bridgeDirectory, { recursive: true, mode: 0o700 });
  const connection = {
    protocolVersion: 1,
    ...TARGETS.faux,
    socketPath: join(bridgeDirectory, "sidecar.sock"),
    turnId: randomUUID(),
    piVersion: piPackage.version,
    nativeStackDigest: `sha256:${"0".repeat(64)}`,
  };
  let stderr = "";
  const child = spawn(
    process.execPath,
    ["--use-env-proxy", SIDECAR_PATH],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        HITCH_PI_COMMAND: piPackage.executable,
        HITCH_SPIKE_CAPABILITY: randomBytes(32).toString("base64url"),
        HITCH_SPIKE_CONNECTION_B64: Buffer.from(
          JSON.stringify(connection),
        ).toString("base64url"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
  });
  try {
    const exit = await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(
          new Error("The mismatched native stack sidecar did not fail closed."),
        );
      }, 10_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    });
    if (
      exit.code === 0 ||
      !stderr.includes("native stack revision does not match")
    ) {
      throw new Error(
        `The sidecar accepted a mismatched native stack: code=${exit.code ?? ""} signal=${exit.signal ?? ""}`,
      );
    }
    return true;
  } finally {
    await stopChild(child);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function baseRequest(ready, capability, context, options = {}) {
  return requestEnvelope({
    capability,
    turnId: ready.turnId,
    connectionId: ready.connectionId,
    catalogDigest: ready.catalogDigest,
    providerId: ready.model.provider,
    modelId: ready.model.id,
    requestId: randomUUID(),
    context,
    options,
  });
}

async function expectRejected(promise, expectedCode) {
  try {
    await promise;
  } catch (error) {
    if (error?.code === expectedCode) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected bridge rejection: ${expectedCode}`);
}

async function runDeterministicBridgeChecks(sidecar, capability) {
  const matrixRequest = baseRequest(
    sidecar.ready,
    capability,
    {
      systemPrompt: "Exercise the native bridge event protocol.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "SPIKE_EVENT_MATRIX" },
            {
              type: "image",
              mimeType: "image/png",
              data: Buffer.from("not-a-real-image").toString("base64"),
            },
          ],
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read one file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
    },
    {
      maxTokens: 96,
      reasoning: "low",
      cacheRetention: "none",
      sessionId: "deterministic-event-matrix",
    },
  );
  const matrix = await invokeBridge({
    socketPath: sidecar.socketPath,
    request: matrixRequest,
  });
  const eventTypes = new Set(matrix.events.map((event) => event.type));
  for (const required of [
    "start",
    "thinking_delta",
    "text_delta",
    "toolcall_delta",
    "done",
  ]) {
    if (!eventTypes.has(required)) {
      throw new Error(`Native bridge did not preserve ${required}.`);
    }
  }
  if (
    matrix.result.stopReason !== "toolUse" ||
    matrix.observation.maxRetries !== 0 ||
    matrix.observation.transport !== "sse" ||
    matrix.observation.usage?.totalTokens <= 0
  ) {
    throw new Error("Native bridge result/usage/retry evidence is incomplete.");
  }

  await expectRejected(
    invokeBridge({
      socketPath: sidecar.socketPath,
      request: matrixRequest,
    }),
    "replay",
  );
  await expectRejected(
    invokeBridge({
      socketPath: sidecar.socketPath,
      request: { ...matrixRequest, requestId: randomUUID() },
    }),
    "replay",
  );

  const mismatchedCapability = baseRequest(
    sidecar.ready,
    randomBytes(32).toString("base64url"),
    { messages: [{ role: "user", content: "capability mismatch" }] },
  );
  await expectRejected(
    invokeBridge({
      socketPath: sidecar.socketPath,
      request: mismatchedCapability,
    }),
    "unauthorized",
  );

  const turnMismatch = {
    ...baseRequest(sidecar.ready, capability, {
      messages: [{ role: "user", content: "turn mismatch" }],
    }),
    turnId: randomUUID(),
  };
  await expectRejected(
    invokeBridge({ socketPath: sidecar.socketPath, request: turnMismatch }),
    "connection-mismatch",
  );

  const connectionMismatch = {
    ...baseRequest(sidecar.ready, capability, {
      messages: [{ role: "user", content: "connection mismatch" }],
    }),
    connectionId: "request-selected-connection",
  };
  await expectRejected(
    invokeBridge({
      socketPath: sidecar.socketPath,
      request: connectionMismatch,
    }),
    "connection-mismatch",
  );

  const catalogMismatch = {
    ...baseRequest(sidecar.ready, capability, {
      messages: [{ role: "user", content: "catalog mismatch" }],
    }),
    catalogDigest: "sha256:request-selected-catalog",
  };
  await expectRejected(
    invokeBridge({ socketPath: sidecar.socketPath, request: catalogMismatch }),
    "connection-mismatch",
  );

  const modelMismatch = {
    ...baseRequest(sidecar.ready, capability, {
      messages: [{ role: "user", content: "model mismatch" }],
    }),
    modelId: "request-selected-model",
  };
  await expectRejected(
    invokeBridge({ socketPath: sidecar.socketPath, request: modelMismatch }),
    "connection-mismatch",
  );

  const originOverride = {
    ...baseRequest(
      sidecar.ready,
      capability,
      { messages: [{ role: "user", content: "origin override" }] },
    ),
    origin: "https://attacker.invalid",
  };
  await expectRejected(
    invokeBridge({
      socketPath: sidecar.socketPath,
      request: originOverride,
    }),
    "invalid-envelope",
  );

  const hiddenRetry = baseRequest(
    sidecar.ready,
    capability,
    { messages: [{ role: "user", content: "hidden retry" }] },
    { maxRetries: 2 },
  );
  await expectRejected(
    invokeBridge({ socketPath: sidecar.socketPath, request: hiddenRetry }),
    "invalid-native-request",
  );

  const cancellation = await invokeBridge({
    socketPath: sidecar.socketPath,
    request: baseRequest(
      sidecar.ready,
      capability,
      { messages: [{ role: "user", content: "SPIKE_CANCEL" }] },
      { maxTokens: 96 },
    ),
    cancelAfterEvent: (event) => event.type === "text_delta",
  });
  if (cancellation.result.stopReason !== "aborted") {
    throw new Error("Native bridge cancellation did not reach ModelRuntime.");
  }

  const providerError = await invokeBridge({
    socketPath: sidecar.socketPath,
    request: baseRequest(
      sidecar.ready,
      capability,
      { messages: [{ role: "user", content: "SPIKE_ERROR" }] },
      { maxTokens: 32 },
    ),
  });
  if (
    providerError.result.stopReason !== "error" ||
    providerError.result.errorMessage !== "deterministic-provider-error" ||
    !providerError.events.some((event) => event.type === "error")
  ) {
    throw new Error("Native bridge provider error propagation is incomplete.");
  }

  if (
    sidecar.ready.egressGuardSelfTest !== true ||
    sidecar.ready.oauthRefreshSelfTest?.passed !== true ||
    sidecar.ready.oauthRefreshSelfTest?.refreshCount !== 1
  ) {
    throw new Error("Sidecar egress/OAuth self-tests did not pass.");
  }

  return {
    eventTypes: [...eventTypes].sort(),
    usage: matrix.observation.usage,
    replayDenied: true,
    semanticReplayDenied: true,
    capabilityMismatchDenied: true,
    turnMismatchDenied: true,
    connectionMismatchDenied: true,
    catalogMismatchDenied: true,
    modelMismatchDenied: true,
    originOverrideDenied: true,
    hiddenRetryDenied: true,
    cancellation: cancellation.result.stopReason,
    providerError: providerError.result.stopReason,
    oauthRefresh: sidecar.ready.oauthRefreshSelfTest,
  };
}

function addScaffolding(args, destination) {
  const parts = resolve(destination).split("/").filter(Boolean);
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`;
    if (!["/usr", "/bin", "/lib", "/lib64"].includes(current)) {
      args.push("--dir", current);
    }
  }
}

function workerEnvironment({
  capability,
  ready,
  authPath,
}) {
  const manifest = {
    protocolVersion: 1,
    turnId: ready.turnId,
    connectionId: ready.connectionId,
    catalogDigest: ready.catalogDigest,
    providerId: ready.model.provider,
    model: ready.model,
    maximumOutputTokens:
      TARGETS[
        ready.model.provider === "hitch-native-spike"
          ? "faux"
          : ready.model.provider
      ].maximumOutputTokens,
  };
  return {
    PATH: process.env.PATH,
    HOME: "/tmp/hitch-worker-home",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    PI_CODING_AGENT_DIR: "/agent-config",
    PI_CODING_AGENT_SESSION_DIR: "/agent-sessions",
    PI_OFFLINE: "1",
    HITCH_SPIKE_CAPABILITY: capability,
    HITCH_SPIKE_SOCKET: "/hitch/sidecar.sock",
    HITCH_SPIKE_MODEL_MANIFEST_B64: Buffer.from(
      JSON.stringify(manifest),
    ).toString("base64url"),
    HITCH_SPIKE_FORBIDDEN_AUTH_PATH: authPath,
  };
}

function buildWorkerSpawn({
  piPackage,
  scratch,
  bridgeDirectory,
  capability,
  ready,
  authPath,
  real,
}) {
  const agentConfig = join(scratch, "worker-agent");
  const agentSessions = join(scratch, "worker-sessions");
  mkdirSync(agentConfig, { recursive: true });
  mkdirSync(agentSessions, { recursive: true });
  const bwrapArgs = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--disable-userns",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--unshare-net",
    "--hostname",
    "hitch-sidecar-spike-worker",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/ca-certificates",
    "/etc/ca-certificates",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind-try",
    "/etc/group",
    "/etc/group",
  ];
  addScaffolding(bwrapArgs, piPackage.runtimeRoot);
  bwrapArgs.push(
    "--ro-bind",
    piPackage.runtimeRoot,
    piPackage.runtimeRoot,
    "--dir",
    "/workspace",
    "--ro-bind",
    REPO_ROOT,
    "/workspace",
    "--dir",
    "/hitch",
    "--bind",
    bridgeDirectory,
    "/hitch",
    "--dir",
    "/agent-config",
    "--bind",
    agentConfig,
    "/agent-config",
    "--dir",
    "/agent-sessions",
    "--bind",
    agentSessions,
    "/agent-sessions",
    "--chdir",
    "/workspace",
    "--",
    piPackage.executable,
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--extension",
    EXTENSION_SANDBOX_PATH,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--no-approve",
    "--offline",
    "--provider",
    ready.model.provider,
    "--model",
    ready.model.id,
    "--thinking",
    real ? "off" : "low",
    "--system-prompt",
    "Reply briefly and do not use tools.",
  );
  return {
    command: "/usr/bin/bwrap",
    args: bwrapArgs,
    env: workerEnvironment({ capability, ready, authPath }),
  };
}

async function runPiWorker(options) {
  const spec = buildWorkerSpawn(options);
  let stderr = "";
  const child = spawn(spec.command, spec.args, {
    cwd: REPO_ROOT,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12_000);
  });
  const lines = [];
  let buffer = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) {
        continue;
      }
      try {
        const value = JSON.parse(line);
        lines.push(value);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(value)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(value);
          }
        }
      } catch {
        // Pi RPC stdout should be JSONL; non-JSON startup text is ignored.
      }
    }
  });
  const waitFor = (predicate, timeoutMs) =>
    new Promise((resolvePromise, rejectPromise) => {
      const existing = lines.find(predicate);
      if (existing) {
        resolvePromise(existing);
        return;
      }
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          rejectPromise(
            new Error(`Timed out waiting for Pi RPC. stderr=${stderr}`),
          );
        }, timeoutMs),
      };
      waiters.push(waiter);
    });

  try {
    child.stdin.write(
      `${JSON.stringify({
        id: "sidecar-spike-prompt",
        type: "prompt",
        message: options.real
          ? "Reply with exactly: HITCH_NATIVE_REAL_OK"
          : "Reply with the deterministic bridge response.",
      })}\n`,
    );
    const accepted = await waitFor(
      (value) =>
        value.type === "response" &&
        value.id === "sidecar-spike-prompt",
      options.real ? 120_000 : 30_000,
    );
    if (accepted.success !== true) {
      throw new Error(`Pi rejected the spike prompt: ${accepted.error}`);
    }
    await waitFor(
      (value) => value.type === "agent_settled",
      options.real ? 120_000 : 30_000,
    );
    child.stdin.write(
      `${JSON.stringify({
        id: "sidecar-spike-last-text",
        type: "get_last_assistant_text",
      })}\n`,
    );
    const lastTextResponse = await waitFor(
      (value) =>
        value.type === "response" &&
        value.id === "sidecar-spike-last-text",
      10_000,
    );
    const text = lastTextResponse.data?.text;
    const diagnostics = collectPiDiagnostics(lines);
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      (!options.real && !text.includes("HITCH_NATIVE_BRIDGE_OK"))
    ) {
      throw new Error(
        `Pi did not receive the sidecar's assistant response. diagnostics=${JSON.stringify(diagnostics)}`,
      );
    }
    const errorEvents = lines.filter(
      (value) =>
        value.type === "message_update" &&
        value.assistantMessageEvent?.type === "error",
    );
    if (errorEvents.length > 0) {
      throw new Error("Pi emitted a provider error through the sidecar.");
    }
    return {
      accepted: true,
      settled: true,
      textLength: text.length,
      eventCount: lines.filter((value) => value.type !== "response").length,
      workerNetwork: "bubblewrap-unshared",
      workerAuthStoreVisible: false,
    };
  } finally {
    await stopChild(child);
  }
}

function collectPiDiagnostics(lines) {
  const stopReasons = new Set();
  const contentTypes = new Set();
  const errors = new Set();
  const visit = (value, key) => {
    if (typeof value === "string") {
      if (key === "stopReason") {
        stopReasons.add(value);
      } else if (key === "errorMessage" || key === "error") {
        errors.add(redactDiagnostic(value));
      } else if (
        key === "type" &&
        [
          "text",
          "thinking",
          "toolCall",
          "text_delta",
          "thinking_delta",
          "toolcall_delta",
        ].includes(value)
      ) {
        contentTypes.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  };
  visit(lines);
  return {
    stopReasons: [...stopReasons],
    contentTypes: [...contentTypes],
    errors: [...errors].slice(0, 4),
  };
}

function redactDiagnostic(value) {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted-key]")
    .replace(
      /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/gu,
      "[redacted-token]",
    )
    .slice(0, 500);
}

async function runTarget({
  name,
  target,
  piPackage,
  authPath,
  deterministic,
}) {
  const scratch = mkdtempSync(
    join(os.tmpdir(), `hitch-pi-sidecar-${name}-`),
  );
  const capability = randomBytes(32).toString("base64url");
  let sidecar;
  try {
    sidecar = await startSidecar({
      target,
      scratch,
      capability,
      piPackage,
      authPath,
    });
    if (sidecar.ready.piVersion !== piPackage.version) {
      throw new Error("Sidecar reported the wrong Pi version.");
    }
    if (
      target.runtimeMode === "builtin" &&
      sidecar.ready.credentialType === null
    ) {
      throw new Error(`No saved credential metadata for ${name}.`);
    }
    const direct = deterministic
      ? await runDeterministicBridgeChecks(sidecar, capability)
      : undefined;
    const worker = await runPiWorker({
      piPackage,
      scratch,
      bridgeDirectory: sidecar.bridgeDirectory,
      capability,
      ready: sidecar.ready,
      authPath,
      real: !deterministic,
    });
    return {
      provider: name,
      piVersion: sidecar.ready.piVersion,
      nativeStackDigest: sidecar.ready.nativeStackDigest,
      catalogDigest: sidecar.ready.catalogDigest,
      model: `${sidecar.ready.model.provider}/${sidecar.ready.model.id}`,
      api: sidecar.ready.model.api,
      credentialType: sidecar.ready.credentialType,
      allowedOrigins: sidecar.ready.allowedOrigins,
      egressGuardSelfTest: sidecar.ready.egressGuardSelfTest,
      oauthRefreshSelfTest: sidecar.ready.oauthRefreshSelfTest,
      direct,
      worker,
    };
  } finally {
    if (sidecar) {
      await stopChild(sidecar.child);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync("/usr/bin/bwrap")) {
    throw new Error("Bubblewrap is required for the Pi worker isolation proof.");
  }
  const piPackage = resolvePiPackage();
  const { codingAgent } = await loadPiModules(piPackage);
  const authPath = join(codingAgent.getAgentDir(), "auth.json");
  const nativeStackMismatchDenied =
    await runNativeStackMismatchCheck(piPackage);

  const results = [];
  results.push(
    await runTarget({
      name: "faux",
      target: TARGETS.faux,
      piPackage,
      authPath,
      deterministic: true,
    }),
  );
  if (args.real) {
    for (const name of args.realTargets) {
      results.push(
        await runTarget({
          name,
          target: TARGETS[name],
          piPackage,
          authPath,
          deterministic: false,
        }),
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      realProviderCalls: args.real,
      nativeStackMismatchDenied,
      results,
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

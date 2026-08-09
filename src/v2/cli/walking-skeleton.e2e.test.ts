import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import test from "node:test";

import { TEST_CLIENT_CERTIFICATE_PEM } from "../connectors/remote/test-certificates.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import {
  WalkingSkeletonConfigurationError,
  loadWalkingSkeletonStartupConfiguration,
} from "./configuration.js";

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function writeConfiguration(
  path: string,
  dataRoot: string,
  workspaceRoot: string,
  extra = "",
): void {
  writeFileSync(
    path,
    [
      "version: 1",
      "mode: development-walking-skeleton",
      `dataRoot: ${JSON.stringify(dataRoot)}`,
      `workspaceRoot: ${JSON.stringify(workspaceRoot)}`,
      'bootstrapPublishedAt: "2026-07-30T12:00:00.000Z"',
      extra,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function runCli(args: readonly string[]): Promise<ProcessResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/v2/main.ts", ...args],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const [code] = await once(child, "exit") as [number];
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function startDaemon(configPath: string): Promise<{
  readonly child: ReturnType<typeof spawn>;
  readonly ready: Readonly<Record<string, unknown>>;
  stop(): Promise<void>;
}> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/v2/main.ts",
      "serve",
      "--config",
      configPath,
      "--development-walking-skeleton",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const ready = await new Promise<Readonly<Record<string, unknown>>>(
    (resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => {
        reject(new Error(`v2 daemon did not become ready: ${stderr}`));
        child.kill("SIGKILL");
      }, 10_000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(output.slice(0, newline)) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`v2 daemon exited early (${code}): ${stderr}`));
      });
      child.once("error", reject);
    },
  );
  return {
    child,
    ready,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

function firstOutcome(result: ProcessResult): Record<string, unknown> {
  assert.equal(result.code, 0, result.stderr);
  const line = result.stdout.trim().split("\n")[0];
  assert.ok(line !== undefined && line.length > 0);
  return JSON.parse(line) as Record<string, unknown>;
}

test("trusted walking-skeleton configuration rejects mutation, symlinks, and production mode", async () => {
  await withDisposableDataRoot(async (root) => {
    const workspace = root.resolve("workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const path = root.resolve("v2.yaml");
    writeConfiguration(path, root.resolve("state"), workspace);
    assert.deepEqual(loadWalkingSkeletonStartupConfiguration(path), {
      version: 1,
      mode: "development-walking-skeleton",
      dataRoot: root.resolve("state"),
      workspaceRoot: workspace,
      bootstrapPublishedAt: "2026-07-30T12:00:00.000Z",
    });

    chmodSync(path, 0o622);
    assert.throws(
      () => loadWalkingSkeletonStartupConfiguration(path),
      WalkingSkeletonConfigurationError,
    );
    chmodSync(path, 0o600);
    const link = root.resolve("linked.yaml");
    symlinkSync(path, link);
    assert.throws(
      () => loadWalkingSkeletonStartupConfiguration(link),
      WalkingSkeletonConfigurationError,
    );
    writeConfiguration(
      path,
      root.resolve("state"),
      workspace,
      "unexpected: true",
    );
    assert.throws(
      () => loadWalkingSkeletonStartupConfiguration(path),
      WalkingSkeletonConfigurationError,
    );
  });
});

test("[V2-S04/two-process-cli-idempotency] separate daemon and CLI preserve restart, query, idempotency, and FIFO", { timeout: 60_000 }, async () => {
  await withDisposableDataRoot(async (root) => {
    const workspace = root.resolve("workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const configPath = root.resolve("v2.yaml");
    writeConfiguration(configPath, root.resolve("state"), workspace);

    const deniedProduction = await runCli([
      "serve",
      "--config",
      configPath,
    ]);
    assert.equal(deniedProduction.code, 2);
    assert.match(deniedProduction.stderr, /production v2 startup is unavailable/u);

    let daemon = await startDaemon(configPath);
    assert.equal(daemon.ready.status, "ready");
    assert.equal(daemon.ready.mode, "development-walking-skeleton");
    let sessionId: string;
    let firstTurnId: string;
    try {
      const created = firstOutcome(await runCli([
        "session",
        "create",
        "--config",
        configPath,
        "--profile",
        "pi-openai-codex-v1",
        "--workspace",
        "workspace-v1",
        "--name",
        "CLI skeleton",
      ]));
      assert.equal(created.status, "succeeded");
      const createdResult = created.result as Record<string, unknown>;
      sessionId = String(createdResult.sessionId);

      const submitted = firstOutcome(await runCli([
        "prompt",
        "--config",
        configPath,
        "--session-id",
        sessionId,
        "--idempotency-key",
        "stable-key-1",
        "First durable prompt",
      ]));
      assert.equal(submitted.status, "succeeded");
      const submittedResult = submitted.result as Record<string, unknown>;
      assert.equal(submittedResult.status, "starting");
      firstTurnId = String(submittedResult.turnId);

      const shown = firstOutcome(await runCli([
        "turn",
        "show",
        "--config",
        configPath,
        firstTurnId,
      ]));
      assert.equal(shown.status, "succeeded");
      assert.equal(
        (shown.result as Record<string, unknown>).state,
        "dispatching",
      );
    } finally {
      await daemon.stop();
    }

    daemon = await startDaemon(configPath);
    try {
      const replayed = firstOutcome(await runCli([
        "prompt",
        "--config",
        configPath,
        "--session-id",
        sessionId!,
        "--idempotency-key",
        "stable-key-1",
        "First durable prompt",
      ]));
      const replayResult = replayed.result as Record<string, unknown>;
      assert.equal(replayResult.turnId, firstTurnId!);
      assert.equal(replayResult.status, "starting");

      for (let index = 2; index <= 4; index += 1) {
        const queued = firstOutcome(await runCli([
          "prompt",
          "--config",
          configPath,
          "--session-id",
          sessionId!,
          "--idempotency-key",
          `stable-key-${index}`,
          `Queued prompt ${index}`,
        ]));
        const result = queued.result as Record<string, unknown>;
        assert.equal(result.status, "queued");
        assert.equal(result.position, index - 1);
      }

      const full = await runCli([
        "prompt",
        "--config",
        configPath,
        "--session-id",
        sessionId!,
        "--idempotency-key",
        "stable-key-5",
        "Queue overflow",
      ]);
      assert.equal(full.code, 2);
      assert.deepEqual(JSON.parse(full.stdout.trim()), {
        status: "rejected",
        code: "queue-capacity-exceeded",
      });

      const shownAfterRestart = firstOutcome(await runCli([
        "turn",
        "show",
        "--config",
        configPath,
        firstTurnId!,
      ]));
      assert.equal(
        (shownAfterRestart.result as Record<string, unknown>).state,
        "dispatching",
      );
    } finally {
      await daemon.stop();
    }
  });
});

test("local CLI provisions, disables, binds, and revokes one static remote principal without opening SQLite", { timeout: 30_000 }, async () => {
  await withDisposableDataRoot(async (root) => {
    const ownerWorkspace = root.resolve("workspace-owner");
    const userWorkspace = root.resolve("workspace-user-b");
    mkdirSync(ownerWorkspace, { mode: 0o700 });
    mkdirSync(userWorkspace, { mode: 0o700 });
    const certificatePath = root.resolve("user-b-cert.pem");
    writeFileSync(certificatePath, TEST_CLIENT_CERTIFICATE_PEM, { mode: 0o600 });
    const configPath = root.resolve("v2.yaml");
    writeConfiguration(
      configPath,
      root.resolve("state"),
      ownerWorkspace,
      "clientCertificateTrustRootId: private-alpha-client-ca-v1",
    );
    assert.equal(
      loadWalkingSkeletonStartupConfiguration(configPath)
        .clientCertificateTrustRootId,
      "private-alpha-client-ca-v1",
    );
    const daemon = await startDaemon(configPath);
    try {
      const created = firstOutcome(await runCli([
        "principal",
        "create",
        "--config",
        configPath,
        "--reference",
        "user-b",
        "--name",
        "User B",
        "--role",
        "member",
        "--workspace",
        "workspace-b",
        "--workspace-root",
        userWorkspace,
      ]));
      assert.equal(created.status, "succeeded");
      assert.equal(
        (created.result as Record<string, unknown>).kind,
        "principal-created",
      );
      const bound = firstOutcome(await runCli([
        "certificate",
        "bind",
        "--config",
        configPath,
        "--principal",
        "user-b",
        "--reference",
        "user-b-cert-v1",
        "--certificate",
        certificatePath,
      ]));
      assert.equal(
        (bound.result as Record<string, unknown>).kind,
        "client-certificate-bound",
      );
      const disabled = firstOutcome(await runCli([
        "principal",
        "disable",
        "--config",
        configPath,
        "--reference",
        "user-b",
      ]));
      assert.equal(
        (disabled.result as Record<string, unknown>).kind,
        "principal-disabled",
      );
      const revoked = firstOutcome(await runCli([
        "certificate",
        "revoke",
        "--config",
        configPath,
        "--reference",
        "user-b-cert-v1",
      ]));
      assert.equal(
        (revoked.result as Record<string, unknown>).kind,
        "client-certificate-revoked",
      );
    } finally {
      await daemon.stop();
    }
  });
});

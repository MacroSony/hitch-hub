import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  compileSecureBubblewrapLauncher,
  compileSupervisorOpenat2Addon,
  loadSecureBubblewrapLauncher,
  loadSupervisorSourceOpener,
  renderEphemeralWorkerCommand,
  type BubblewrapPlanInput,
  type Sha256Digest,
  type VerifiedSandboxMount,
  type VerifiedSandboxSource,
  type VerifiedSecureBubblewrapLauncher,
} from "./index.js";
import {
  EphemeralWorkerSupervisor,
  type LaunchedEphemeralWorker,
} from "../runtime/supervisor/index.js";

interface Fixture {
  readonly root: string;
  readonly id: string;
  readonly workspace: string;
  readonly extension: string;
  readonly extensionDigest: Sha256Digest;
  readonly addon: string;
  readonly addonDigest: Sha256Digest;
  readonly secureLauncherPath: string;
  readonly opener: ReturnType<typeof loadSupervisorSourceOpener>;
  readonly secureLauncher: VerifiedSecureBubblewrapLauncher;
}

function digest(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "hitch-v2-sandbox-"));
  const workspace = join(root, "workspace");
  const extension = join(root, "workspace-tools.mjs");
  const addon = join(root, "workspace-tools.node");
  const openerArtifact = join(root, "supervisor-openat2.node");
  const secureLauncherPath = join(root, "secure-bwrap-launcher");
  const extensionBytes = "reviewed extension";
  const addonBytes = "reviewed addon";
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, "probe.txt"), "anchored workspace", { mode: 0o600 });
  writeFileSync(extension, extensionBytes, { mode: 0o400 });
  writeFileSync(addon, addonBytes, { mode: 0o400 });
  chmodSync(extension, 0o444);
  chmodSync(addon, 0o444);
  const compiledOpener = await compileSupervisorOpenat2Addon({
    compilerPath: "/usr/bin/cc",
    sourcePath: fileURLToPath(
      new URL("./native/supervisor-openat2.c", import.meta.url),
    ),
    outputPath: openerArtifact,
    nodeIncludePath: "/usr/include/node",
  });
  const opener = loadSupervisorSourceOpener({
    artifactPath: openerArtifact,
    expectedArtifactDigest: compiledOpener.artifactDigest,
  });
  const compiledLauncher = await compileSecureBubblewrapLauncher({
    compilerPath: "/usr/bin/cc",
    sourcePath: fileURLToPath(
      new URL("./native/secure-bwrap-launcher.c", import.meta.url),
    ),
    outputPath: secureLauncherPath,
  });
  return {
    root,
    id: basename(root),
    workspace,
    extension,
    extensionDigest: digest(extensionBytes),
    addon,
    addonDigest: digest(addonBytes),
    secureLauncherPath,
    opener,
    secureLauncher: loadSecureBubblewrapLauncher({
      opener,
      artifactPath: secureLauncherPath,
      expectedArtifactDigest: compiledLauncher.artifactDigest,
    }),
  };
}

function mounts(input: Fixture): {
  readonly values: readonly VerifiedSandboxMount[];
  readonly sources: readonly VerifiedSandboxSource[];
} {
  const workspace = input.opener.openDirectory(input.workspace);
  const runtime = input.opener.openDirectory("/usr");
  const extension = input.opener.openReviewedFile(
    input.extension,
    input.extensionDigest,
  );
  const addon = input.opener.openReviewedFile(input.addon, input.addonDigest);
  return {
    values: [
      {
        source: workspace,
        sandboxPath: "/workspace",
        access: "read-write",
        purpose: "workspace",
      },
      {
        source: runtime,
        sandboxPath: "/usr",
        access: "read-only",
        purpose: "runtime",
      },
      {
        source: extension,
        sandboxPath: "/hitch-runtime/workspace-tools.mjs",
        access: "read-only",
        purpose: "workspace-tools-extension",
      },
      {
        source: addon,
        sandboxPath: "/hitch-runtime/workspace-tools.node",
        access: "read-only",
        purpose: "workspace-tools-addon",
      },
    ],
    sources: [workspace, runtime, extension, addon],
  };
}

function plan(
  input: Fixture,
  mountValues: readonly VerifiedSandboxMount[],
  overrides: Partial<BubblewrapPlanInput> = {},
): BubblewrapPlanInput {
  return {
    identity: {
      installationId: `Installation:${input.id}`,
      principalId: "Principal:test",
      sessionId: "Session:test",
      turnId: "Turn:test",
      attemptId: "AgentDispatchAttempt:test",
      workerLeaseId: "WorkerLease:test",
      workerFencingToken: 1,
      containerGeneration: 1,
    },
    limits: {
      wallTimeMilliseconds: 30_000,
      memoryBytes: 268_435_456,
      maximumProcesses: 32,
      temporaryStorageBytes: 8_388_608,
      outputBytes: 65_536,
    },
    mounts: mountValues,
    executableSandboxPath: "/usr/bin/node",
    arguments: ["-e", "setInterval(()=>{},1000)"],
    secureLauncher: input.secureLauncher,
    ...overrides,
  };
}

function closeAll(input: Fixture, sources: readonly VerifiedSandboxSource[]): void {
  for (const source of [input.secureLauncher.source, ...sources]) source.close();
}

function removeFixture(input: Fixture): void {
  rmSync(input.root, { recursive: true, force: true });
}

function exchangeHelper(input: Fixture): string {
  const exchangeHelper = join(input.root, "rename-exchange-test-helper");
  execFileSync("/usr/bin/cc", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    fileURLToPath(
      new URL("./native/rename-exchange.test-helper.c", import.meta.url),
    ),
    "-o",
    exchangeHelper,
  ]);
  return exchangeHelper;
}

function exchangePaths(input: Fixture, left: string, right: string): void {
  execFileSync(exchangeHelper(input), [left, right]);
}

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error("sandbox test deadline exceeded")), milliseconds);
        deadline.unref();
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

async function nextOutput(worker: LaunchedEphemeralWorker): Promise<string> {
  const iterator = worker.process.stdout[Symbol.asyncIterator]();
  const next = await within(iterator.next());
  assert.equal(next.done, false);
  return Buffer.from(next.value).toString("utf8");
}

async function cleanup(
  supervisor: EphemeralWorkerSupervisor,
  worker: LaunchedEphemeralWorker,
): Promise<void> {
  assert.deepEqual(await supervisor.cleanup(worker), {
    status: "confirmed-gone",
    unitName: worker.unitName,
  });
  await within(worker.process.observeExit());
}

test("supervisor opener seals sources and rejects symlink, hardlink, and mutable artifacts", async () => {
  const input = await fixture();
  const opened: VerifiedSandboxSource[] = [];
  try {
    const source = input.opener.openDirectory(input.workspace);
    opened.push(source);
    assert.equal(Object.isFrozen(source), true);
    assert.equal(Reflect.set(source, "fd", input.secureLauncher.source.fd), false);
    assert.throws(() => Object.defineProperty(source, "closed", { value: false }));
    const originalIdentity = `${source.device}:${source.inode}`;
    const moved = join(input.root, "moved-workspace");
    renameSync(input.workspace, moved);
    assert.equal(`${source.device}:${source.inode}`, originalIdentity);
    const linked = join(input.root, "linked-workspace");
    symlinkSync(moved, linked);
    assert.throws(
      () => input.opener.openDirectory(linked),
      /parent resolution failed|secure resolution failed/,
    );
    const parentLink = join(input.root, "parent-link");
    symlinkSync(input.root, parentLink);
    assert.throws(
      () => input.opener.openDirectory(join(parentLink, "moved-workspace")),
      /parent resolution failed|secure resolution failed/,
    );

    const hardlink = join(input.root, "extension-hardlink.mjs");
    linkSync(input.extension, hardlink);
    assert.throws(
      () => input.opener.openReviewedFile(input.extension, input.extensionDigest),
      /single-link/,
    );
    rmSync(hardlink);
    chmodSync(input.extension, 0o644);
    assert.throws(
      () => input.opener.openReviewedFile(input.extension, input.extensionDigest),
      /read-only owner/,
    );
  } finally {
    closeAll(input, opened);
    removeFixture(input);
  }
});

test("source inode and ancestor evidence stay correlated during rename exchange", async () => {
  const input = await fixture();
  const opened: VerifiedSandboxSource[] = [];
  try {
    const left = join(input.root, "exchange-left");
    const right = join(input.root, "exchange-right");
    const bytes = "same reviewed race bytes";
    const expected = digest(bytes);
    mkdirSync(left, { mode: 0o700 });
    mkdirSync(right, { mode: 0o700 });
    writeFileSync(join(left, "artifact"), bytes, { mode: 0o444 });
    writeFileSync(join(right, "artifact"), bytes, { mode: 0o444 });
    chmodSync(join(left, "artifact"), 0o444);
    chmodSync(join(right, "artifact"), 0o444);
    const leftDirectory = input.opener.openDirectory(left);
    const rightDirectory = input.opener.openDirectory(right);
    const leftFile = input.opener.openReviewedFile(join(left, "artifact"), expected);
    const rightFile = input.opener.openReviewedFile(join(right, "artifact"), expected);
    opened.push(leftDirectory, rightDirectory, leftFile, rightFile);
    const directoryByFile = new Map<string, string>([
      [`${leftFile.device}:${leftFile.inode}`, `${leftDirectory.device}:${leftDirectory.inode}`],
      [`${rightFile.device}:${rightFile.inode}`, `${rightDirectory.device}:${rightDirectory.inode}`],
    ]);
    const exchanger = spawn(exchangeHelper(input), [left, right, "100000"], {
      stdio: "ignore",
    });
    const exchangerExit = new Promise<number>((resolveExit, reject) => {
      exchanger.once("error", reject);
      exchanger.once("exit", (code) => resolveExit(code ?? 1));
    });
    for (let index = 0; index < 300; index++) {
      const observed = input.opener.openReviewedFile(join(left, "artifact"), expected);
      const fileIdentity = `${observed.device}:${observed.inode}`;
      const expectedDirectory = directoryByFile.get(fileIdentity);
      assert.notEqual(expectedDirectory, undefined);
      assert.equal(observed.ancestorIdentities.includes(expectedDirectory!), true);
      observed.close();
    }
    assert.equal(await exchangerExit, 0);
  } finally {
    closeAll(input, opened);
    removeFixture(input);
  }
});

test("renderer seals canonical identity, launcher authority, mounts, and exact limits", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(plan(input, opened.values));
    assert.equal(rendered.command, "/usr/bin/systemd-run");
    assert.equal(rendered.unitName.startsWith("hitch-v2-worker-"), true);
    assert.equal(rendered.arguments.includes("--unshare-net"), true);
    assert.equal(rendered.arguments.includes("--clearenv"), true);
    assert.equal(rendered.arguments.includes("--property=MemoryMax=268435456"), true);
    assert.equal(rendered.arguments.includes("--property=MemorySwapMax=0"), true);
    assert.equal(rendered.arguments.includes("--property=TasksMax=32"), true);
    assert.equal(rendered.arguments.includes("--property=RuntimeMaxSec=30000ms"), true);
    assert.equal(rendered.arguments.includes("--remount-ro"), true);
    const wire = JSON.stringify(rendered.arguments);
    assert.equal(wire.includes(input.workspace), false);
    assert.equal(wire.includes(input.extension), false);
    assert.equal(wire.includes(input.addon), false);
    assert.equal(wire.includes(input.secureLauncherPath), false);
    assert.equal(rendered.arguments.includes("/proc/self/fd/2"), true);
    assert.equal("sensitiveMountFrame" in rendered, false);

    const reorderedIdentity = {
      containerGeneration: 1,
      workerFencingToken: 1,
      workerLeaseId: "WorkerLease:test",
      attemptId: "AgentDispatchAttempt:test",
      turnId: "Turn:test",
      sessionId: "Session:test",
      principalId: "Principal:test",
      installationId: `Installation:${input.id}`,
    };
    const second = renderEphemeralWorkerCommand(
      plan(input, opened.values, { identity: reorderedIdentity }),
    );
    assert.equal(second.unitName, rendered.unitName);
    assert.throws(
      () =>
        renderEphemeralWorkerCommand(
          plan(input, opened.values, {
            identity: { ...reorderedIdentity, unexpected: "field" } as never,
          }),
        ),
      /exact canonical fields/,
    );
    assert.throws(
      () =>
        renderEphemeralWorkerCommand(
          plan(input, opened.values, {
            secureLauncher: { source: input.secureLauncher.source } as never,
          }),
        ),
      /sealed evidence/,
    );
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("renderer rejects physical workspace overlap and nested sandbox destinations", async () => {
  const input = await fixture();
  const opened = mounts(input);
  const nestedPath = join(input.workspace, "nested-extension.mjs");
  const nestedBytes = "nested reviewed extension";
  writeFileSync(nestedPath, nestedBytes, { mode: 0o444 });
  chmodSync(nestedPath, 0o444);
  const nested = input.opener.openReviewedFile(nestedPath, digest(nestedBytes));
  try {
    const overlapping = opened.values.map((mount) =>
      mount.purpose === "workspace-tools-extension"
        ? { ...mount, source: nested }
        : mount,
    );
    assert.throws(
      () => renderEphemeralWorkerCommand(plan(input, overlapping)),
      /overlaps protected authority/,
    );
    const nestedDestination = opened.values.map((mount) =>
      mount.purpose === "workspace-tools-addon"
        ? { ...mount, sandboxPath: "/workspace/tool.node" }
        : mount,
    ) as readonly VerifiedSandboxMount[];
    assert.throws(
      () => renderEphemeralWorkerCommand(plan(input, nestedDestination)),
      /destinations overlap/,
    );
  } finally {
    closeAll(input, [...opened.sources, nested]);
    removeFixture(input);
  }
});

test("sealed plan rejects structural cloning and post-render artifact mutation", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(plan(input, opened.values));
    const supervisor = new EphemeralWorkerSupervisor();
    await assert.rejects(
      supervisor.launch({ ...rendered }),
      /not fresh sealed evidence/,
    );
    chmodSync(input.extension, 0o644);
    writeFileSync(input.extension, "tampered extension", { mode: 0o644 });
    chmodSync(input.extension, 0o444);
    await assert.rejects(
      supervisor.launch(rendered),
      /changed after verification/,
    );
    assert.equal(opened.sources.every((source) => source.isClosed), true);
    assert.equal(input.secureLauncher.source.isClosed, true);
    await assert.rejects(supervisor.launch(rendered), /not fresh sealed evidence/);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("exact unbuffered helper handoff preserves the first immediate worker frame", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(input, opened.values, {
        arguments: [
          "-e",
          "let b='';process.stdin.on('data',c=>{b+=c;if(b.includes('\\n')){process.stdout.write(b.slice(0,b.indexOf('\\n')+1));}});setInterval(()=>{},1000)",
        ],
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    assert.equal((await worker.process.writeStdin(Buffer.from('{"first":true}\n'))).kind, "complete");
    assert.equal(await nextOutput(worker), '{"first":true}\n');
    await cleanup(supervisor, worker);
    assert.equal(opened.sources.every((source) => source.isClosed), true);
    assert.equal(input.secureLauncher.source.isClosed, true);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("rename exchange after verification fails before worker exposure and closes authority", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(plan(input, opened.values));
    const exchangeTarget = `${input.extension}.exchange`;
    writeFileSync(exchangeTarget, "reviewed extension", { mode: 0o444 });
    chmodSync(exchangeTarget, 0o444);
    exchangePaths(input, input.extension, exchangeTarget);
    await assert.rejects(
      new EphemeralWorkerSupervisor().launch(rendered),
      /handoff acknowledgement was invalid|exited before acknowledgement/,
    );
    assert.equal(opened.sources.every((source) => source.isClosed), true);
    assert.equal(input.secureLauncher.source.isClosed, true);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("launcher rename exchange cannot replace FD-bound sealed execution", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(plan(input, opened.values));
    const exchangeTarget = `${input.secureLauncherPath}.exchange`;
    const marker = join(input.root, "unreviewed-launcher-ran");
    writeFileSync(
      exchangeTarget,
      `#!/bin/sh\nprintf compromised > ${marker}\n`,
      { mode: 0o555 },
    );
    chmodSync(exchangeTarget, 0o555);
    exchangePaths(input, input.secureLauncherPath, exchangeTarget);
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    assert.equal(existsSync(marker), false);
    await cleanup(supervisor, worker);
    assert.equal(opened.sources.every((source) => source.isClosed), true);
    assert.equal(input.secureLauncher.source.isClosed, true);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("handoff failure is handled immediately and leaves no rejected-promise leak", async () => {
  const input = await fixture();
  const opened = mounts(input);
  let unhandled: unknown;
  const observe = (error: unknown): void => {
    unhandled = error;
  };
  process.once("unhandledRejection", observe);
  try {
    const rendered = renderEphemeralWorkerCommand(plan(input, opened.values));
    const moved = `${input.extension}.missing`;
    renameSync(input.extension, moved);
    await assert.rejects(new EphemeralWorkerSupervisor().launch(rendered));
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener("unhandledRejection", observe);
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("early worker exit is retained and failed exec closes every held source", async () => {
  const earlyInput = await fixture();
  const earlyOpened = mounts(earlyInput);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(earlyInput, earlyOpened.values, {
        arguments: ["-e", "setTimeout(()=>process.exit(7),200)"],
      }),
    );
    const worker = await new EphemeralWorkerSupervisor().launch(rendered);
    const exit = await within(worker.process.observeExit(), 3_000);
    assert.equal(exit.exitCode, 7);
    assert.equal(earlyOpened.sources.every((source) => source.isClosed), true);
  } finally {
    closeAll(earlyInput, earlyOpened.sources);
    removeFixture(earlyInput);
  }

  const failedInput = await fixture();
  const failedOpened = mounts(failedInput);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(failedInput, failedOpened.values, {
        executableSandboxPath: "/usr/bin/hitch-does-not-exist",
      }),
    );
    try {
      const failedWorker = await new EphemeralWorkerSupervisor().launch(rendered);
      const failedExit = await within(failedWorker.process.observeExit(), 3_000);
      assert.notEqual(failedExit.exitCode, 0);
    } catch (error) {
      assert.match((error as Error).message, /scope|cgroup|worker/);
    }
    assert.equal(failedOpened.sources.every((source) => source.isClosed), true);
    assert.equal(failedInput.secureLauncher.source.isClosed, true);
  } finally {
    closeAll(failedInput, failedOpened.sources);
    removeFixture(failedInput);
  }
});

test("semantic unit collision is rejected without touching the captured worker", async () => {
  const firstInput = await fixture();
  const firstOpened = mounts(firstInput);
  const secondInput = await fixture();
  const secondOpened = mounts(secondInput);
  let worker: LaunchedEphemeralWorker | undefined;
  const supervisor = new EphemeralWorkerSupervisor();
  try {
    const echoArguments = [
      "-e",
      "process.stdin.on('data',c=>process.stdout.write(c));setInterval(()=>{},1000)",
    ];
    const firstPlan = plan(firstInput, firstOpened.values, { arguments: echoArguments });
    const renderedFirst = renderEphemeralWorkerCommand(firstPlan);
    worker = await supervisor.launch(renderedFirst);
    const secondPlan = plan(secondInput, secondOpened.values, {
      identity: firstPlan.identity,
      arguments: echoArguments,
    });
    const renderedSecond = renderEphemeralWorkerCommand(secondPlan);
    await assert.rejects(
      new EphemeralWorkerSupervisor().launch(renderedSecond),
      /unit name is not absent/,
    );
    assert.equal((await worker.process.writeStdin(Buffer.from("still-alive\n"))).kind, "complete");
    assert.equal(await nextOutput(worker), "still-alive\n");
    await cleanup(supervisor, worker);
    worker = undefined;
  } finally {
    if (worker !== undefined) await supervisor.cleanup(worker);
    closeAll(firstInput, firstOpened.sources);
    closeAll(secondInput, secondOpened.sources);
    removeFixture(firstInput);
    removeFixture(secondInput);
  }
});

test("real scope enforces exact wall ceiling and confirms the whole cgroup gone", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(input, opened.values, {
        identity: {
          ...plan(input, opened.values).identity,
          containerGeneration: 2,
        },
        limits: {
          ...plan(input, opened.values).limits,
          wallTimeMilliseconds: 300,
        },
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const started = Date.now();
    const worker = await supervisor.launch(rendered);
    await within(worker.process.observeExit(), 3_000);
    assert.equal(Date.now() - started < 2_000, true);
    await cleanup(supervisor, worker);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("real sandbox bounds temporary storage and denies other writable roots", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const script = [
      "const f=require('fs');",
      "const out={};",
      "for(const p of ['/run/x','/hitch-runtime/x','/outside']){try{f.writeFileSync(p,'x');out[p]='wrote'}catch(e){out[p]=e.code}}",
      "try{f.writeFileSync('/tmp/overflow',Buffer.alloc(2*1024*1024));out.tmp='wrote'}catch(e){out.tmp=e.code}",
      "process.stdout.write(JSON.stringify(out)+'\\n');setInterval(()=>{},1000)",
    ].join("");
    const rendered = renderEphemeralWorkerCommand(
      plan(input, opened.values, {
        identity: { ...plan(input, opened.values).identity, containerGeneration: 3 },
        limits: { ...plan(input, opened.values).limits, temporaryStorageBytes: 1_048_576 },
        arguments: ["-e", script],
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    const result = JSON.parse(await nextOutput(worker)) as Record<string, string>;
    assert.notEqual(result["/run/x"], "wrote");
    assert.notEqual(result["/hitch-runtime/x"], "wrote");
    assert.notEqual(result["/outside"], "wrote");
    assert.equal(result.tmp, "ENOSPC");
    await cleanup(supervisor, worker);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("real cgroup enforces process and memory ceilings", async () => {
  const taskInput = await fixture();
  const taskOpened = mounts(taskInput);
  try {
    const taskScript = [
      "const{spawn}=require('child_process');let errors=0,started=0,done=0;",
      "for(let i=0;i<40;i++){const c=spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      "c.on('spawn',()=>{started++;done++;if(done===40)finish()});c.on('error',()=>{errors++;done++;if(done===40)finish()})}",
      "function finish(){process.stdout.write(JSON.stringify({started,errors})+'\\n');setInterval(()=>{},1000)}",
    ].join("");
    const rendered = renderEphemeralWorkerCommand(
      plan(taskInput, taskOpened.values, {
        identity: { ...plan(taskInput, taskOpened.values).identity, containerGeneration: 4 },
        limits: { ...plan(taskInput, taskOpened.values).limits, maximumProcesses: 16 },
        arguments: ["-e", taskScript],
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    const result = JSON.parse(await nextOutput(worker)) as { started: number; errors: number };
    assert.equal(result.errors > 0, true);
    assert.equal(result.started < 40, true);
    await cleanup(supervisor, worker);
  } finally {
    closeAll(taskInput, taskOpened.sources);
    removeFixture(taskInput);
  }

  const memoryInput = await fixture();
  const memoryOpened = mounts(memoryInput);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(memoryInput, memoryOpened.values, {
        identity: { ...plan(memoryInput, memoryOpened.values).identity, containerGeneration: 5 },
        limits: { ...plan(memoryInput, memoryOpened.values).limits, memoryBytes: 100_663_296 },
        arguments: [
          "-e",
          "const b=Buffer.alloc(256*1024*1024,1);process.stdout.write('escaped '+b.length);setInterval(()=>{},1000)",
        ],
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    const chunks: Uint8Array[] = [];
    void (async () => {
      for await (const chunk of worker.process.stdout) chunks.push(chunk);
    })();
    await within(worker.process.observeExit(), 5_000);
    assert.equal(Buffer.concat(chunks).toString("utf8").includes("escaped"), false);
    await cleanup(supervisor, worker);
  } finally {
    closeAll(memoryInput, memoryOpened.sources);
    removeFixture(memoryInput);
  }
});

test("protocol output is bounded from spawn while worker stderr is discarded", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(input, opened.values, {
        identity: { ...plan(input, opened.values).identity, containerGeneration: 7 },
        limits: { ...plan(input, opened.values).limits, outputBytes: 4_096 },
        arguments: [
          "-e",
          "process.stdout.write(Buffer.alloc(1024*1024,65));process.stderr.write(Buffer.alloc(1024*1024,66));setInterval(()=>{},1000)",
        ],
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    await within(worker.process.observeExit(), 3_000);
    await cleanup(supervisor, worker);
    assert.equal(opened.sources.every((source) => source.isClosed), true);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

test("supervisor cancellation kills descendants and releases sources only after absence", async () => {
  const input = await fixture();
  const opened = mounts(input);
  try {
    const rendered = renderEphemeralWorkerCommand(
      plan(input, opened.values, {
        identity: { ...plan(input, opened.values).identity, containerGeneration: 6 },
        arguments: [
          "-e",
          "const{spawn}=require('child_process');spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        ],
      }),
    );
    const supervisor = new EphemeralWorkerSupervisor();
    const worker = await supervisor.launch(rendered);
    assert.equal((await nextOutput(worker)).includes("ready"), true);
    await cleanup(supervisor, worker);
    assert.equal(opened.sources.every((source) => source.isClosed), true);
    assert.equal(input.secureLauncher.source.isClosed, true);
  } finally {
    closeAll(input, opened.sources);
    removeFixture(input);
  }
});

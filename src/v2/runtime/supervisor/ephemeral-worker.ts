import {
  spawn,
  type ChildProcessByStdio,
} from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import type {
  AgentProcessExit,
  AgentTransportWriteResult,
  SupervisorOwnedAgentProcess,
} from "../../model/agent-runtime.js";
import type { IsoTimestamp } from "../../model/primitives.js";
import {
  consumeRenderedEphemeralWorkerCommand,
  type ConsumedEphemeralWorkerCommand,
  type RenderedEphemeralWorkerCommand,
} from "../../sandbox/bubblewrap.js";
import {
  assertProcessExecutableMatches,
  sealVerifiedExecutable,
  type VerifiedSealedExecutable,
} from "../../sandbox/native/supervisor-openat2.js";

type WorkerChild = ChildProcessByStdio<Writable, Readable, null>;

const workerBrand: unique symbol = Symbol("ephemeralWorker");

export interface LaunchedEphemeralWorker {
  readonly [workerBrand]: true;
  readonly unitName: string;
  readonly process: SupervisorOwnedAgentProcess;
}

export type EphemeralWorkerCleanupResult =
  | { readonly status: "confirmed-gone"; readonly unitName: string }
  | {
      readonly status: "cleanup-ambiguous";
      readonly unitName: string;
      readonly reason:
        | "kill-failed"
        | "stop-failed"
        | "inspection-failed"
        | "still-active";
    };

const failedLaunchBrand: unique symbol = Symbol("failedEphemeralWorkerLaunch");
const failedLaunchRecords = new WeakMap<object, FailedLaunchRecord>();

export interface FailedEphemeralWorkerLaunch {
  readonly [failedLaunchBrand]: true;
  readonly unitName: string;
}

class FailedLaunchEvidence implements FailedEphemeralWorkerLaunch {
  readonly [failedLaunchBrand] = true as const;

  constructor(readonly unitName: string, record: FailedLaunchRecord) {
    failedLaunchRecords.set(this, record);
    Object.freeze(this);
  }
}

export class EphemeralWorkerLaunchError extends Error {
  readonly failedLaunch: FailedEphemeralWorkerLaunch | undefined;

  constructor(message: string, failedLaunch?: FailedEphemeralWorkerLaunch) {
    super(message);
    this.name = "EphemeralWorkerLaunchError";
    this.failedLaunch = failedLaunch;
  }
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
}

interface UnitProperties {
  readonly loadState: string;
  readonly activeState: string;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly description: string;
  readonly memoryMax: string;
  readonly memorySwapMax: string;
  readonly tasksMax: string;
  readonly runtimeMax: string;
  readonly killMode: string;
}

interface CapturedUnitAuthority {
  readonly unitName: string;
  readonly invocationId: string;
  readonly controlGroup: string;
  readonly helperProcessId: number | undefined;
  readonly environment: Readonly<Record<string, string>>;
}

interface WorkerRecord extends CapturedUnitAuthority {
  readonly child: WorkerChild;
}

interface FailedLaunchRecord {
  readonly unitName: string;
  readonly expectedDescription: string;
  readonly environment: Readonly<Record<string, string>>;
  captured: CapturedUnitAuthority | undefined;
}

const CGROUP_ROOT = "/sys/fs/cgroup";

function now(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

async function command(
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveResult(result);
    };
    const child = spawn(executable, args, {
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output: Uint8Array[] = [];
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout: "" });
    }, 5_000);
    deadline.unref();
    child.stdout.on("data", (chunk: Uint8Array) => output.push(chunk));
    child.once("error", () => finish({ code: 127, stdout: "" }));
    child.once("exit", (code) =>
      finish({ code: code ?? 127, stdout: Buffer.concat(output).toString("utf8") }),
    );
  });
}

function captureExit(child: WorkerChild): Promise<AgentProcessExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exit: AgentProcessExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(exit);
    };
    child.once("error", () => finish({ observedAt: now() }));
    child.once("exit", (code, signal) =>
      finish({
        ...(code === null ? {} : { exitCode: code }),
        ...(signal === null ? {} : { signal }),
        observedAt: now(),
      }),
    );
  });
}

function waitForSpawn(child: WorkerChild): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", () => reject(new Error("ephemeral worker launch failed")));
  });
}

class BoundedChildOutput {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  private used = 0;
  private failed = false;

  constructor(
    private readonly child: WorkerChild,
    private readonly maximumBytes: number,
  ) {
    this.stdout = new PassThrough({ highWaterMark: maximumBytes });
    this.stderr = new PassThrough({ highWaterMark: maximumBytes });
    // A limit can fire before the eventual driver attaches its async iterators.
    this.stdout.on("error", () => undefined);
    this.stderr.on("error", () => undefined);
    // The reviewed launcher permanently redirects worker stderr to /dev/null.
    this.stderr.end();
  }

  forwardStdout(chunk: Uint8Array): void {
    this.forward(this.child.stdout, this.stdout, chunk);
  }

  endStdout(): void {
    this.stdout.end();
  }

  fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.child.kill("SIGKILL");
    const error = new Error(reason);
    this.stdout.destroy(error);
    this.stderr.destroy(error);
  }

  assertWithinLimit(): void {
    if (this.failed) throw new Error("worker output failed before driver attachment");
  }

  private forward(source: Readable, target: PassThrough, chunk: Uint8Array): void {
    if (this.failed) return;
    this.used += chunk.byteLength;
    if (this.used > this.maximumBytes) {
      this.fail("worker output exceeded the supervisor byte limit");
      return;
    }
    if (!target.write(chunk)) {
      source.pause();
      target.once("drain", () => {
        if (!this.failed) source.resume();
      });
    }
  }
}

function filterHandoff(
  child: WorkerChild,
  expectedPrefix: string,
  output: BoundedChildOutput,
): Promise<number> {
  let buffer = Buffer.alloc(0);
  let armed = true;
  let resolveReady: ((processId: number) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  // Mark rejection handled immediately; awaiting the original promise still rejects.
  void ready.catch(() => undefined);
  const deadline = setTimeout(() => {
    if (!armed) return;
    armed = false;
    rejectReady?.(new Error("secure mount handoff timed out"));
  }, 5_000);
  deadline.unref();
  child.stdout.on("data", (chunk: Uint8Array) => {
    if (!armed) {
      output.forwardStdout(chunk);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 512) {
      armed = false;
      clearTimeout(deadline);
      rejectReady?.(new Error("secure mount handoff exceeded its bound"));
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return;
    const line = buffer.subarray(0, newline + 1).toString("utf8");
    const processText = line.startsWith(expectedPrefix)
      ? line.slice(expectedPrefix.length, -1)
      : "";
    const processId = Number(processText);
    if (!/^[1-9]\d*$/.test(processText) || !Number.isSafeInteger(processId)) {
      armed = false;
      clearTimeout(deadline);
      rejectReady?.(new Error("secure mount handoff acknowledgement was invalid"));
      return;
    }
    const remainder = buffer.subarray(newline + 1);
    buffer = Buffer.alloc(0);
    armed = false;
    clearTimeout(deadline);
    if (remainder.length > 0) output.forwardStdout(remainder);
    resolveReady?.(processId);
  });
  child.stdout.once("end", () => {
    if (armed) {
      armed = false;
      clearTimeout(deadline);
      rejectReady?.(new Error("secure mount helper exited before acknowledgement"));
    }
    output.endStdout();
  });
  child.stdout.once("error", () => {
    if (armed) {
      armed = false;
      clearTimeout(deadline);
      rejectReady?.(new Error("secure mount helper stdout failed"));
    }
    output.fail("worker stdout failed");
  });
  return ready;
}

class OwnedProcess implements SupervisorOwnedAgentProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;

  constructor(
    private readonly child: WorkerChild,
    output: BoundedChildOutput,
    private readonly exit: Promise<AgentProcessExit>,
  ) {
    this.stdout = output.stdout;
    this.stderr = output.stderr;
  }

  writeStdin(frame: Uint8Array): Promise<AgentTransportWriteResult> {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return Promise.resolve({
        kind: "definitely-not-written",
        failedAt: now(),
        reason: "worker stdin is closed",
      });
    }
    return new Promise((resolveWrite) => {
      this.child.stdin.write(frame, (error) => {
        if (error === null || error === undefined) {
          resolveWrite({ kind: "complete", completedAt: now() });
        } else {
          resolveWrite({
            kind: "write-uncertain",
            failedAt: now(),
            reason: "worker stdin write failed",
          });
        }
      });
    });
  }

  observeExit(): Promise<AgentProcessExit> {
    return this.exit;
  }
}

function parseProperties(output: string): UnitProperties {
  const properties = new Map<string, string>();
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return {
    loadState: properties.get("LoadState") ?? "",
    activeState: properties.get("ActiveState") ?? "",
    invocationId: properties.get("InvocationID") ?? "",
    controlGroup: properties.get("ControlGroup") ?? "",
    description: properties.get("Description") ?? "",
    memoryMax: properties.get("MemoryMax") ?? "",
    memorySwapMax: properties.get("MemorySwapMax") ?? "",
    tasksMax: properties.get("TasksMax") ?? "",
    runtimeMax: properties.get("RuntimeMaxUSec") ?? "",
    killMode: properties.get("KillMode") ?? "",
  };
}

async function showUnit(
  unitName: string,
  environment: Readonly<Record<string, string>>,
): Promise<UnitProperties | undefined> {
  const shown = await command(
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      unitName,
      "--no-pager",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=InvocationID",
      "--property=ControlGroup",
      "--property=Description",
      "--property=MemoryMax",
      "--property=MemorySwapMax",
      "--property=TasksMax",
      "--property=RuntimeMaxUSec",
      "--property=KillMode",
    ],
    environment,
  );
  return shown.code === 0 ? parseProperties(shown.stdout) : undefined;
}

function parseSystemdDurationMicroseconds(value: string): bigint | undefined {
  const compact = value.replaceAll(" ", "");
  const units: Readonly<Record<string, bigint>> = {
    us: 1n,
    ms: 1_000n,
    s: 1_000_000n,
    min: 60_000_000n,
    h: 3_600_000_000n,
    d: 86_400_000_000n,
  };
  const expression = /(\d+)(us|ms|min|s|h|d)/gy;
  let total = 0n;
  let end = 0;
  for (;;) {
    const match = expression.exec(compact);
    if (match === null) break;
    total += BigInt(match[1]!) * units[match[2]!]!;
    end = expression.lastIndex;
  }
  return end > 0 && end === compact.length ? total : undefined;
}

function strictCgroupDirectory(controlGroup: string): string | undefined {
  if (
    !controlGroup.startsWith("/") ||
    controlGroup.includes("\0") ||
    controlGroup.split("/").some((part) => part === "." || part === "..")
  ) {
    return undefined;
  }
  const directory = resolve(CGROUP_ROOT, `.${controlGroup}`);
  return directory.startsWith(`${CGROUP_ROOT}/`) ? directory : undefined;
}

async function readCgroupValue(
  controlGroup: string,
  name: string,
): Promise<string | undefined> {
  const directory = strictCgroupDirectory(controlGroup);
  if (directory === undefined) return undefined;
  try {
    return (await readFile(resolve(directory, name), "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function cgroupTreeProcessIds(
  controlGroup: string,
): Promise<readonly number[] | undefined> {
  const root = strictCgroupDirectory(controlGroup);
  if (root === undefined) return undefined;
  const output: number[] = [];
  async function inspect(directory: string): Promise<void> {
    const processes = (await readFile(resolve(directory, "cgroup.procs"), "utf8")).trim();
    if (processes.length > 0) {
      for (const value of processes.split("\n")) {
        const processId = Number(value);
        if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("invalid pid");
        output.push(processId);
      }
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await inspect(resolve(directory, entry.name));
    }
  }
  try {
    await inspect(root);
    return Object.freeze(output.sort((left, right) => left - right));
  } catch {
    return undefined;
  }
}

async function cgroupTreeEmpty(controlGroup: string): Promise<boolean | undefined> {
  const processes = await cgroupTreeProcessIds(controlGroup);
  if (processes !== undefined) return processes.length === 0;
  const root = strictCgroupDirectory(controlGroup);
  if (root === undefined) return undefined;
  try {
    await readFile(resolve(root, "cgroup.procs"), "utf8");
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? true : undefined;
  }
}

async function captureProvisionalAuthority(
  plan: Pick<
    ConsumedEphemeralWorkerCommand,
    "unitName" | "environment" | "expectedUnitDescription"
  >,
): Promise<{
  readonly authority: CapturedUnitAuthority;
  readonly properties: UnitProperties;
}> {
  const properties = await showUnit(plan.unitName, plan.environment);
  if (
    properties === undefined ||
    properties.loadState !== "loaded" ||
    !["active", "activating", "deactivating"].includes(properties.activeState) ||
    properties.description !== plan.expectedUnitDescription ||
    !/^[a-f0-9]{32}$/.test(properties.invocationId) ||
    strictCgroupDirectory(properties.controlGroup) === undefined
  ) {
    throw new Error("transient worker scope identity was not captured exactly");
  }
  return Object.freeze({
    authority: Object.freeze({
      unitName: plan.unitName,
      invocationId: properties.invocationId,
      controlGroup: properties.controlGroup,
      helperProcessId: undefined,
      environment: plan.environment,
    }),
    properties,
  });
}

async function captureUnitAuthority(
  plan: ConsumedEphemeralWorkerCommand,
  helperProcessId: number,
): Promise<{
  readonly authority: CapturedUnitAuthority;
  readonly properties: UnitProperties;
}> {
  const provisional = await captureProvisionalAuthority(plan);
  const processes = await cgroupTreeProcessIds(provisional.authority.controlGroup);
  if (processes?.length !== 1 || processes[0] !== helperProcessId) {
    throw new Error("acknowledged helper is not the sole transient cgroup process");
  }
  return Object.freeze({
    authority: Object.freeze({
      ...provisional.authority,
      helperProcessId,
    }),
    properties: provisional.properties,
  });
}

async function verifyUnitLimits(
  plan: ConsumedEphemeralWorkerCommand,
  properties: UnitProperties,
): Promise<void> {
  const expectedRuntime = BigInt(plan.limits.wallTimeMilliseconds) * 1_000n;
  if (
    properties.memoryMax !== String(plan.limits.memoryBytes) ||
    properties.memorySwapMax !== "0" ||
    properties.tasksMax !== String(plan.limits.maximumProcesses) ||
    parseSystemdDurationMicroseconds(properties.runtimeMax) !== expectedRuntime ||
    properties.killMode !== "control-group"
  ) {
    throw new Error("transient worker scope did not apply the exact limits");
  }
  const [memory, swap, tasks] = await Promise.all([
    readCgroupValue(properties.controlGroup, "memory.max"),
    readCgroupValue(properties.controlGroup, "memory.swap.max"),
    readCgroupValue(properties.controlGroup, "pids.max"),
  ]);
  if (
    memory !== String(plan.limits.memoryBytes) ||
    swap !== "0" ||
    tasks !== String(plan.limits.maximumProcesses)
  ) {
    throw new Error("transient worker cgroup did not apply the exact controllers");
  }
}

async function authorityStillMatches(
  authority: CapturedUnitAuthority,
): Promise<"same" | "gone" | "mismatch" | "unknown"> {
  const current = await showUnit(authority.unitName, authority.environment);
  if (current === undefined) return "unknown";
  if (current.loadState === "not-found") {
    return (await cgroupTreeEmpty(authority.controlGroup)) === true ? "gone" : "unknown";
  }
  if (["inactive", "failed"].includes(current.activeState)) {
    const identityWasRetained =
      current.invocationId === authority.invocationId &&
      (current.controlGroup === authority.controlGroup || current.controlGroup.length === 0);
    const identityWasCleared =
      current.invocationId.length === 0 && current.controlGroup.length === 0;
    if (!identityWasRetained && !identityWasCleared) return "mismatch";
    return (await cgroupTreeEmpty(authority.controlGroup)) === true ? "gone" : "unknown";
  }
  if (
    current.invocationId !== authority.invocationId ||
    current.controlGroup !== authority.controlGroup
  ) {
    return "mismatch";
  }
  return ["active", "activating", "deactivating"].includes(current.activeState)
    ? "same"
    : "unknown";
}

export class EphemeralWorkerSupervisor {
  private readonly records = new WeakMap<object, WorkerRecord>();
  private readonly reservedUnits = new Set<string>();

  async launch(publicPlan: RenderedEphemeralWorkerCommand): Promise<LaunchedEphemeralWorker> {
    const plan = consumeRenderedEphemeralWorkerCommand(publicPlan);
    if (this.reservedUnits.has(plan.unitName)) {
      for (const source of plan.heldSources) source.close();
      throw new EphemeralWorkerLaunchError(
        "ephemeral worker unit identity was already consumed",
      );
    }
    this.reservedUnits.add(plan.unitName);
    let child: WorkerChild | undefined;
    let sealedExecutable: VerifiedSealedExecutable | undefined;
    let exit: Promise<AgentProcessExit> | undefined;
    let captured: CapturedUnitAuthority | undefined;
    let spawnAttempted = false;
    const closeSources = (): void => {
      for (const source of plan.heldSources) source.close();
    };
    try {
      const existing = await showUnit(plan.unitName, plan.environment);
      if (existing === undefined || existing.loadState !== "not-found") {
        throw new Error("ephemeral worker unit name is not absent");
      }
      sealedExecutable = sealVerifiedExecutable(plan.launcherSource);
      spawnAttempted = true;
      const spawned = spawn(plan.command, plan.arguments, {
        env: plan.environment,
        stdio: ["pipe", "pipe", sealedExecutable.fd],
      });
      if (spawned.stdin === null || spawned.stdout === null || spawned.stderr !== null) {
        spawned.kill("SIGKILL");
        throw new Error("ephemeral worker stdio topology was not exact");
      }
      const launchedChild = spawned as unknown as WorkerChild;
      child = launchedChild;
      exit = captureExit(launchedChild);
      void exit.then(() => {
        sealedExecutable?.close();
        closeSources();
      });
      const output = new BoundedChildOutput(launchedChild, plan.limits.outputBytes);
      const handoff = filterHandoff(
        launchedChild,
        plan.expectedHandoffPrefix,
        output,
      );
      await waitForSpawn(launchedChild);
      await new Promise<void>((resolveWrite, reject) => {
        launchedChild.stdin.write(plan.sensitiveMountFrame, (error) => {
          if (error === null || error === undefined) resolveWrite();
          else reject(new Error("secure mount evidence handoff failed"));
        });
      });
      const helperProcessId = await handoff;
      const observed = await captureUnitAuthority(plan, helperProcessId);
      captured = observed.authority;
      assertProcessExecutableMatches(sealedExecutable, helperProcessId);
      await verifyUnitLimits(plan, observed.properties);
      output.assertWithinLimit();
      await new Promise<void>((resolveWrite, reject) => {
        launchedChild.stdin.write(Buffer.from([0x47]), (error) => {
          if (error === null || error === undefined) resolveWrite();
          else reject(new Error("secure launcher continuation failed"));
        });
      });
      output.assertWithinLimit();
      sealedExecutable.close();
      const worker = Object.freeze({
        [workerBrand]: true as const,
        unitName: plan.unitName,
        process: new OwnedProcess(launchedChild, output, exit),
      });
      this.records.set(worker, Object.freeze({ ...captured, child: launchedChild }));
      return worker;
    } catch (error) {
      child?.kill("SIGKILL");
      sealedExecutable?.close();
      let cleanupResult: EphemeralWorkerCleanupResult | undefined;
      if (spawnAttempted) {
        const record: FailedLaunchRecord = {
          unitName: plan.unitName,
          expectedDescription: plan.expectedUnitDescription,
          environment: plan.environment,
          captured,
        };
        cleanupResult = await this.retryFailedLaunchCleanup(record);
        if (cleanupResult.status === "cleanup-ambiguous") {
          closeSources();
          const failed = new FailedLaunchEvidence(plan.unitName, record);
          throw new EphemeralWorkerLaunchError((error as Error).message, failed);
        }
      }
      closeSources();
      throw new EphemeralWorkerLaunchError((error as Error).message);
    }
  }

  async cleanup(worker: LaunchedEphemeralWorker): Promise<EphemeralWorkerCleanupResult> {
    const record = this.records.get(worker);
    if (record === undefined) {
      return {
        status: "cleanup-ambiguous",
        unitName: worker.unitName,
        reason: "inspection-failed",
      };
    }
    return this.cleanupAuthority(record);
  }

  async cleanupFailedLaunch(
    failed: FailedEphemeralWorkerLaunch,
  ): Promise<EphemeralWorkerCleanupResult> {
    const record = failedLaunchRecords.get(failed);
    if (record === undefined) {
      return {
        status: "cleanup-ambiguous",
        unitName: failed.unitName,
        reason: "inspection-failed",
      };
    }
    return this.retryFailedLaunchCleanup(record);
  }

  private async retryFailedLaunchCleanup(
    record: FailedLaunchRecord,
  ): Promise<EphemeralWorkerCleanupResult> {
    if (record.captured !== undefined) return this.cleanupAuthority(record.captured);
    const current = await showUnit(record.unitName, record.environment);
    if (current === undefined) {
      return {
        status: "cleanup-ambiguous",
        unitName: record.unitName,
        reason: "inspection-failed",
      };
    }
    if (current.loadState === "not-found") {
      return { status: "confirmed-gone", unitName: record.unitName };
    }
    if (current.description !== record.expectedDescription) {
      return {
        status: "cleanup-ambiguous",
        unitName: record.unitName,
        reason: "inspection-failed",
      };
    }
    if (
      ["inactive", "failed"].includes(current.activeState) &&
      current.controlGroup.length === 0
    ) {
      return { status: "confirmed-gone", unitName: record.unitName };
    }
    try {
      const observed = await captureProvisionalAuthority({
        unitName: record.unitName,
        environment: record.environment,
        expectedUnitDescription: record.expectedDescription,
      });
      record.captured = observed.authority;
      return this.cleanupAuthority(observed.authority);
    } catch {
      return {
        status: "cleanup-ambiguous",
        unitName: record.unitName,
        reason: "inspection-failed",
      };
    }
  }

  private async cleanupAuthority(
    authority: CapturedUnitAuthority,
  ): Promise<EphemeralWorkerCleanupResult> {
    const before = await authorityStillMatches(authority);
    if (before === "gone") {
      return { status: "confirmed-gone", unitName: authority.unitName };
    }
    if (before !== "same") {
      return {
        status: "cleanup-ambiguous",
        unitName: authority.unitName,
        reason: "inspection-failed",
      };
    }
    const kill = await command(
      "/usr/bin/systemctl",
      ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", authority.unitName],
      authority.environment,
    );
    if (kill.code !== 0 && (await authorityStillMatches(authority)) !== "gone") {
      return {
        status: "cleanup-ambiguous",
        unitName: authority.unitName,
        reason: "kill-failed",
      };
    }
    const stop = await command(
      "/usr/bin/systemctl",
      ["--user", "stop", authority.unitName],
      authority.environment,
    );
    if (stop.code !== 0 && (await authorityStillMatches(authority)) !== "gone") {
      return {
        status: "cleanup-ambiguous",
        unitName: authority.unitName,
        reason: "stop-failed",
      };
    }
    const after = await authorityStillMatches(authority);
    return after === "gone"
      ? { status: "confirmed-gone", unitName: authority.unitName }
      : {
          status: "cleanup-ambiguous",
          unitName: authority.unitName,
          reason: after === "same" ? "still-active" : "inspection-failed",
        };
  }
}

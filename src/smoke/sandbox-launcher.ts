import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BubblewrapLauncher } from "../sandbox/bubblewrap-launcher.js";
import { DirectLauncher } from "../sandbox/direct-launcher.js";
import type { LaunchRequest, SandboxLauncher } from "../sandbox/launcher.js";
import {
  DEFAULT_REMOTE_EXECUTION_POLICY,
  UNSAFE_DIRECT_EXECUTION_POLICY,
} from "../security/policy.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";

async function main(): Promise<void> {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "hitch-launcher-"));
  const workspace = path.join(tempDir, "workspace");
  mkdirSync(workspace);
  const runtime = new SessionRuntimeStore(path.join(tempDir, "data"));
  try {
    const directMetadata = runtime.materialize(
      "direct",
      "direct-session",
      workspace,
      UNSAFE_DIRECT_EXECUTION_POLICY,
      [workspace],
    );
    const directRequest: LaunchRequest = {
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({cwd:process.cwd(),safe:process.env.SAFE}))"],
      cwd: workspace,
      env: { PATH: process.env.PATH, SAFE: "direct" },
      executionPolicy: directMetadata.executionPolicy,
      mountPlan: directMetadata.mountPlan,
    };
    const direct = new DirectLauncher();
    const directOutput = await collect(direct, directRequest);
    if (directOutput.cwd !== workspace || directOutput.safe !== "direct") {
      throw new Error(`Direct launcher changed the explicit host execution request: ${JSON.stringify(directOutput)}`);
    }
    assertRejected(
      () => direct.buildSpec({ ...directRequest, executionPolicy: DEFAULT_REMOTE_EXECUTION_POLICY }),
      "Direct launcher accepted a restricted policy it cannot enforce.",
    );

    const bubblewrap = new BubblewrapLauncher();
    const probe = await bubblewrap.probe();
    if (!probe.available) {
      if (process.platform === "linux") {
        throw new Error(probe.reason ?? "Bubblewrap probe failed.");
      }
      console.log(`Sandbox launcher smoke skipped Bubblewrap execution: ${probe.reason}`);
      return;
    }
    const sandboxMetadata = runtime.materialize(
      "sandboxed",
      "sandboxed-session",
      workspace,
      DEFAULT_REMOTE_EXECUTION_POLICY,
      [workspace],
    );
    const baseSandboxRequest: LaunchRequest = {
      command: "/usr/bin/node",
      args: ["-e", "process.stdout.write('{}')"],
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      executionPolicy: sandboxMetadata.executionPolicy,
      mountPlan: sandboxMetadata.mountPlan,
      agentPolicyEnforcement: {
        tools: [...sandboxMetadata.executionPolicy.tools],
        processToolEnabled: sandboxMetadata.executionPolicy.process,
      },
    };
    assertRejected(
      () =>
        bubblewrap.buildSpec({
          ...baseSandboxRequest,
          mountPlan: {
            ...sandboxMetadata.mountPlan,
            mounts: [
              ...sandboxMetadata.mountPlan.mounts,
              { hostPath: os.homedir(), sandboxPath: "/loot", mode: "ro", purpose: "policy" },
            ],
          },
        }),
      "Bubblewrap launcher accepted a host mount absent from the execution policy.",
    );
    const { agentPolicyEnforcement: _enforcement, ...unattestedRequest } = baseSandboxRequest;
    assertRejected(
      () => bubblewrap.buildSpec(unattestedRequest),
      "Bubblewrap launcher accepted a restricted policy without agent-level tool enforcement.",
    );
    const hostEscape = path.join(os.homedir(), ".ssh");
    const script = `
      const fs=require("node:fs");
      fs.writeFileSync("workspace.txt", "workspace");
      fs.writeFileSync("/state/state.txt", "state");
      let resultsReadOnly=false;
      try { fs.writeFileSync("/hitch/results/escape.json", "bad"); } catch { resultsReadOnly=true; }
      process.stdout.write(JSON.stringify({
        cwd:process.cwd(), safe:process.env.SAFE,
        leaked:"UNLISTED_SECRET" in process.env,
        hostEscape:fs.existsSync(${JSON.stringify(hostEscape)}), resultsReadOnly
      }));
    `;
    const sandboxOutput = await collect(bubblewrap, {
      ...baseSandboxRequest,
      args: ["-e", script],
      env: { PATH: "/usr/bin:/bin", SAFE: "sandboxed" },
    });
    if (
      sandboxOutput.cwd !== "/workspace" ||
      sandboxOutput.safe !== "sandboxed" ||
      sandboxOutput.leaked !== false ||
      sandboxOutput.hostEscape !== false ||
      sandboxOutput.resultsReadOnly !== true ||
      readFileSync(path.join(workspace, "workspace.txt"), "utf8") !== "workspace"
    ) {
      throw new Error(`Bubblewrap isolation smoke failed: ${JSON.stringify(sandboxOutput)}`);
    }
    const configuredRuntimeOutput = await collect(bubblewrap, {
      ...baseSandboxRequest,
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({runtime:process.version,cwd:process.cwd()}))"],
      env: { PATH: path.dirname(process.execPath) },
    });
    if (configuredRuntimeOutput.runtime !== process.version || configuredRuntimeOutput.cwd !== "/workspace") {
      throw new Error(`Configured non-system runtime was not mounted minimally: ${JSON.stringify(configuredRuntimeOutput)}`);
    }
    console.log("Sandbox launcher smoke ok");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

async function collect(launcher: SandboxLauncher, request: LaunchRequest): Promise<Record<string, unknown>> {
  const child = launcher.launch(request);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`Launcher child exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`);
  }
  return JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>;
}

function assertRejected(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

await main();

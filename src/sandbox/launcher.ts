import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { MountPlan, SandboxCapability, ExecutionPolicy } from "../security/policy.js";

export type LaunchRequest = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  executionPolicy: ExecutionPolicy;
  mountPlan: MountPlan;
  agentPolicyEnforcement?: {
    tools: string[];
    processToolEnabled: boolean;
    agentConfig: {
      hostPath: string;
      mode: "ro" | "rw";
    };
    credentialGuard?: {
      hostPath: string;
      sandboxPath: "/hitch-runtime/credential-guard.mjs";
    };
  };
};

export type LaunchSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
};

export type LauncherProbe = {
  kind: "direct" | "bubblewrap";
  available: boolean;
  capabilities: SandboxCapability[];
  reason?: string;
};

export interface SandboxLauncher {
  readonly kind: LauncherProbe["kind"];
  probe(): Promise<LauncherProbe>;
  buildSpec(request: LaunchRequest): LaunchSpec;
  launch(request: LaunchRequest): ChildProcessWithoutNullStreams;
}

export function spawnLaunchSpec(spec: LaunchSpec): ChildProcessWithoutNullStreams {
  return spawn(spec.command, spec.args, {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

import {
  type LaunchRequest,
  type LauncherProbe,
  type LaunchSpec,
  type SandboxLauncher,
  spawnLaunchSpec,
} from "./launcher.js";

export class DirectLauncher implements SandboxLauncher {
  readonly kind = "direct" as const;

  async probe(): Promise<LauncherProbe> {
    return {
      kind: this.kind,
      available: true,
      capabilities: ["cleared_environment"],
      reason: "Direct execution has no filesystem, namespace, network, or resource isolation.",
    };
  }

  buildSpec(request: LaunchRequest): LaunchSpec {
    assertHonestDirectPolicy(request);
    return {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: { ...request.env },
    };
  }

  launch(request: LaunchRequest) {
    return spawnLaunchSpec(this.buildSpec(request));
  }
}

function assertHonestDirectPolicy(request: LaunchRequest): void {
  const policy = request.executionPolicy;
  if (
    policy.sandbox !== "disabled" ||
    policy.filesystem !== "host-unrestricted" ||
    policy.agent_network !== "allow" ||
    !policy.process ||
    policy.tools.length !== 1 ||
    policy.tools[0] !== "*" ||
    policy.mounts.length !== 0 ||
    Object.keys(policy.limits).length !== 0
  ) {
    throw new Error(
      "DirectLauncher accepts only the explicit unsafe host-unrestricted policy; restricted policies require an enforcing sandbox.",
    );
  }
  if (request.mountPlan.sessionId.length === 0 || request.mountPlan.workspacePath !== request.cwd) {
    throw new Error("Direct launch request does not match its persisted session mount plan.");
  }
}

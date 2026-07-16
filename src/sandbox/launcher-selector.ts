import type { ExecutionPolicy } from "../security/policy.js";
import { BubblewrapLauncher } from "./bubblewrap-launcher.js";
import { DirectLauncher } from "./direct-launcher.js";
import type { LauncherProbe, SandboxLauncher } from "./launcher.js";

export interface LauncherSelector {
  select(policy: ExecutionPolicy): Promise<SandboxLauncher>;
}

export class FailClosedLauncherSelector implements LauncherSelector {
  private bubblewrapProbe: Promise<LauncherProbe> | undefined;

  constructor(
    private readonly direct = new DirectLauncher(),
    private readonly bubblewrap = new BubblewrapLauncher(),
  ) {}

  async select(policy: ExecutionPolicy): Promise<SandboxLauncher> {
    if (policy.sandbox === "disabled") {
      return this.direct;
    }

    this.bubblewrapProbe ??= this.bubblewrap.probe();
    const probe = await this.bubblewrapProbe;
    if (!probe.available) {
      throw new Error(
        `Execution policy requires an enforcing sandbox, but Bubblewrap is unavailable: ${probe.reason ?? "probe failed"}`,
      );
    }
    return this.bubblewrap;
  }
}

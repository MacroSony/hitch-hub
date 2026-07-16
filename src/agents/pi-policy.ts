import type { ExecutionPolicy } from "../security/policy.js";

const PI_TOOL_POLICY_FLAGS = new Set([
  "--tools",
  "-t",
  "--no-tools",
  "-nt",
  "--no-builtin-tools",
  "-nbt",
  "--exclude-tools",
  "-xt",
]);

export type PiPolicyEnforcement = {
  args: string[];
  tools: string[];
  processToolEnabled: boolean;
};

export function assertNoPiToolPolicyArguments(args: readonly string[]): void {
  const argument = args.find(
    (value) =>
      PI_TOOL_POLICY_FLAGS.has(value) ||
      [...PI_TOOL_POLICY_FLAGS].some((flag) => flag.startsWith("--") && value.startsWith(`${flag}=`)),
  );
  if (argument) {
    throw new Error(
      `agents.pi.default_args cannot set Pi tool policy (${argument}); configure execution_policy.tools and execution_policy.process instead.`,
    );
  }
}

export function applyPiExecutionPolicy(
  baseArgs: readonly string[],
  policy: ExecutionPolicy,
): PiPolicyEnforcement {
  assertNoPiToolPolicyArguments(baseArgs);
  const args = [...baseArgs];
  if (policy.tools.length === 0) {
    args.push("--no-tools");
  } else if (!(policy.tools.length === 1 && policy.tools[0] === "*")) {
    args.push("--tools", policy.tools.join(","));
  }

  const tools = effectiveToolsFromPiArgs(args);
  return {
    args,
    tools,
    processToolEnabled: tools.includes("bash") || tools.includes("*"),
  };
}

function effectiveToolsFromPiArgs(args: readonly string[]): string[] {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const value = args[index];
    if (value === "--no-tools" || value === "-nt") {
      return [];
    }
    if (value === "--tools" || value === "-t") {
      return uniqueTools(args[index + 1] ?? "");
    }
    if (value?.startsWith("--tools=")) {
      return uniqueTools(value.slice("--tools=".length));
    }
  }
  return ["*"];
}

function uniqueTools(value: string): string[] {
  return [...new Set(value.split(",").map((tool) => tool.trim()).filter(Boolean))];
}

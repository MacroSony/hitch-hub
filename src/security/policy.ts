import { z } from "zod";
import path from "node:path";
import type { ChatTarget, Platform } from "../core/types.js";

export const filesystemPolicyValues = ["none", "read-only", "workspace-write", "host-unrestricted"] as const;
export const sandboxModeValues = ["required", "preferred", "disabled"] as const;
export const agentNetworkPolicyValues = ["deny", "allow"] as const;
export const mountModeValues = ["ro", "rw"] as const;

export const policyMountSchema = z.object({
  host_path: z.string().min(1).refine(path.isAbsolute, "Mount host_path must be absolute."),
  sandbox_path: z
    .string()
    .startsWith("/")
    .refine(
      (value) => value !== "/" && path.posix.normalize(value) === value,
      "Mount sandbox_path must be a normalized absolute path below /.",
    ),
  mode: z.enum(mountModeValues),
});

export const executionPolicySchema = z
  .object({
    filesystem: z.enum(filesystemPolicyValues).default("workspace-write"),
    mounts: z.array(policyMountSchema).default([]),
    tools: z.array(z.string().min(1)).default(["read", "write", "edit", "grep", "find", "ls"]),
    process: z.boolean().default(false),
    agent_network: z.enum(agentNetworkPolicyValues).default("allow"),
    sandbox: z.enum(sandboxModeValues).default("required"),
    limits: z
      .object({
        timeout_ms: z.number().int().positive().optional(),
        memory_bytes: z.number().int().positive().optional(),
        max_processes: z.number().int().positive().optional(),
      })
      .default({}),
  })
  .superRefine((policy, context) => {
    if (policy.filesystem === "host-unrestricted" && policy.sandbox !== "disabled") {
      context.addIssue({
        code: "custom",
        path: ["filesystem"],
        message: "host-unrestricted filesystem access is valid only when sandbox is disabled.",
      });
    }
    const sandboxPaths = new Set<string>();
    for (const [index, mount] of policy.mounts.entries()) {
      if (sandboxPaths.has(mount.sandbox_path)) {
        context.addIssue({
          code: "custom",
          path: ["mounts", index, "sandbox_path"],
          message: `Duplicate sandbox mount path: ${mount.sandbox_path}`,
        });
      }
      sandboxPaths.add(mount.sandbox_path);
    }
  });

export type ExecutionPolicyInput = z.input<typeof executionPolicySchema>;
export type ExecutionPolicy = z.output<typeof executionPolicySchema>;
export type PolicyMount = z.output<typeof policyMountSchema>;
export type FilesystemPolicy = ExecutionPolicy["filesystem"];
export type SandboxMode = ExecutionPolicy["sandbox"];
export type AgentNetworkPolicy = ExecutionPolicy["agent_network"];

export type PrincipalIdentity = {
  platform: Platform;
  userId: string;
};

export type Principal = {
  id: string;
  identities: PrincipalIdentity[];
  allowedChatIds: Partial<Record<Platform, string[]>>;
  allowedRoots: string[];
  capabilities: string[];
};

export type AuthorizationContext = {
  principal: Principal;
  target: ChatTarget;
  allowedRoots: string[];
  executionPolicy: ExecutionPolicy;
};

export type SandboxCapability =
  | "mount_namespace"
  | "pid_namespace"
  | "ipc_namespace"
  | "uts_namespace"
  | "user_namespace"
  | "tmpfs"
  | "cleared_environment"
  | "network_namespace"
  | "resource_limits";

export type PlannedMount = {
  hostPath: string;
  sandboxPath: string;
  mode: "ro" | "rw";
  purpose: "runtime" | "workspace" | "state" | "agent-config" | "policy";
};

export type MountPlan = {
  principalId: string;
  sessionId: string;
  workspacePath: string;
  statePath: string;
  mounts: PlannedMount[];
};

export const DEFAULT_REMOTE_EXECUTION_POLICY: ExecutionPolicy = executionPolicySchema.parse({});

export const UNSAFE_DIRECT_EXECUTION_POLICY: ExecutionPolicy = executionPolicySchema.parse({
  filesystem: "host-unrestricted",
  tools: ["*"],
  process: true,
  sandbox: "disabled",
});

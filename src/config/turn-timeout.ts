import type { HubConfig } from "./schema.js";

const DEFAULT_TOOL_EXTENSION_MS = 60_000;
const DEFAULT_MAX_ACTIVE_MS = 30 * 60 * 1000;
const DEFAULT_STALL_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_MS = 10 * 60 * 1000;
const DEFAULT_INPUT_MS = 5 * 60 * 1000;

export type TurnTimeoutPolicy = {
  baseActiveMs: number;
  toolExtensionMs: number;
  maxActiveMs: number;
  stallMs: number;
  toolMs: number;
  approvalMs: number;
  inputMs: number;
};

export function resolveTurnTimeoutPolicy(config: HubConfig): TurnTimeoutPolicy {
  const baseActiveMs = config.agent_turn_timeout_ms;
  return {
    baseActiveMs,
    toolExtensionMs: config.agent_turn_tool_extension_ms ?? DEFAULT_TOOL_EXTENSION_MS,
    maxActiveMs: config.agent_turn_max_timeout_ms ?? Math.max(baseActiveMs, DEFAULT_MAX_ACTIVE_MS),
    stallMs: config.agent_turn_stall_timeout_ms ?? DEFAULT_STALL_MS,
    toolMs: config.agent_tool_timeout_ms ?? DEFAULT_TOOL_MS,
    approvalMs: config.approval_timeout_ms,
    inputMs: config.agent_input_timeout_ms ?? DEFAULT_INPUT_MS,
  };
}

import type { HubAttachment, HubSession } from "../core/types.js";
import type { AgentToolContext } from "../core/tool-bridge.js";

export type AgentInput = {
  text: string;
  attachments?: HubAttachment[];
};

export type AgentCommandInput = {
  raw: string;
  attachments?: HubAttachment[];
};

export type AgentInteractionOption = {
  label: string;
  description?: string;
  value: unknown;
};

export type AgentInteraction = {
  kind: string;
  title: string;
  options: AgentInteractionOption[];
  pageSize?: number;
};

export type AgentSelectionInput = {
  kind: string;
  label: string;
  value: unknown;
};

export type AgentCommandResult = {
  text?: string;
  consumesEvents?: boolean;
  interaction?: AgentInteraction;
};

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "final"; text: string; interrupted?: boolean }
  | { type: "tool_call"; name: string; preview?: string }
  | { type: "tool_result"; name: string; text?: string; succeeded?: boolean }
  | { type: "notification"; text: string; level?: string; completesTurn?: boolean }
  | { type: "approval_request"; raw: unknown }
  | { type: "interaction_request"; interaction: AgentInteraction; raw?: unknown }
  | { type: "status"; state: "running" | "idle" | "waiting" | "error" };

export type AgentModelInfo = {
  provider?: string;
  id?: string;
  name?: string;
};

export interface AgentBackend {
  start(session: HubSession, toolContext?: AgentToolContext): Promise<number | undefined>;
  send(input: AgentInput): Promise<void>;
  executeCommand?(input: AgentCommandInput): Promise<AgentCommandResult>;
  executeSelection?(input: AgentSelectionInput): Promise<AgentCommandResult>;
  respondToApproval?(raw: unknown, decision: "allowed" | "denied"): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  isAlive(): boolean;
  abort(): Promise<void>;
  stop(): Promise<void>;
}

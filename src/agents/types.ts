import type { HubAttachment, HubSession } from "../core/types.js";

export type AgentInput = {
  text: string;
  attachments?: HubAttachment[];
};

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "final"; text: string }
  | { type: "tool_call"; name: string; preview?: string }
  | { type: "tool_result"; name: string; text?: string }
  | { type: "approval_request"; raw: unknown }
  | { type: "status"; state: "running" | "idle" | "waiting" | "error" };

export interface AgentBackend {
  start(session: HubSession): Promise<number | undefined>;
  send(input: AgentInput): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  isAlive(): boolean;
  abort(): Promise<void>;
  stop(): Promise<void>;
}

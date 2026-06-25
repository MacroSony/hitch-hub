import type { HubSession } from "../core/types.js";

export type AgentInput = {
  text: string;
};

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "final"; text: string }
  | { type: "status"; state: "running" | "idle" | "waiting" | "error" };

export interface AgentBackend {
  start(session: HubSession): Promise<void>;
  send(input: AgentInput): Promise<void>;
  events(): AsyncIterable<AgentEvent>;
  abort(): Promise<void>;
  stop(): Promise<void>;
}

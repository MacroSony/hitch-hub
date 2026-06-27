import type { ChatTarget, HubAttachment } from "../core/types.js";

export type InboundChatEvent = {
  id: string;
  target: ChatTarget;
  text: string;
  attachments?: HubAttachment[];
  receivedAt: string;
};

export type SendOptions = {
  replyToEventId?: string;
};

export type OutboundArtifact = {
  path: string;
  kind: "image" | "file";
  caption?: string;
};

export interface ChannelAdapter {
  receive(): AsyncIterable<InboundChatEvent>;
  sendText(target: ChatTarget, text: string, opts?: SendOptions): Promise<void>;
  sendArtifact?(target: ChatTarget, artifact: OutboundArtifact, opts?: SendOptions): Promise<void>;
}

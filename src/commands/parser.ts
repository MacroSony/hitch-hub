export type HubCommand =
  | { type: "new"; agent: string; cwd: string }
  | { type: "status" }
  | { type: "cwd" }
  | { type: "abort" }
  | { type: "approve"; id: string }
  | { type: "deny"; id: string }
  | { type: "prompt"; text: string };

export function parseCommand(text: string): HubCommand {
  const trimmed = text.trim();

  if (!trimmed.startsWith("!")) {
    return { type: "prompt", text };
  }

  const [command, ...args] = trimmed.slice(1).split(/\s+/);

  switch (command) {
    case "new": {
      const [agent, ...cwdParts] = args;
      if (!agent || cwdParts.length === 0) {
        throw new Error("Usage: !new <agent> <cwd>");
      }
      return { type: "new", agent, cwd: cwdParts.join(" ") };
    }
    case "status":
      return { type: "status" };
    case "cwd":
      return { type: "cwd" };
    case "abort":
      return { type: "abort" };
    case "approve": {
      const [id] = args;
      if (!id) {
        throw new Error("Usage: !approve <approval-id>");
      }
      return { type: "approve", id };
    }
    case "deny": {
      const [id] = args;
      if (!id) {
        throw new Error("Usage: !deny <approval-id>");
      }
      return { type: "deny", id };
    }
    default:
      return { type: "prompt", text };
  }
}

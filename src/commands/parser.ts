export type HubCommand =
  | { type: "new"; agent: string; cwd?: string }
  | { type: "status" }
  | { type: "cwd" }
  | { type: "abort" }
  | { type: "model"; model?: string }
  | { type: "models"; filter?: string }
  | { type: "approve"; id: string }
  | { type: "deny"; id: string }
  | { type: "prompt"; text: string };

export function parseCommand(text: string): HubCommand {
  const trimmed = text.trim();

  if (trimmed.startsWith("/model")) {
    const model = trimmed.slice("/model".length).trim();
    return model.length > 0 ? { type: "model", model } : { type: "model" };
  }

  if (!trimmed.startsWith("!")) {
    return { type: "prompt", text };
  }

  const [command, ...args] = trimmed.slice(1).split(/\s+/);

  switch (command) {
    case "new": {
      const [agent, ...cwdParts] = args;
      if (!agent) {
        throw new Error("Usage: !new <agent> [cwd]");
      }
      const cwd = cwdParts.join(" ");
      return cwd.length > 0 ? { type: "new", agent, cwd } : { type: "new", agent };
    }
    case "status":
      return { type: "status" };
    case "cwd":
      return { type: "cwd" };
    case "abort":
      return { type: "abort" };
    case "model": {
      const model = args.join(" ");
      return model.length > 0 ? { type: "model", model } : { type: "model" };
    }
    case "models": {
      const filter = args.join(" ");
      return filter.length > 0 ? { type: "models", filter } : { type: "models" };
    }
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
      throw new Error(`Unknown Hitch command: !${command}`);
  }
}

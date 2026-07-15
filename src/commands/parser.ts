export type HubCommand =
  | { type: "new"; agent: string; cwd?: string; name?: string }
  | { type: "status" }
  | { type: "health" }
  | { type: "sessions" }
  | { type: "switch"; ref: string }
  | { type: "cwd" }
  | { type: "abort" }
  | { type: "send"; path: string; caption?: string }
  | { type: "approve"; id: string }
  | { type: "deny"; id: string }
  | { type: "agent_command"; raw: string }
  | { type: "prompt"; text: string };

export function parseCommand(text: string): HubCommand {
  const trimmed = text.trim();

  if (trimmed.startsWith("/")) {
    return { type: "agent_command", raw: trimmed };
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
      const nameMarker = cwdParts.indexOf("--name");
      const effectiveCwdParts = nameMarker >= 0 ? cwdParts.slice(0, nameMarker) : cwdParts;
      const nameParts = nameMarker >= 0 ? cwdParts.slice(nameMarker + 1) : [];
      const cwd = effectiveCwdParts.join(" ");
      const name = nameParts.join(" ").trim();
      if (nameMarker >= 0 && name.length === 0) {
        throw new Error("Usage: !new <agent> [cwd] --name <session-name>");
      }
      return {
        type: "new",
        agent,
        ...(cwd.length > 0 ? { cwd } : {}),
        ...(name.length > 0 ? { name } : {}),
      };
    }
    case "status":
      return { type: "status" };
    case "health":
      return { type: "health" };
    case "sessions":
      return { type: "sessions" };
    case "switch": {
      const ref = args.join(" ").trim();
      if (!ref) {
        throw new Error("Usage: !switch <session-id-or-name>");
      }
      return { type: "switch", ref };
    }
    case "cwd":
      return { type: "cwd" };
    case "abort":
      return { type: "abort" };
    case "send": {
      const [mediaPath, ...captionParts] = args;
      if (!mediaPath) {
        throw new Error("Usage: !send <absolute-path> [caption]");
      }
      const caption = captionParts.join(" ").trim();
      return {
        type: "send",
        path: mediaPath,
        ...(caption.length > 0 ? { caption } : {}),
      };
    }
    case "model": {
      return { type: "agent_command", raw: args.length > 0 ? `/model ${args.join(" ")}` : "/model" };
    }
    case "models": {
      return { type: "agent_command", raw: args.length > 0 ? `/models ${args.join(" ")}` : "/models" };
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

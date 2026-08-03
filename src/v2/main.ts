#!/usr/bin/env node

import type { LocalProtocolCommand } from "./connectors/local/protocol.js";
import {
  CryptographicIdSource,
} from "./runtime/system.js";
import {
  executeLocalProtocolCommand,
  loadWalkingSkeletonStartupConfiguration,
  readBoundedCliImage,
  startWalkingSkeletonService,
} from "./cli/index.js";

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

interface ParsedArguments {
  readonly options: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

function parseArguments(
  args: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): ParsedArguments {
  const allowedValues = new Set(valueOptions);
  const allowedFlags = new Set(flagOptions);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (allowedFlags.has(token)) {
      if (flags.has(token)) {
        throw new CliUsageError(`duplicate option: ${token}`);
      }
      flags.add(token);
      continue;
    }
    if (!allowedValues.has(token)) {
      throw new CliUsageError(`unknown option: ${token}`);
    }
    if (options.has(token)) {
      throw new CliUsageError(`duplicate option: ${token}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`option requires a value: ${token}`);
    }
    options.set(token, value);
    index += 1;
  }
  return Object.freeze({
    options,
    flags,
    positionals: Object.freeze(positionals),
  });
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.options.get(name);
  if (value === undefined) {
    throw new CliUsageError(`missing required option: ${name}`);
  }
  return value;
}

async function runClientCommand(
  configurationPath: string,
  command: LocalProtocolCommand,
): Promise<number> {
  const configuration = loadWalkingSkeletonStartupConfiguration(
    configurationPath,
  );
  const frames = await executeLocalProtocolCommand(configuration, command);
  const response = frames.find((frame) => frame.frame === "response");
  if (response === undefined || response.frame !== "response") {
    throw new Error("local service returned no command response");
  }
  process.stdout.write(`${JSON.stringify(response.outcome)}\n`);
  for (const frame of frames) {
    if (frame.frame === "event") {
      process.stdout.write(`${JSON.stringify({ event: frame.event })}\n`);
    }
  }
  return response.outcome.status === "succeeded" ? 0 : 2;
}

async function serve(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(
    args,
    ["--config"],
    ["--development-walking-skeleton"],
  );
  if (parsed.positionals.length !== 0) {
    throw new CliUsageError("serve accepts no positional arguments");
  }
  if (!parsed.flags.has("--development-walking-skeleton")) {
    throw new CliUsageError(
      "production v2 startup is unavailable until V2-014B; the current skeleton requires --development-walking-skeleton",
    );
  }
  const configuration = loadWalkingSkeletonStartupConfiguration(
    requiredOption(parsed, "--config"),
  );
  const service = await startWalkingSkeletonService({
    configuration,
    onConnectionError(error) {
      const message = error instanceof Error
        ? `${error.name}: ${error.message}`
        : "unknown local connection error";
      process.stderr.write(`${JSON.stringify({ level: "error", message })}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({
    status: "ready",
    mode: configuration.mode,
    socketPath: service.socketPath,
  })}\n`);

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void service.close().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function createSession(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args, [
    "--config",
    "--profile",
    "--workspace",
    "--name",
  ]);
  if (parsed.positionals.length !== 0) {
    throw new CliUsageError("session create accepts no positional arguments");
  }
  return await runClientCommand(requiredOption(parsed, "--config"), {
    kind: "create-session",
    profileReference: requiredOption(parsed, "--profile"),
    workspaceReference: requiredOption(parsed, "--workspace"),
    ...(parsed.options.has("--name")
      ? { displayName: parsed.options.get("--name")! }
      : {}),
  });
}

function sessionSelector(parsed: ParsedArguments) {
  const general = parsed.options.get("--session");
  const byId = parsed.options.get("--session-id");
  const byName = parsed.options.get("--session-name");
  const supplied = [general, byId, byName].filter(
    (value) => value !== undefined,
  );
  if (supplied.length !== 1) {
    throw new CliUsageError(
      "prompt requires exactly one of --session, --session-id, or --session-name",
    );
  }
  if (byId !== undefined) {
    return { kind: "session-id" as const, sessionId: byId as never };
  }
  if (byName !== undefined) {
    return { kind: "session-name" as const, name: byName };
  }
  return general!.includes(":")
    ? { kind: "session-id" as const, sessionId: general as never }
    : { kind: "session-name" as const, name: general! };
}

async function prompt(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args, [
    "--config",
    "--session",
    "--session-id",
    "--session-name",
    "--idempotency-key",
    "--image",
  ]);
  if (parsed.positionals.length === 0) {
    throw new CliUsageError("prompt requires non-empty text");
  }
  const text = parsed.positionals.join(" ");
  const idempotencyKey = parsed.options.get("--idempotency-key") ??
    new CryptographicIdSource().nextTurnIdempotencyKey();
  const imagePath = parsed.options.get("--image");
  const image = imagePath === undefined
    ? undefined
    : readBoundedCliImage(imagePath);
  return await runClientCommand(requiredOption(parsed, "--config"), {
    kind: "submit-turn",
    session: sessionSelector(parsed),
    idempotencyKey: idempotencyKey as never,
    text,
    ...(image === undefined
      ? {}
      : {
          image: {
            encoding: "base64" as const,
            byteLength: image.length,
            data: Buffer.from(image).toString("base64"),
          },
        }),
  });
}

async function showTurn(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args, ["--config"]);
  if (parsed.positionals.length !== 1) {
    throw new CliUsageError("turn show requires exactly one Turn ID");
  }
  return await runClientCommand(requiredOption(parsed, "--config"), {
    kind: "get-turn",
    turnId: parsed.positionals[0] as never,
  });
}

async function main(args: readonly string[]): Promise<number> {
  const [command, subcommand, ...rest] = args;
  if (command === "serve") return await serve(args.slice(1));
  if (command === "session" && subcommand === "create") {
    return await createSession(rest);
  }
  if (command === "prompt") return await prompt(args.slice(1));
  if (command === "turn" && subcommand === "show") {
    return await showTurn(rest);
  }
  throw new CliUsageError(
    "usage: hitch-v2 serve|session create|prompt|turn show (all commands require --config)",
  );
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}

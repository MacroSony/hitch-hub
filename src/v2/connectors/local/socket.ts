import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { join } from "node:path";

import type {
  AcceptedLocalConnectorConnection,
  AuthenticatedConnectorContext,
  ConnectorResponseEvent,
  LocalConnectorAuthenticationPort,
} from "../../model/application.js";
import type {
  PreparedV2DataRoot,
} from "../../persistence/root.js";
import {
  revalidateV2DataRoot,
} from "../../persistence/root.js";
import {
  LocalProtocolCorrelationGuard,
  decodeLocalProtocolClientJsonlFrame,
  encodeLocalProtocolServerJsonlFrame,
} from "./framing.js";
import type {
  LocalProtocolClientFrame,
  LocalProtocolCommandOutcome,
  LocalProtocolServerFrame,
} from "./protocol.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  decodeLocalProtocolServerFrame,
} from "./protocol.js";

export const LOCAL_PROTOCOL_RUN_DIRECTORY = "run";
export const LOCAL_PROTOCOL_SOCKET_FILENAME = "hitch.sock";

export const LOCAL_SOCKET_LIMITS = Object.freeze({
  maximumConcurrentConnections: 64,
  requestReadTimeoutMs: 30_000,
  shutdownGraceMs: 1_000,
  staleProbeTimeoutMs: 1_000,
});

export interface LocalAcceptedConnectionIssuer {
  issueAcceptedConnection(): AcceptedLocalConnectorConnection;
}

export interface AuthenticatedLocalProtocolExchange {
  readonly context: AuthenticatedConnectorContext;
  readonly request: LocalProtocolClientFrame;
  readonly signal: AbortSignal;
  respond(outcome: LocalProtocolCommandOutcome): Promise<void>;
  emit(event: ConnectorResponseEvent): Promise<void>;
  endStream(): Promise<void>;
}

export interface ListenLocalProtocolSocketOptions {
  readonly root: PreparedV2DataRoot;
  readonly connectionIssuer: LocalAcceptedConnectionIssuer;
  readonly authentication: LocalConnectorAuthenticationPort;
  readonly handle: (
    exchange: AuthenticatedLocalProtocolExchange,
  ) => Promise<void>;
  readonly onConnectionError?: (error: unknown) => void;
  /** Trusted tests/composition may narrow, never widen, the absolute deadline. */
  readonly requestDeadlineMs?: number;
}

export interface LocalProtocolSocketServer {
  readonly socketPath: string;
  readonly isClosing: boolean;
  readonly isClosed: boolean;
  close(): Promise<void>;
}

export class LocalSocketSecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalSocketSecurityError";
  }
}

export class LocalSocketProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalSocketProtocolError";
  }
}

interface FilesystemIdentity {
  readonly device: number;
  readonly inode: number;
}

interface ActiveConnection {
  readonly socket: Socket;
  readonly abort: AbortController;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function currentUserOwns(stat: Stats, subject: string): void {
  if (
    process.platform !== "win32" &&
    stat.uid !== process.getuid?.()
  ) {
    throw new LocalSocketSecurityError(
      `${subject} must be owned by the service account`,
    );
  }
}

function requireExactMode(
  stat: Stats,
  expected: number,
  subject: string,
): void {
  if ((stat.mode & 0o777) !== expected) {
    throw new LocalSocketSecurityError(
      `${subject} must have mode ${expected.toString(8)}`,
    );
  }
}

function requireRunDirectory(path: string): FilesystemIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new LocalSocketSecurityError(
      "unable to inspect the local protocol run directory",
      { cause: error },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalSocketSecurityError(
      "local protocol run path must be a real directory",
    );
  }
  currentUserOwns(stat, "local protocol run directory");
  requireExactMode(stat, 0o700, "local protocol run directory");
  if (realpathSync(path) !== path) {
    throw new LocalSocketSecurityError(
      "local protocol run directory must have a canonical path",
    );
  }
  return { device: stat.dev, inode: stat.ino };
}

function requireSocket(path: string): FilesystemIdentity {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new LocalSocketSecurityError(
      "unable to inspect the local protocol socket",
      { cause: error },
    );
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new LocalSocketSecurityError(
      "local protocol path must be a Unix socket, never a symlink",
    );
  }
  currentUserOwns(stat, "local protocol socket");
  requireExactMode(stat, 0o600, "local protocol socket");
  if (process.platform !== "win32" && stat.nlink !== 1) {
    throw new LocalSocketSecurityError(
      "local protocol socket must not have hard links",
    );
  }
  return { device: stat.dev, inode: stat.ino };
}

function requireIdentity(
  actual: FilesystemIdentity,
  expected: FilesystemIdentity,
  subject: string,
): void {
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode
  ) {
    throw new LocalSocketSecurityError(
      `${subject} was replaced after validation`,
    );
  }
}

function prepareRunDirectory(
  root: PreparedV2DataRoot,
): {
  readonly path: string;
  readonly identity: FilesystemIdentity;
} {
  revalidateV2DataRoot(root);
  const path = join(root.path, LOCAL_PROTOCOL_RUN_DIRECTORY);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw new LocalSocketSecurityError(
        "unable to create the local protocol run directory",
        { cause: error },
      );
    }
  }
  const identity = requireRunDirectory(path);
  revalidateV2DataRoot(root);
  requireIdentity(
    requireRunDirectory(path),
    identity,
    "local protocol run directory",
  );
  return { path, identity };
}

function requireKnownRunEntries(
  runPath: string,
): "absent" | "socket" {
  const entries = readdirSync(runPath);
  for (const entry of entries) {
    if (entry !== LOCAL_PROTOCOL_SOCKET_FILENAME) {
      throw new LocalSocketSecurityError(
        `local protocol run directory contains unknown entry: ${entry}`,
      );
    }
  }
  return entries.includes(LOCAL_PROTOCOL_SOCKET_FILENAME)
    ? "socket"
    : "absent";
}

async function probeSocket(path: string): Promise<"live" | "stale" | "absent"> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (
      outcome: "live" | "stale" | "absent" | Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        finish(
          new LocalSocketSecurityError(
            "timed out while probing an existing local socket",
          ),
        ),
      LOCAL_SOCKET_LIMITS.staleProbeTimeoutMs,
    );
    timer.unref();
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => {
      if (isNodeError(error, "ECONNREFUSED")) {
        finish("stale");
      } else if (isNodeError(error, "ENOENT")) {
        finish("absent");
      } else {
        finish(
          new LocalSocketSecurityError(
            "cannot safely classify the existing local socket",
            { cause: error },
          ),
        );
      }
    });
  });
}

async function removeProvenStaleSocket(
  root: PreparedV2DataRoot,
  runPath: string,
  runIdentity: FilesystemIdentity,
  socketPath: string,
): Promise<void> {
  if (requireKnownRunEntries(runPath) === "absent") return;
  const socketIdentity = requireSocket(socketPath);
  const state = await probeSocket(socketPath);
  if (state === "live") {
    throw new LocalSocketSecurityError(
      "another local protocol server is already listening",
    );
  }
  revalidateV2DataRoot(root);
  requireIdentity(
    requireRunDirectory(runPath),
    runIdentity,
    "local protocol run directory",
  );
  if (state === "absent") {
    if (requireKnownRunEntries(runPath) === "socket") {
      throw new LocalSocketSecurityError(
        "local protocol socket changed while it was probed",
      );
    }
    return;
  }
  requireIdentity(
    requireSocket(socketPath),
    socketIdentity,
    "stale local protocol socket",
  );
  unlinkSync(socketPath);
  if (requireKnownRunEntries(runPath) !== "absent") {
    throw new LocalSocketSecurityError(
      "stale local protocol socket removal did not converge",
    );
  }
}

function abortError(): LocalSocketProtocolError {
  return new LocalSocketProtocolError(
    "local protocol connection was closed",
  );
}

async function raceAbort<Value>(
  work: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) throw abortError();
  let removeAbort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const listener = (): void => reject(abortError());
    signal.addEventListener("abort", listener, { once: true });
    removeAbort = () => signal.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    removeAbort();
  }
}

async function readOneClientFrame(
  socket: Socket,
  signal: AbortSignal,
): Promise<LocalProtocolClientFrame> {
  if (signal.aborted || socket.destroyed) throw abortError();
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(abortError());
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(
          decodeLocalProtocolClientJsonlFrame(
            Buffer.concat(chunks, byteLength),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    const onClose = (): void => fail(abortError());
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      const previousLength = byteLength;
      byteLength += chunk.length;
      if (byteLength > LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
        fail(
          new LocalSocketProtocolError(
            "local request frame exceeds its byte limit",
          ),
        );
        return;
      }
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        chunks.push(Buffer.from(chunk));
        if (byteLength >= LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
          fail(
            new LocalSocketProtocolError(
              "local request frame exceeds its byte limit",
            ),
          );
        }
        return;
      }
      if (previousLength + newline !== byteLength - 1) {
        fail(
          new LocalSocketProtocolError(
            "local request frame carries data after its terminating line break",
          ),
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
      settled = true;
      cleanup();
      try {
        resolve(
          decodeLocalProtocolClientJsonlFrame(
            Buffer.concat(chunks, byteLength),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || socket.destroyed) onAbort();
  });
}

async function writeFrame(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed || !socket.writable) throw abortError();
  await new Promise<void>((resolve, reject) => {
    socket.write(Buffer.from(bytes), (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error);
      else resolve();
    });
  });
}

function serverFrame(
  requestId: string,
  frame:
    | {
        readonly frame: "response";
        readonly outcome: LocalProtocolCommandOutcome;
      }
    | {
        readonly frame: "event";
        readonly event: ConnectorResponseEvent;
      }
    | {
        readonly frame: "stream-end";
      },
): LocalProtocolServerFrame {
  return decodeLocalProtocolServerFrame({
    protocol: "hitch.local",
    version: 1,
    requestId,
    ...frame,
  });
}

function createExchange(
  socket: Socket,
  signal: AbortSignal,
  context: AuthenticatedConnectorContext,
  request: LocalProtocolClientFrame,
): {
  readonly exchange: AuthenticatedLocalProtocolExchange;
  readonly correlation: LocalProtocolCorrelationGuard;
  awaitWrites(): Promise<void>;
} {
  const correlation = new LocalProtocolCorrelationGuard();
  correlation.acceptClient(request);
  let writes: Promise<void> = Promise.resolve();
  const send = (frame: LocalProtocolServerFrame): Promise<void> => {
    writes = writes.then(async () => {
      correlation.acceptServer(frame);
      await writeFrame(
        socket,
        encodeLocalProtocolServerJsonlFrame(frame),
      );
    });
    return writes;
  };
  const exchange: AuthenticatedLocalProtocolExchange = Object.freeze({
    context,
    request,
    signal,
    respond: (outcome: LocalProtocolCommandOutcome) =>
      send(
        serverFrame(request.requestId, {
          frame: "response",
          outcome,
        }),
      ),
    emit: (event: ConnectorResponseEvent) =>
      send(
        serverFrame(request.requestId, {
          frame: "event",
          event,
        }),
      ),
    endStream: () =>
      send(
        serverFrame(request.requestId, {
          frame: "stream-end",
        }),
      ),
  });
  return {
    exchange,
    correlation,
    awaitWrites: () => writes,
  };
}

function reportConnectionError(
  options: ListenLocalProtocolSocketOptions,
  error: unknown,
): void {
  try {
    options.onConnectionError?.(error);
  } catch {
    // Error observation is never allowed to keep a connection alive.
  }
}

function revalidateLiveSocket(
  root: PreparedV2DataRoot,
  runPath: string,
  runIdentity: FilesystemIdentity,
  socketPath: string,
  socketIdentity: FilesystemIdentity,
): void {
  revalidateV2DataRoot(root);
  requireIdentity(
    requireRunDirectory(runPath),
    runIdentity,
    "local protocol run directory",
  );
  requireIdentity(
    requireSocket(socketPath),
    socketIdentity,
    "local protocol socket",
  );
}

async function cleanupExactSocket(
  runPath: string,
  runIdentity: FilesystemIdentity,
  socketPath: string,
  socketIdentity: FilesystemIdentity,
): Promise<void> {
  requireIdentity(
    requireRunDirectory(runPath),
    runIdentity,
    "local protocol run directory",
  );
  let actual: FilesystemIdentity;
  try {
    actual = requireSocket(socketPath);
  } catch (error) {
    if (
      error instanceof LocalSocketSecurityError &&
      isNodeError(error.cause, "ENOENT")
    ) {
      return;
    }
    throw error;
  }
  requireIdentity(actual, socketIdentity, "local protocol socket");
  unlinkSync(socketPath);
}

class RunningLocalProtocolSocketServer
  implements LocalProtocolSocketServer
{
  readonly socketPath: string;
  readonly #server: Server;
  readonly #runPath: string;
  readonly #runIdentity: FilesystemIdentity;
  readonly #socketIdentity: FilesystemIdentity;
  readonly #connections: Set<ActiveConnection>;
  readonly #stopAccepting: () => void;
  readonly #reportError: (error: unknown) => void;
  #closePromise?: Promise<void>;
  #closing = false;
  #closed = false;
  #listenerClosed = false;
  #fatal = false;

  constructor(input: {
    readonly socketPath: string;
    readonly server: Server;
    readonly runPath: string;
    readonly runIdentity: FilesystemIdentity;
    readonly socketIdentity: FilesystemIdentity;
    readonly connections: Set<ActiveConnection>;
    readonly stopAccepting: () => void;
    readonly reportError: (error: unknown) => void;
  }) {
    this.socketPath = input.socketPath;
    this.#server = input.server;
    this.#runPath = input.runPath;
    this.#runIdentity = input.runIdentity;
    this.#socketIdentity = input.socketIdentity;
    this.#connections = input.connections;
    this.#stopAccepting = input.stopAccepting;
    this.#reportError = input.reportError;
    this.#server.once("close", () => {
      this.#listenerClosed = true;
      this.#stopAccepting();
    });
  }

  get isClosing(): boolean {
    return this.#closing;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  close(): Promise<void> {
    return this.#startClose();
  }

  fail(error: unknown): void {
    this.#fatal = true;
    this.#reportError(error);
    for (const connection of this.#connections) {
      connection.abort.abort();
      connection.socket.destroy();
    }
    void this.#startClose().catch((closeError) => {
      this.#reportError(closeError);
    });
  }

  #startClose(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#stopAccepting();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    for (const connection of this.#connections) {
      connection.abort.abort();
      if (this.#fatal) connection.socket.destroy();
      else connection.socket.end();
    }
    const force = setTimeout(() => {
      for (const connection of this.#connections) {
        connection.socket.destroy();
      }
    }, LOCAL_SOCKET_LIMITS.shutdownGraceMs);
    force.unref();
    try {
      await this.#stopListener();
      await cleanupExactSocket(
        this.#runPath,
        this.#runIdentity,
        this.socketPath,
        this.#socketIdentity,
      );
    } finally {
      clearTimeout(force);
      this.#closed = true;
    }
  }

  async #stopListener(): Promise<void> {
    if (this.#listenerClosed) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        this.#server.off("close", onClose);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onClose = (): void => finish();
      this.#server.once("close", onClose);
      if (this.#listenerClosed) {
        finish();
        return;
      }
      if (!this.#server.listening) {
        // A fatal path has already initiated close; its close event completes
        // this same state machine.
        return;
      }
      try {
        this.#server.close((error) => {
          if (
            error !== undefined &&
            !isNodeError(error, "ERR_SERVER_NOT_RUNNING")
          ) {
            finish(error);
          }
        });
      } catch (error) {
        if (isNodeError(error, "ERR_SERVER_NOT_RUNNING")) {
          if (this.#listenerClosed) finish();
          return;
        }
        finish(
          error instanceof Error
            ? error
            : new Error("unable to stop local protocol listener"),
        );
      }
    });
  }
}

export async function listenLocalProtocolSocket(
  options: ListenLocalProtocolSocketOptions,
): Promise<LocalProtocolSocketServer> {
  if (process.platform === "win32") {
    throw new LocalSocketSecurityError(
      "the v2 local Unix socket is unsupported on Windows",
    );
  }
  if (
    options.requestDeadlineMs !== undefined &&
    (!Number.isFinite(options.requestDeadlineMs) ||
      options.requestDeadlineMs <= 0)
  ) {
    throw new LocalSocketSecurityError(
      "the local protocol request deadline must be a positive finite duration",
    );
  }
  const run = prepareRunDirectory(options.root);
  const socketPath = join(run.path, LOCAL_PROTOCOL_SOCKET_FILENAME);
  await removeProvenStaleSocket(
    options.root,
    run.path,
    run.identity,
    socketPath,
  );

  const connections = new Set<ActiveConnection>();
  let socketIdentity: FilesystemIdentity | undefined;
  let accepting = true;
  const server = createServer((socket) => {
    if (
      !accepting ||
      socketIdentity === undefined ||
      connections.size >=
        LOCAL_SOCKET_LIMITS.maximumConcurrentConnections
    ) {
      socket.destroy();
      return;
    }
    try {
      revalidateLiveSocket(
        options.root,
        run.path,
        run.identity,
        socketPath,
        socketIdentity,
      );
    } catch (error) {
      accepting = false;
      reportConnectionError(options, error);
      socket.destroy();
      server.close();
      return;
    }

    const abort = new AbortController();
    let clearDeadline = (): void => undefined;
    if (options.requestDeadlineMs !== undefined) {
      const deadline = setTimeout(() => {
        abort.abort();
        socket.destroy();
      }, options.requestDeadlineMs);
      deadline.unref();
      clearDeadline = () => clearTimeout(deadline);
    }
    const active = { socket, abort };
    connections.add(active);
    socket.on("error", () => undefined);
    socket.once("close", () => {
      clearDeadline();
      abort.abort();
      connections.delete(active);
    });
    socket.setTimeout(LOCAL_SOCKET_LIMITS.requestReadTimeoutMs, () => {
      abort.abort();
      socket.destroy();
    });

    void (async () => {
      try {
        const accepted = options.connectionIssuer.issueAcceptedConnection();
        const authentication = await raceAbort(
          options.authentication.authenticate(accepted),
          abort.signal,
        );
        if (authentication.status !== "authenticated") {
          socket.destroy();
          return;
        }
        const request = await readOneClientFrame(socket, abort.signal);
        socket.setTimeout(0);
        const prepared = createExchange(
          socket,
          abort.signal,
          authentication.context,
          request,
        );
        const handling = Promise.resolve(
          options.handle(prepared.exchange),
        );
        handling.catch(() => undefined);
        await raceAbort(handling, abort.signal);
        await prepared.awaitWrites();
        if (!prepared.correlation.isComplete) {
          throw new LocalSocketProtocolError(
            "local handler returned before completing its response exchange",
          );
        }
        socket.end();
      } catch (error) {
        if (!abort.signal.aborted) reportConnectionError(options, error);
        socket.destroy();
      }
    })();
  });
  server.maxConnections =
    LOCAL_SOCKET_LIMITS.maximumConcurrentConnections;

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    chmodSync(socketPath, 0o600);
    socketIdentity = requireSocket(socketPath);
    revalidateLiveSocket(
      options.root,
      run.path,
      run.identity,
      socketPath,
      socketIdentity,
    );
  } catch (error) {
    accepting = false;
    try {
      server.close();
    } catch {
      // Preserve the setup error.
    }
    if (socketIdentity !== undefined) {
      try {
        await cleanupExactSocket(
          run.path,
          run.identity,
          socketPath,
          socketIdentity,
        );
      } catch {
        // Preserve the setup error and leave uncertain state for inspection.
      }
    }
    throw new LocalSocketSecurityError(
      "unable to start the local protocol socket",
      { cause: error },
    );
  }

  const running = new RunningLocalProtocolSocketServer({
    socketPath,
    server,
    runPath: run.path,
    runIdentity: run.identity,
    socketIdentity,
    connections,
    stopAccepting: () => {
      accepting = false;
    },
    reportError: (error) => reportConnectionError(options, error),
  });
  server.on("close", () => {
    accepting = false;
  });
  server.on("error", (error) => {
    accepting = false;
    reportConnectionError(options, error);
  });
  return running;
}

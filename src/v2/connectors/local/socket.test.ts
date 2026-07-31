import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import test from "node:test";

import type {
  AcceptedLocalConnectorConnection,
  AuthenticatedConnectorContext,
  ConnectorAuthenticationResult,
} from "../../model/application.js";
import {
  prepareV2DataRoot,
  type PreparedV2DataRoot,
} from "../../persistence/root.js";
import { withDisposableDataRoot } from "../../test-support/disposable-data-root.js";
import {
  decodeLocalProtocolServerJsonlFrame,
  encodeLocalProtocolClientJsonlFrame,
} from "./framing.js";
import {
  LOCAL_PROTOCOL_LIMITS,
  decodeLocalProtocolClientFrame,
  type LocalProtocolCommandOutcome,
} from "./protocol.js";
import {
  LOCAL_PROTOCOL_RUN_DIRECTORY,
  LOCAL_PROTOCOL_SOCKET_FILENAME,
  LocalSocketSecurityError,
  listenLocalProtocolSocket,
  type AuthenticatedLocalProtocolExchange,
  type ListenLocalProtocolSocketOptions,
} from "./socket.js";

const AUTHENTICATED_CONTEXT = Object.freeze({
  actor: Object.freeze({
    kind: "authenticated-principal",
    principalId: "principal-1",
    identityBindingId: "binding-1",
    method: "local-peer",
    assurance: "normal",
    requestId: "authentication-1",
    authenticatedAt: "2026-07-29T12:00:00.000Z",
  }),
  endpointId: "endpoint-1",
}) as AuthenticatedConnectorContext;

function clientRequest(command: unknown): Uint8Array {
  return encodeLocalProtocolClientJsonlFrame(
    decodeLocalProtocolClientFrame({
      protocol: "hitch.local",
      version: 1,
      frame: "request",
      requestId: "request-1",
      command,
    }),
  );
}

function authenticatedOptions(
  root: PreparedV2DataRoot,
  handle: (
    exchange: AuthenticatedLocalProtocolExchange,
  ) => Promise<void>,
  errors: unknown[] = [],
): ListenLocalProtocolSocketOptions & {
  readonly issued: { count: number };
  readonly authenticated: { count: number };
} {
  const issued = { count: 0 };
  const authenticated = { count: 0 };
  const accepted = Object.freeze(
    {},
  ) as AcceptedLocalConnectorConnection;
  return {
    root,
    connectionIssuer: {
      issueAcceptedConnection() {
        issued.count += 1;
        return accepted;
      },
    },
    authentication: {
      async authenticate(connection) {
        authenticated.count += 1;
        assert.equal(connection, accepted);
        return {
          status: "authenticated",
          context: AUTHENTICATED_CONTEXT,
        };
      },
    },
    handle,
    onConnectionError: (error) => errors.push(error),
    issued,
    authenticated,
  };
}

async function sendAndCollect(
  socketPath: string,
  bytes: Uint8Array,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let connected = false;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    socket.on("connect", () => {
      connected = true;
      socket.write(Buffer.from(bytes));
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (!connected) reject(error);
    });
  });
}

async function listenRawSocket(path: string): Promise<{
  close(): Promise<void>;
}> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

async function leaveCrashedSocket(path: string): Promise<void> {
  const script = `
    const { chmodSync } = require("node:fs");
    const { createServer } = require("node:net");
    const path = process.argv[1];
    const server = createServer((socket) => socket.destroy());
    server.listen(path, () => {
      chmodSync(path, 0o600);
      process.stdout.write("ready\\n");
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--eval", script, path], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    child.once("error", fail);
    child.once("exit", (code) => {
      if (code !== null) {
        reject(new Error(`stale-socket child exited early with ${code}`));
      }
    });
    child.stdout!.once("data", (chunk) => {
      if (String(chunk).includes("ready")) resolve();
      else reject(new Error("stale-socket child did not become ready"));
    });
  });
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(existsSync(path), true);
}

test("owner-only local socket authenticates one framed request and removes its exact socket on close", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    let handled = 0;
    const options = authenticatedOptions(root, async (exchange) => {
      handled += 1;
      assert.equal(exchange.context, AUTHENTICATED_CONTEXT);
      assert.equal(exchange.request.command.kind, "get-turn");
      await exchange.respond({
        status: "succeeded",
        result: {
          kind: "turn-found",
          turnId: "turn-1",
          state: "queued",
          updatedAt: "2026-07-29T12:00:00.000Z",
        },
      } as LocalProtocolCommandOutcome);
    });
    const server = await listenLocalProtocolSocket(options);
    try {
      const runPath = join(root.path, LOCAL_PROTOCOL_RUN_DIRECTORY);
      assert.equal(lstatSync(runPath).mode & 0o777, 0o700);
      assert.equal(lstatSync(server.socketPath).isSocket(), true);
      assert.equal(lstatSync(server.socketPath).mode & 0o777, 0o600);

      const responseBytes = await sendAndCollect(
        server.socketPath,
        clientRequest({ kind: "get-turn", turnId: "turn-1" }),
      );
      const response =
        decodeLocalProtocolServerJsonlFrame(responseBytes);
      assert.equal(response.frame, "response");
      assert.equal(handled, 1);
      assert.equal(options.issued.count, 1);
      assert.equal(options.authenticated.count, 1);
    } finally {
      await server.close();
    }
    assert.equal(existsSync(server.socketPath), false);
    assert.equal(server.isClosing, true);
    assert.equal(server.isClosed, true);
  });
});

test("authentication rejection closes before request decoding or application handling", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    let handled = 0;
    const options = authenticatedOptions(root, async () => {
      handled += 1;
    });
    const rejected: ConnectorAuthenticationResult = {
      status: "rejected",
      authenticationRequestId: "authentication-rejected",
      reason: "binding-revoked",
    } as ConnectorAuthenticationResult;
    options.authentication.authenticate = async () => rejected;
    const server = await listenLocalProtocolSocket(options);
    try {
      const response = await sendAndCollect(
        server.socketPath,
        clientRequest({ kind: "get-turn", turnId: "turn-1" }),
      );
      assert.equal(response.length, 0);
      assert.equal(handled, 0);
    } finally {
      await server.close();
    }
  });
});

test("socket request reader rejects ambiguous and oversized input without dispatch", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    let handled = 0;
    const errors: unknown[] = [];
    const options = authenticatedOptions(
      root,
      async () => {
        handled += 1;
      },
      errors,
    );
    const server = await listenLocalProtocolSocket(options);
    try {
      const duplicate = new TextEncoder().encode(
        '{"protocol":"hitch.local","version":1,"frame":"request","requestId":"request-1","requestId":"request-2","command":{"kind":"get-turn","turnId":"turn-1"}}\n',
      );
      assert.equal(
        (await sendAndCollect(server.socketPath, duplicate)).length,
        0,
      );
      const twoFrames = Buffer.concat([
        Buffer.from(
          clientRequest({ kind: "get-turn", turnId: "turn-1" }),
        ),
        Buffer.from(
          clientRequest({ kind: "get-turn", turnId: "turn-2" }),
        ),
      ]);
      assert.equal(
        (await sendAndCollect(server.socketPath, twoFrames)).length,
        0,
      );
      assert.equal(
        (
          await sendAndCollect(
            server.socketPath,
            new Uint8Array(LOCAL_PROTOCOL_LIMITS.maximumFrameBytes),
          )
        ).length,
        0,
      );
      assert.equal(handled, 0);
      assert.ok(errors.length >= 3);
    } finally {
      await server.close();
    }
  });
});

test("socket startup rejects unsafe run state and an already-live listener", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const wrongMode = prepareV2DataRoot(
      disposable.resolve("wrong-mode"),
    );
    mkdirSync(
      join(wrongMode.path, LOCAL_PROTOCOL_RUN_DIRECTORY),
      { mode: 0o755 },
    );
    await assert.rejects(
      listenLocalProtocolSocket(
        authenticatedOptions(wrongMode, async () => undefined),
      ),
    );

    const symlinked = prepareV2DataRoot(
      disposable.resolve("symlinked"),
    );
    const target = disposable.resolve("run-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(
      target,
      join(symlinked.path, LOCAL_PROTOCOL_RUN_DIRECTORY),
    );
    await assert.rejects(
      listenLocalProtocolSocket(
        authenticatedOptions(symlinked, async () => undefined),
      ),
    );

    const unknown = prepareV2DataRoot(disposable.resolve("unknown"));
    const unknownRun = join(
      unknown.path,
      LOCAL_PROTOCOL_RUN_DIRECTORY,
    );
    mkdirSync(unknownRun, { mode: 0o700 });
    writeFileSync(join(unknownRun, "foreign"), "no", { mode: 0o600 });
    await assert.rejects(
      listenLocalProtocolSocket(
        authenticatedOptions(unknown, async () => undefined),
      ),
      LocalSocketSecurityError,
    );

    const live = prepareV2DataRoot(disposable.resolve("live"));
    const liveRun = join(live.path, LOCAL_PROTOCOL_RUN_DIRECTORY);
    mkdirSync(liveRun, { mode: 0o700 });
    const livePath = join(liveRun, LOCAL_PROTOCOL_SOCKET_FILENAME);
    const raw = await listenRawSocket(livePath);
    try {
      await assert.rejects(
        listenLocalProtocolSocket(
          authenticatedOptions(live, async () => undefined),
        ),
        LocalSocketSecurityError,
      );
    } finally {
      await raw.close();
    }
  });
});

test("socket startup recovers only an exact owner-private crashed socket", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    const runPath = join(root.path, LOCAL_PROTOCOL_RUN_DIRECTORY);
    mkdirSync(runPath, { mode: 0o700 });
    const socketPath = join(runPath, LOCAL_PROTOCOL_SOCKET_FILENAME);
    await leaveCrashedSocket(socketPath);

    const server = await listenLocalProtocolSocket(
      authenticatedOptions(root, async () => undefined),
    );
    try {
      assert.equal(server.socketPath, socketPath);
      assert.equal(lstatSync(socketPath).isSocket(), true);
      assert.equal(lstatSync(socketPath).mode & 0o777, 0o600);
    } finally {
      await server.close();
    }
  });
});

test("an explicit request deadline aborts an over-running exchange", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedAbort = false;
    const options = authenticatedOptions(root, async (exchange) => {
      entered();
      await new Promise<void>((resolve) => {
        if (exchange.signal.aborted) {
          observedAbort = true;
          resolve();
          return;
        }
        exchange.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    const server = await listenLocalProtocolSocket({
      ...options,
      requestDeadlineMs: 50,
    });
    try {
      const socket: Socket = createConnection(server.socketPath);
      socket.on("error", () => undefined);
      await once(socket, "connect");
      socket.write(
        Buffer.from(
          clientRequest({ kind: "get-turn", turnId: "turn-1" }),
        ),
      );
      await handlerEntered;
      await once(socket, "close");
      assert.equal(observedAbort, true);
    } finally {
      await server.close();
    }
  });
});

test("socket startup rejects a non-positive request deadline", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    for (const requestDeadlineMs of [0, -1, Number.NaN, Infinity]) {
      await assert.rejects(
        listenLocalProtocolSocket({
          ...authenticatedOptions(root, async () => undefined),
          requestDeadlineMs,
        }),
        LocalSocketSecurityError,
      );
    }
  });
});

test("bounded shutdown aborts an active authenticated handler and is idempotent", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const root = prepareV2DataRoot(disposable.resolve("state"));
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedAbort = false;
    const options = authenticatedOptions(root, async (exchange) => {
      entered();
      await new Promise<void>((resolve) => {
        if (exchange.signal.aborted) {
          observedAbort = true;
          resolve();
          return;
        }
        exchange.signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    const server = await listenLocalProtocolSocket(options);
    const socket: Socket = createConnection(server.socketPath);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write(
      Buffer.from(
        clientRequest({ kind: "get-turn", turnId: "turn-1" }),
      ),
    );
    await handlerEntered;
    const first = server.close();
    const second = server.close();
    assert.equal(first, second);
    await first;
    assert.equal(observedAbort, true);
    assert.equal(server.isClosed, true);
    socket.destroy();
  });
});

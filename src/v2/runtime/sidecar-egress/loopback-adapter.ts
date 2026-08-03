import { createConnection, createServer, type Server, type Socket } from "node:net";

import { SIDECAR_EGRESS_RELAY_SOCKET } from "./connect-relay.js";
import { SIDECAR_EGRESS_PROXY_PORT } from "./proxy-environment.js";

const MAX_CONCURRENT_CONNECTIONS = 8;

export interface RunningSidecarLoopbackAdapter {
  readonly host: "127.0.0.1";
  readonly port: typeof SIDECAR_EGRESS_PROXY_PORT;
  close(): Promise<void>;
}

interface AdapterConnection {
  readonly client: Socket;
  readonly relay: Socket;
}

/**
 * Runs inside the sidecar's empty network namespace. It adds no routing: the
 * fixed loopback listener only transports bytes to the mounted pathname UDS.
 */
export async function startSidecarLoopbackAdapter(
): Promise<RunningSidecarLoopbackAdapter> {
  const connections = new Set<AdapterConnection>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((client) => {
    if (closing || connections.size >= MAX_CONCURRENT_CONNECTIONS) {
      client.destroy();
      return;
    }
    const relay = createConnection({ path: SIDECAR_EGRESS_RELAY_SOCKET });
    const connection: AdapterConnection = { client, relay };
    connections.add(connection);
    let closed = false;
    const closePair = (): void => {
      if (closed) return;
      closed = true;
      connections.delete(connection);
      client.destroy();
      relay.destroy();
    };
    client.once("close", closePair);
    relay.once("close", closePair);
    client.once("error", closePair);
    relay.once("error", closePair);
    client.pipe(relay).pipe(client);
  });
  await listen(server);
  return Object.freeze({
    host: "127.0.0.1" as const,
    port: SIDECAR_EGRESS_PROXY_PORT,
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const connection of connections) {
          connection.client.destroy();
          connection.relay.destroy();
        }
        await closeServer(server);
      })();
      return closePromise;
    },
  });
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(SIDECAR_EGRESS_PROXY_PORT, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== "127.0.0.1" ||
    address.port !== SIDECAR_EGRESS_PROXY_PORT
  ) {
    await closeServer(server);
    throw new Error("sidecar loopback adapter bound an unexpected endpoint");
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

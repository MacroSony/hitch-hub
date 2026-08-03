import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decodeTrustedUpstreamOrigin } from "../../codecs/primitives.js";
import {
  PinnedSidecarEgressPolicy,
  type AuthorizedEgressTarget,
  type ResolvedNetworkAddress,
} from "./address-policy.js";
import {
  claimSidecarEgressLaunchForSpawn,
  consumeSidecarEgressLaunchAuthorization,
  inspectTlsClientHello,
  listenPinnedConnectRelay,
  parseConnectRequest,
  PinnedHttpProxyTunnelDialer,
  SIDECAR_EGRESS_RELAY_SOCKET,
  type EgressTunnelDialer,
  type ReadySidecarEgressLaunchAuthorization,
} from "./connect-relay.js";
import { SIDECAR_EGRESS_PROXY_PORT, SIDECAR_EGRESS_PROXY_URL } from "./proxy-environment.js";

const PUBLIC_ONE: ResolvedNetworkAddress = { address: "8.8.8.8", family: 4 };
const PUBLIC_TWO: ResolvedNetworkAddress = { address: "1.1.1.1", family: 4 };

test("CONNECT parser accepts only Node's fixed proxy envelope", () => {
  const expected = (authority: string): string | undefined =>
    authority === "chatgpt.com:443" ? "chatgpt.com" : undefined;
  assert.deepEqual(
    parseConnectRequest(
      Buffer.from(
        "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\nconnection: close\r\nproxy-connection: keep-alive\r\n\r\n",
        "ascii",
      ),
      expected,
    ),
    { authority: "chatgpt.com:443", host: "chatgpt.com" },
  );
  for (const request of [
    "GET https://chatgpt.com/ HTTP/1.1\r\nhost: chatgpt.com\r\n\r\n",
    "CONNECT attacker.invalid:443 HTTP/1.1\r\nhost: attacker.invalid\r\n\r\n",
    "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: attacker.invalid\r\n\r\n",
    "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\nproxy-authorization: secret\r\n\r\n",
    "CONNECT chatgpt.com:443 HTTP/1.1\nhost: chatgpt.com\n\n",
    "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\n\r\nearly-bytes",
  ]) {
    assert.throws(() => parseConnectRequest(Buffer.from(request, "ascii"), expected));
  }
  const hello = tlsClientHello("chatgpt.com");
  assert.equal(inspectTlsClientHello(hello.subarray(0, 8), "chatgpt.com"), "incomplete");
  assert.equal(inspectTlsClientHello(hello, "chatgpt.com"), "authorized");
  assert.equal(
    inspectTlsClientHello(splitTlsHandshakeAcrossRecords(hello, 11), "chatgpt.com"),
    "authorized",
  );
  assert.throws(
    () => inspectTlsClientHello(hello, "attacker.invalid"),
    /did not match/u,
  );
});

test("pinned relay tunnels one exact authority and fails closed on DNS change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hitch-v2-egress-relay-"));
  chmodSync(directory, 0o700);
  const upstream = await listenTcpEcho();
  let answers: readonly ResolvedNetworkAddress[] = [PUBLIC_ONE];
  const policy = await PinnedSidecarEgressPolicy.pin(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    async () => answers,
  );
  let dialCount = 0;
  const dialer: EgressTunnelDialer = {
    async dial(): Promise<Socket> {
      dialCount += 1;
      return connectTcp(upstream.port);
    },
  };
  const relay = await listenPinnedConnectRelay({ directory, policy, dialer });
  try {
    const authorization = relay.prepareLaunchAuthorization();
    const fragment = consumeSidecarEgressLaunchAuthorization(authorization);
    assert.equal(fragment.network, "new-empty-network-namespace");
    assert.deepEqual(fragment.bubblewrapArguments, [
      "--unshare-net",
      "--ro-bind",
      directory,
      "/hitch-egress",
    ]);
    assert.equal(fragment.relaySocketPath, SIDECAR_EGRESS_RELAY_SOCKET);
    assert.equal(fragment.loopbackProxyPort, SIDECAR_EGRESS_PROXY_PORT);
    assert.equal(fragment.environment.HTTPS_PROXY, SIDECAR_EGRESS_PROXY_URL);
    assert.equal("https_proxy" in fragment.environment, false);
    assert.equal("NODE_OPTIONS" in fragment.environment, false);
    assert.equal(fragment.expectedRelayIdentity.directory.mode, 0o700);
    assert.equal(fragment.expectedRelayIdentity.socket.mode, 0o600);
    assert.throws(
      () => consumeSidecarEgressLaunchAuthorization(authorization),
      /already consumed/u,
    );
    assert.throws(
      () => relay.prepareLaunchAuthorization(),
      /already issued/u,
    );
    assert.throws(
      () =>
        consumeSidecarEgressLaunchAuthorization(
          {} as ReadySidecarEgressLaunchAuthorization,
        ),
      /forged/u,
    );
    assert.throws(
      () => claimSidecarEgressLaunchForSpawn({ ...fragment }),
      /forged/u,
    );

    chmodSync(directory, 0o750);
    assert.throws(
      () => claimSidecarEgressLaunchForSpawn(fragment),
      /owner-private/u,
    );
    chmodSync(directory, 0o700);
    chmodSync(relay.socketPath, 0o660);
    assert.throws(
      () => claimSidecarEgressLaunchForSpawn(fragment),
      /socket identity is unsafe/u,
    );
    chmodSync(relay.socketPath, 0o600);
    claimSidecarEgressLaunchForSpawn(fragment);
    assert.throws(
      () => claimSidecarEgressLaunchForSpawn(fragment),
      /already claimed/u,
    );

    const client = createConnection(relay.socketPath);
    await onceConnected(client);
    client.write(
      "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\nconnection: close\r\nproxy-connection: keep-alive\r\n\r\n",
    );
    assert.equal(await readOnce(client), "HTTP/1.1 200 Connection Established\r\n\r\n");
    const hello = tlsClientHello("chatgpt.com");
    client.write(hello.subarray(0, 7));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    client.write(hello.subarray(7));
    assert.deepEqual(await readBufferOnce(client), hello);
    client.destroy();
    assert.equal(dialCount, 1);

    const wrongSni = createConnection(relay.socketPath);
    await onceConnected(wrongSni);
    wrongSni.write(
      "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\n\r\n",
    );
    assert.equal(
      await readOnce(wrongSni),
      "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    wrongSni.write(tlsClientHello("attacker.invalid"));
    await onceClosed(wrongSni);
    assert.equal(dialCount, 1);

    assert.match(
      await exchange(
        relay.socketPath,
        "CONNECT attacker.invalid:443 HTTP/1.1\r\nhost: attacker.invalid\r\n\r\n",
      ),
      /^HTTP\/1\.1 403 Forbidden/u,
    );
    assert.equal(dialCount, 1);

    answers = [PUBLIC_TWO];
    assert.match(
      await exchange(
        relay.socketPath,
        "CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\n\r\n",
      ),
      /^HTTP\/1\.1 502 Bad Gateway/u,
    );
    assert.equal(dialCount, 1);
  } finally {
    await relay.close();
    await closeServer(upstream.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pinned relay refuses a non-private runtime directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hitch-v2-egress-unsafe-"));
  chmodSync(directory, 0o750);
  const policy = await PinnedSidecarEgressPolicy.pin(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    async () => [PUBLIC_ONE],
  );
  try {
    await assert.rejects(
      listenPinnedConnectRelay({ directory, policy }),
      /owner-private/u,
    );
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configured host proxy receives only an approved numeric CONNECT target", async () => {
  let request = "";
  const proxyServer = createServer((socket) => {
    socket.once("data", (chunk) => {
      request = chunk.toString("ascii");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", "ascii");
      socket.on("data", (tunnelBytes) => socket.write(tunnelBytes));
    });
  });
  const port = await listenTcp(proxyServer);
  const dialer = await PinnedHttpProxyTunnelDialer.pin({
    proxyUrl: new URL(`http://127.0.0.1:${port}`),
  });
  const target: AuthorizedEgressTarget = {
    origin: decodeTrustedUpstreamOrigin("https://chatgpt.com"),
    hostname: "chatgpt.com",
    authority: "chatgpt.com:443",
    hostHeader: "chatgpt.com",
    port: 443,
    addresses: [PUBLIC_ONE],
  };
  const tunnel = await dialer.dial(target, new AbortController().signal);
  try {
    assert.match(request, /^CONNECT 8\.8\.8\.8:443 HTTP\/1\.1\r\n/u);
    assert.doesNotMatch(request, /chatgpt\.com/u);
    tunnel.write("proxy-tunnel");
    assert.equal(await readOnce(tunnel), "proxy-tunnel");
  } finally {
    tunnel.destroy();
    await closeServer(proxyServer);
  }
});

test("configured proxy pinning handles bracketed IPv6 and rejects special-use literals", async () => {
  const ipv6 = await PinnedHttpProxyTunnelDialer.pin({
    proxyUrl: new URL("http://[::1]:3128"),
  });
  assert.ok(ipv6 instanceof PinnedHttpProxyTunnelDialer);
  for (const literal of ["0.0.0.0", "169.254.1.1", "192.0.2.1", "[ff02::1]"]) {
    await assert.rejects(
      PinnedHttpProxyTunnelDialer.pin({
        proxyUrl: new URL(`http://${literal}:3128`),
      }),
      (error: unknown) =>
        error instanceof Error && /disallowed-operator-proxy-address/u.test(error.message),
    );
  }
});

test("relay shutdown aborts pending DNS and destroys a socket returned after abort", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hitch-v2-egress-shutdown-"));
  chmodSync(directory, 0o700);
  let lookups = 0;
  const policy = await PinnedSidecarEgressPolicy.pin(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    async () => {
      lookups += 1;
      if (lookups === 1) return [PUBLIC_ONE];
      return new Promise<readonly ResolvedNetworkAddress[]>(() => undefined);
    },
  );
  let dialCalls = 0;
  const relay = await listenPinnedConnectRelay({
    directory,
    policy,
    dialer: {
      async dial() {
        dialCalls += 1;
        return new Promise<Socket>(() => undefined);
      },
    },
  });
  const client = createConnection(relay.socketPath);
  try {
    await onceConnected(client);
    client.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\n\r\n");
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    const firstClose = relay.close();
    const secondClose = relay.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.equal(dialCalls, 0);
  } finally {
    client.destroy();
    await relay.close();
    rmSync(directory, { recursive: true, force: true });
  }

  const secondDirectory = mkdtempSync(join(tmpdir(), "hitch-v2-egress-late-dial-"));
  chmodSync(secondDirectory, 0o700);
  const secondPolicy = await PinnedSidecarEgressPolicy.pin(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    async () => [PUBLIC_ONE],
  );
  let resolveDial: ((socket: Socket) => void) | undefined;
  const secondRelay = await listenPinnedConnectRelay({
    directory: secondDirectory,
    policy: secondPolicy,
    dialer: {
      async dial() {
        return new Promise<Socket>((resolvePromise) => {
          resolveDial = resolvePromise;
        });
      },
    },
  });
  const secondClient = createConnection(secondRelay.socketPath);
  try {
    await onceConnected(secondClient);
    secondClient.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\n\r\n");
    assert.equal(
      await readOnce(secondClient),
      "HTTP/1.1 200 Connection Established\r\n\r\n",
    );
    secondClient.write(tlsClientHello("chatgpt.com"));
    while (resolveDial === undefined) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
    }
    await secondRelay.close();
    const lateSocket = new Socket();
    resolveDial(lateSocket);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(lateSocket.destroyed, true);
  } finally {
    secondClient.destroy();
    await secondRelay.close();
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});

test("relay concurrency bound counts logical clients while TLS authorization is pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hitch-v2-egress-capacity-"));
  chmodSync(directory, 0o700);
  const policy = await PinnedSidecarEgressPolicy.pin(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    async () => [PUBLIC_ONE],
  );
  const relay = await listenPinnedConnectRelay({
    directory,
    policy,
    dialer: {
      async dial() {
        throw new Error("TLS-pending capacity test unexpectedly dialed");
      },
    },
  });
  const clients: Socket[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const client = createConnection(relay.socketPath);
      clients.push(client);
      await onceConnected(client);
      client.write("CONNECT chatgpt.com:443 HTTP/1.1\r\nhost: chatgpt.com\r\n\r\n");
      assert.equal(
        await readOnce(client),
        "HTTP/1.1 200 Connection Established\r\n\r\n",
      );
    }
    const ninth = createConnection(relay.socketPath);
    clients.push(ninth);
    await onceConnected(ninth);
    await onceClosed(ninth);
  } finally {
    for (const client of clients) client.destroy();
    await relay.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function listenTcpEcho(): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer((socket) => socket.pipe(socket));
  return { server, port: await listenTcp(server) };
}

function listenTcp(server: Server): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test TCP server had no address"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function connectTcp(port: number): Promise<Socket> {
  return new Promise<Socket>((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolvePromise(socket));
    socket.once("error", reject);
  });
}

function onceConnected(socket: Socket): Promise<void> {
  if (socket.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolvePromise, reject) => {
    socket.once("connect", resolvePromise);
    socket.once("error", reject);
  });
}

function readOnce(socket: Socket): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    socket.once("data", (chunk) => resolvePromise(chunk.toString("utf8")));
    socket.once("error", reject);
    socket.resume();
  });
}

function readBufferOnce(socket: Socket): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    socket.once("data", (chunk) => resolvePromise(chunk));
    socket.once("error", reject);
    socket.resume();
  });
}

function onceClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise<void>((resolvePromise) => socket.once("close", resolvePromise));
}

function tlsClientHello(hostname: string): Buffer {
  const name = Buffer.from(hostname, "ascii");
  const serverName = Buffer.alloc(3 + name.length);
  serverName[0] = 0;
  serverName.writeUInt16BE(name.length, 1);
  name.copy(serverName, 3);
  const serverNameList = Buffer.alloc(2 + serverName.length);
  serverNameList.writeUInt16BE(serverName.length, 0);
  serverName.copy(serverNameList, 2);
  const extension = Buffer.alloc(4 + serverNameList.length);
  extension.writeUInt16BE(0, 0);
  extension.writeUInt16BE(serverNameList.length, 2);
  serverNameList.copy(extension, 4);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 0x5a),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x02, 0x13, 0x01]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([(extension.length >> 8) & 0xff, extension.length & 0xff]),
    extension,
  ]);
  const handshake = Buffer.alloc(4 + body.length);
  handshake[0] = 0x01;
  handshake.writeUIntBE(body.length, 1, 3);
  body.copy(handshake, 4);
  const record = Buffer.alloc(5 + handshake.length);
  record[0] = 0x16;
  record[1] = 0x03;
  record[2] = 0x01;
  record.writeUInt16BE(handshake.length, 3);
  handshake.copy(record, 5);
  return record;
}

function splitTlsHandshakeAcrossRecords(record: Buffer, splitAt: number): Buffer {
  const handshake = record.subarray(5);
  const first = handshake.subarray(0, splitAt);
  const second = handshake.subarray(splitAt);
  const wrap = (payload: Buffer): Buffer => {
    const output = Buffer.alloc(5 + payload.length);
    output[0] = 0x16;
    output[1] = 0x03;
    output[2] = 0x01;
    output.writeUInt16BE(payload.length, 3);
    payload.copy(output, 5);
    return output;
  };
  return Buffer.concat([wrap(first), wrap(second)]);
}

async function exchange(socketPath: string, request: string): Promise<string> {
  const socket = createConnection(socketPath);
  await onceConnected(socket);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.end(request);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("close", resolvePromise);
    socket.once("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

import {
  chmodSync,
  existsSync,
  lstatSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { connect as connectTls, rootCertificates } from "node:tls";

import {
  isAllowedOperatorProxyAddress,
  normalizeNetworkAddress,
  PinnedSidecarEgressPolicy,
  resolveAddresses,
  SidecarEgressPolicyError,
  unbracketUrlHostname,
  type AuthorizedEgressTarget,
  type ResolvedNetworkAddress,
  type SidecarDnsLookup,
} from "./address-policy.js";
import {
  projectSidecarProxyEnvironment,
  SIDECAR_EGRESS_PROXY_PORT,
  type SidecarProxyEnvironment,
} from "./proxy-environment.js";

const RELAY_SOCKET_NAME = "relay.sock";
const SANDBOX_RELAY_DIRECTORY = "/hitch-egress";
export const SIDECAR_EGRESS_RELAY_SOCKET = `${SANDBOX_RELAY_DIRECTORY}/${RELAY_SOCKET_NAME}`;
const MAX_CONNECT_HEADER_BYTES = 8_192;
const MAX_CONNECT_HEADERS = 8;
const MAX_TLS_CLIENT_HELLO_BYTES = 65_536;
const MAX_TLS_RECORD_BYTES = 18_432;
const MAX_CONCURRENT_CONNECTIONS = 8;
const HEADER_TIMEOUT_MS = 5_000;
const TLS_HELLO_TIMEOUT_MS = 5_000;
const DIAL_TIMEOUT_MS = 10_000;

const runningRelayBrand: unique symbol = Symbol("running-sidecar-egress-relay");
const readyLaunchBrand: unique symbol = Symbol("ready-sidecar-egress-launch");
const consumedLaunchBrand: unique symbol = Symbol("consumed-sidecar-egress-launch");

export interface EgressTunnelDialer {
  dial(target: AuthorizedEgressTarget, signal: AbortSignal): Promise<Socket>;
}

export interface RelayFilesystemIdentity {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

export interface ReadySidecarEgressLaunchAuthorization {
  readonly [readyLaunchBrand]: true;
}

export interface ConsumedSidecarEgressLaunchSpec {
  readonly [consumedLaunchBrand]: true;
  readonly network: "new-empty-network-namespace";
  readonly bubblewrapArguments: readonly [
    "--unshare-net",
    "--ro-bind",
    string,
    typeof SANDBOX_RELAY_DIRECTORY,
  ];
  readonly relaySocketPath: typeof SIDECAR_EGRESS_RELAY_SOCKET;
  readonly loopbackProxyPort: typeof SIDECAR_EGRESS_PROXY_PORT;
  readonly environment: SidecarProxyEnvironment;
  readonly expectedRelayIdentity: {
    readonly directory: RelayFilesystemIdentity;
    readonly socket: RelayFilesystemIdentity;
  };
}

export interface RunningPinnedConnectRelay {
  readonly [runningRelayBrand]: true;
  readonly socketPath: string;
  readonly policy: ReturnType<PinnedSidecarEgressPolicy["snapshot"]>;
  prepareLaunchAuthorization(): ReadySidecarEgressLaunchAuthorization;
  close(): Promise<void>;
}

export interface ParsedConnectRequest {
  readonly authority: string;
  readonly host: string;
}

interface RelayDirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: 448;
}

interface RelaySocketIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: 384;
}

interface LaunchAuthorizationRecord {
  readonly directory: RelayDirectoryIdentity;
  readonly socket: RelaySocketIdentity;
  readonly isClosed: () => boolean;
  consumed: boolean;
  spawnClaimed: boolean;
}

interface ConnectionState {
  readonly client: Socket;
  readonly abortController: AbortController;
  upstream?: Socket;
}

const readyLaunchRecords = new WeakMap<object, LaunchAuthorizationRecord>();
const consumedLaunchRecords = new WeakMap<object, LaunchAuthorizationRecord>();

export class DirectNumericTunnelDialer implements EgressTunnelDialer {
  async dial(target: AuthorizedEgressTarget, signal: AbortSignal): Promise<Socket> {
    return dialNumericAddresses(target.addresses, target.port, signal);
  }
}

export interface PinnedHttpProxyOptions {
  readonly proxyUrl: URL;
  readonly lookup?: SidecarDnsLookup;
}

/**
 * Optional operator proxy path. The relay pins a deliberately allowed proxy
 * address, but asks it to CONNECT only an approved numeric provider address.
 * TLS to the provider remains end-to-end between the sidecar and provider.
 */
export class PinnedHttpProxyTunnelDialer implements EgressTunnelDialer {
  readonly #scheme: "http:" | "https:";
  readonly #hostname: string;
  readonly #port: number;
  readonly #lookup: SidecarDnsLookup;
  readonly #addresses: readonly ResolvedNetworkAddress[];
  readonly #addressKeys: readonly string[];

  private constructor(input: {
    readonly scheme: "http:" | "https:";
    readonly hostname: string;
    readonly port: number;
    readonly lookup: SidecarDnsLookup;
    readonly addresses: readonly ResolvedNetworkAddress[];
  }) {
    this.#scheme = input.scheme;
    this.#hostname = input.hostname;
    this.#port = input.port;
    this.#lookup = input.lookup;
    this.#addresses = input.addresses;
    this.#addressKeys = input.addresses.map(addressKey);
    Object.freeze(this);
  }

  static async pin(options: PinnedHttpProxyOptions): Promise<PinnedHttpProxyTunnelDialer> {
    const url = new URL(options.proxyUrl.href);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === ""
    ) {
      throw new Error("invalid pinned HTTPS proxy URL");
    }
    const lookup = options.lookup ?? systemCompatibleLookup;
    const hostname = unbracketUrlHostname(url.hostname);
    const literalFamily = isIP(hostname);
    let addresses: readonly ResolvedNetworkAddress[];
    if (literalFamily === 4 || literalFamily === 6) {
      const address = normalizeNetworkAddress(hostname, literalFamily);
      if (!isAllowedOperatorProxyAddress(address)) {
        throw new SidecarEgressPolicyError("disallowed-operator-proxy-address");
      }
      addresses = Object.freeze([address]);
    } else {
      addresses = await resolveAddresses(hostname, lookup, "operator-proxy");
    }
    return new PinnedHttpProxyTunnelDialer({
      scheme: url.protocol,
      hostname,
      port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : decodePort(url.port),
      lookup,
      addresses,
    });
  }

  async dial(target: AuthorizedEgressTarget, signal: AbortSignal): Promise<Socket> {
    await this.#revalidate(signal);
    let lastFailure: unknown;
    for (const providerAddress of target.addresses) {
      throwIfAborted(signal);
      try {
        const proxySocket = await this.#connectProxy(signal);
        return await establishProxyTunnel(
          proxySocket,
          providerAddress,
          target.port,
          signal,
        );
      } catch (error) {
        lastFailure = error;
      }
    }
    throw lastFailure ?? new Error("pinned proxy could not connect a provider address");
  }

  async #revalidate(signal: AbortSignal): Promise<void> {
    if (isIP(this.#hostname) !== 0) return;
    const current = await resolveAddresses(
      this.#hostname,
      this.#lookup,
      "operator-proxy",
      signal,
    );
    const keys = current.map(addressKey);
    if (!sameStrings(this.#addressKeys, keys)) {
      throw new SidecarEgressPolicyError("dns-address-set-changed");
    }
  }

  async #connectProxy(signal: AbortSignal): Promise<Socket> {
    let lastFailure: unknown;
    for (const address of this.#addresses) {
      throwIfAborted(signal);
      try {
        if (this.#scheme === "https:") {
          return await connectTlsAddress(
            address,
            this.#port,
            isIP(this.#hostname) === 0 ? this.#hostname : undefined,
            signal,
          );
        }
        return await connectNumericAddress(address, this.#port, signal);
      } catch (error) {
        lastFailure = error;
      }
    }
    throw lastFailure ?? new Error("pinned proxy was unreachable");
  }
}

export async function listenPinnedConnectRelay(input: {
  readonly directory: string;
  readonly policy: PinnedSidecarEgressPolicy;
  readonly dialer?: EgressTunnelDialer;
}): Promise<RunningPinnedConnectRelay> {
  const directoryIdentity = requirePrivateRelayDirectory(input.directory);
  const socketPath = join(directoryIdentity.path, RELAY_SOCKET_NAME);
  if (existsSync(socketPath)) {
    throw new Error("sidecar egress relay socket path is already occupied");
  }
  const dialer = input.dialer ?? new DirectNumericTunnelDialer();
  const connections = new Set<ConnectionState>();
  const handlers = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let launchAuthorizationIssued = false;

  const server = createServer((client) => {
    if (closing || connections.size >= MAX_CONCURRENT_CONNECTIONS) {
      client.destroy();
      return;
    }
    const state: ConnectionState = {
      client,
      abortController: new AbortController(),
    };
    connections.add(state);
    client.on("error", () => undefined);
    client.once("close", () => {
      state.abortController.abort();
      state.upstream?.destroy();
    });
    const handler = handleClient(state, input.policy, dialer).finally(() => {
      state.abortController.abort();
      state.client.destroy();
      state.upstream?.destroy();
      connections.delete(state);
    });
    handlers.add(handler);
    void handler.then(
      () => handlers.delete(handler),
      () => handlers.delete(handler),
    );
  });

  await listenUnix(server, socketPath);
  let socketIdentity: RelaySocketIdentity;
  try {
    chmodSync(socketPath, 0o600);
    socketIdentity = requireRelaySocketIdentity(socketPath, directoryIdentity.uid);
  } catch (error) {
    await closeServer(server);
    try {
      const current = lstatSync(socketPath);
      unlinkIfIdentityMatches(socketPath, current.dev, current.ino);
    } catch {
      // Preserve the original identity-validation failure.
    }
    throw error;
  }
  const running: RunningPinnedConnectRelay = {
    [runningRelayBrand]: true,
    socketPath,
    policy: input.policy.snapshot(),
    prepareLaunchAuthorization(): ReadySidecarEgressLaunchAuthorization {
      if (closing) throw new Error("sidecar egress relay is closed");
      if (launchAuthorizationIssued) {
        throw new Error("sidecar egress relay launch authorization was already issued");
      }
      requireUnchangedRelayIdentity(directoryIdentity, socketIdentity);
      launchAuthorizationIssued = true;
      const authorization = Object.freeze({ [readyLaunchBrand]: true as const });
      readyLaunchRecords.set(authorization, {
        directory: directoryIdentity,
        socket: socketIdentity,
        isClosed: () => closing,
        consumed: false,
        spawnClaimed: false,
      });
      return authorization;
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        for (const state of connections) {
          state.abortController.abort();
          state.client.destroy();
          state.upstream?.destroy();
        }
        await closeServer(server);
        await Promise.allSettled([...handlers]);
        unlinkIfIdentityMatches(socketPath, socketIdentity.dev, socketIdentity.ino);
      })();
      return closePromise;
    },
  };
  return Object.freeze(running);
}

/** Consumes a genuine relay-issued capability exactly once. */
export function consumeSidecarEgressLaunchAuthorization(
  authorization: ReadySidecarEgressLaunchAuthorization,
): ConsumedSidecarEgressLaunchSpec {
  const record = readyLaunchRecords.get(authorization);
  if (record === undefined) {
    throw new Error("forged sidecar egress launch authorization");
  }
  if (record.consumed) {
    throw new Error("sidecar egress launch authorization was already consumed");
  }
  if (record.isClosed()) throw new Error("sidecar egress relay is closed");
  requireUnchangedRelayIdentity(record.directory, record.socket);
  record.consumed = true;
  const specification: ConsumedSidecarEgressLaunchSpec = deepFreeze({
    [consumedLaunchBrand]: true as const,
    network: "new-empty-network-namespace" as const,
    bubblewrapArguments: [
      "--unshare-net",
      "--ro-bind",
      record.directory.path,
      SANDBOX_RELAY_DIRECTORY,
    ] as const,
    relaySocketPath: SIDECAR_EGRESS_RELAY_SOCKET,
    loopbackProxyPort: SIDECAR_EGRESS_PROXY_PORT,
    environment: projectSidecarProxyEnvironment(),
    expectedRelayIdentity: {
      directory: {
        hostPath: record.directory.path,
        sandboxPath: SANDBOX_RELAY_DIRECTORY,
        dev: record.directory.dev,
        ino: record.directory.ino,
        uid: record.directory.uid,
        mode: record.directory.mode,
      },
      socket: {
        hostPath: record.socket.path,
        sandboxPath: SIDECAR_EGRESS_RELAY_SOCKET,
        dev: record.socket.dev,
        ino: record.socket.ino,
        uid: record.socket.uid,
        mode: record.socket.mode,
      },
    },
  });
  consumedLaunchRecords.set(specification, record);
  return specification;
}

/** Atomically claims the specification for V2-010B's one immediate spawn. */
export function claimSidecarEgressLaunchForSpawn(
  specification: ConsumedSidecarEgressLaunchSpec,
): void {
  const record = consumedLaunchRecords.get(specification);
  if (record === undefined) throw new Error("forged sidecar egress launch specification");
  if (record.spawnClaimed) {
    throw new Error("sidecar egress launch specification was already claimed");
  }
  if (record.isClosed()) throw new Error("sidecar egress relay is closed");
  requireUnchangedRelayIdentity(record.directory, record.socket);
  record.spawnClaimed = true;
}

export function parseConnectRequest(
  header: Buffer,
  expectedHostHeader: (authority: string) => string | undefined,
): ParsedConnectRequest {
  if (
    header.length === 0 ||
    header.length > MAX_CONNECT_HEADER_BYTES ||
    !header.subarray(-4).equals(Buffer.from("\r\n\r\n", "ascii")) ||
    header.indexOf("\r\n\r\n") !== header.length - 4
  ) {
    throw new Error("invalid CONNECT header boundary");
  }
  for (const byte of header) {
    if (byte === 0x0d || byte === 0x0a) continue;
    if (byte < 0x20 || byte > 0x7e) {
      throw new Error("CONNECT header contains non-ASCII or control bytes");
    }
  }
  const lines = header.subarray(0, -4).toString("ascii").split("\r\n");
  const requestLine = lines.shift();
  const match = /^CONNECT ([a-z0-9.-]+:[0-9]{1,5}) HTTP\/1\.1$/u.exec(
    requestLine ?? "",
  );
  if (match === null) throw new Error("invalid CONNECT request line");
  const authority = match[1];
  if (authority === undefined) throw new Error("missing CONNECT authority");
  const expectedHost = expectedHostHeader(authority);
  if (expectedHost === undefined) {
    throw new SidecarEgressPolicyError("unregistered-authority");
  }
  if (lines.length === 0 || lines.length > MAX_CONNECT_HEADERS) {
    throw new Error("invalid CONNECT header count");
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const headerMatch = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+): ([\x20-\x7e]+)$/u.exec(line);
    if (headerMatch === null) throw new Error("invalid CONNECT header");
    const name = headerMatch[1]?.toLowerCase();
    const value = headerMatch[2];
    if (name === undefined || value === undefined || headers.has(name)) {
      throw new Error("duplicate CONNECT header");
    }
    headers.set(name, value);
  }
  const allowedNames = new Set(["host", "connection", "proxy-connection"]);
  if ([...headers.keys()].some((name) => !allowedNames.has(name))) {
    throw new Error("unsupported CONNECT header");
  }
  if (
    headers.get("host") !== expectedHost ||
    (headers.has("connection") && headers.get("connection")?.toLowerCase() !== "close") ||
    (headers.has("proxy-connection") &&
      headers.get("proxy-connection")?.toLowerCase() !== "keep-alive")
  ) {
    throw new Error("CONNECT header value changed proxy authority or semantics");
  }
  return Object.freeze({ authority, host: expectedHost });
}

/** Returns once a complete ClientHello proves its exact DNS SNI. */
export function inspectTlsClientHello(
  input: Buffer,
  expectedHostname: string,
): "incomplete" | "authorized" {
  let offset = 0;
  const handshakeParts: Buffer[] = [];
  let handshakeBytes = 0;
  while (true) {
    if (input.length - offset < 5) return "incomplete";
    if (input[offset] !== 0x16 || input[offset + 1] !== 0x03) {
      throw new Error("tunnel did not begin with a TLS handshake record");
    }
    const recordLength = input.readUInt16BE(offset + 3);
    if (recordLength < 1 || recordLength > MAX_TLS_RECORD_BYTES) {
      throw new Error("TLS handshake record exceeded its limit");
    }
    if (input.length - offset - 5 < recordLength) return "incomplete";
    const record = input.subarray(offset + 5, offset + 5 + recordLength);
    handshakeParts.push(record);
    handshakeBytes += record.length;
    if (handshakeBytes > MAX_TLS_CLIENT_HELLO_BYTES) {
      throw new Error("TLS ClientHello exceeded its limit");
    }
    const handshake = Buffer.concat(handshakeParts, handshakeBytes);
    if (handshake.length >= 4) {
      if (handshake[0] !== 0x01) throw new Error("first TLS handshake was not ClientHello");
      const helloLength = handshake.readUIntBE(1, 3);
      if (helloLength + 4 > MAX_TLS_CLIENT_HELLO_BYTES) {
        throw new Error("TLS ClientHello exceeded its limit");
      }
      if (handshake.length >= helloLength + 4) {
        const sni = parseClientHelloSni(handshake.subarray(4, helloLength + 4));
        if (sni !== expectedHostname) {
          throw new Error("TLS ClientHello SNI did not match the CONNECT authority");
        }
        return "authorized";
      }
    }
    offset += 5 + recordLength;
  }
}

async function handleClient(
  state: ConnectionState,
  policy: PinnedSidecarEgressPolicy,
  dialer: EgressTunnelDialer,
): Promise<void> {
  const signal = state.abortController.signal;
  let connectAccepted = false;
  try {
    const header = await readConnectHeader(state.client, signal);
    const request = parseConnectRequest(header, (authority) =>
      policy.expectedHostHeader(authority),
    );
    const target = await policy.authorizeConnectWithSignal(request.authority, signal);
    requireOpen(state.client, signal);
    await writeSocket(
      state.client,
      Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n", "ascii"),
      signal,
    );
    connectAccepted = true;
    const clientHello = await readAuthorizedClientHello(
      state.client,
      target.hostname,
      signal,
    );
    requireOpen(state.client, signal);
    const upstream = await awaitDialWithAbort(dialer.dial(target, signal), signal);
    state.upstream = upstream;
    upstream.on("error", () => state.client.destroy());
    upstream.once("close", () => {
      state.abortController.abort();
      state.client.destroy();
    });
    requireOpen(state.client, signal);
    await writeSocket(upstream, clientHello, signal);
    state.client.pipe(upstream).pipe(state.client);
    state.client.resume();
    await waitForAbort(signal);
  } catch (error) {
    if (!connectAccepted && !state.client.destroyed && !signal.aborted) {
      const status =
        error instanceof SidecarEgressPolicyError &&
        error.reason === "unregistered-authority"
          ? "403 Forbidden"
          : error instanceof SidecarEgressPolicyError
            ? "502 Bad Gateway"
            : "400 Bad Request";
      try {
        await writeSocket(
          state.client,
          Buffer.from(
            `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
            "ascii",
          ),
          signal,
        );
        state.client.end();
      } catch {
        state.client.destroy();
      }
    }
  }
}

function readConnectHeader(client: Socket, signal: AbortSignal): Promise<Buffer> {
  return readBoundedSocketInput({
    client,
    signal,
    timeoutMilliseconds: HEADER_TIMEOUT_MS,
    maximumBytes: MAX_CONNECT_HEADER_BYTES,
    inspect(buffer) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return "incomplete";
      if (boundary + 4 !== buffer.length) {
        throw new Error("CONNECT client sent tunnel bytes before authorization");
      }
      return "complete";
    },
    timeoutMessage: "CONNECT header deadline elapsed",
  });
}

function readAuthorizedClientHello(
  client: Socket,
  hostname: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return readBoundedSocketInput({
    client,
    signal,
    timeoutMilliseconds: TLS_HELLO_TIMEOUT_MS,
    maximumBytes: MAX_TLS_CLIENT_HELLO_BYTES,
    inspect(buffer) {
      return inspectTlsClientHello(buffer, hostname) === "authorized"
        ? "complete"
        : "incomplete";
    },
    timeoutMessage: "TLS ClientHello deadline elapsed",
  });
}

function readBoundedSocketInput(input: {
  readonly client: Socket;
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: number;
  readonly maximumBytes: number;
  readonly inspect: (buffer: Buffer) => "incomplete" | "complete";
  readonly timeoutMessage: string;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      clearTimeout(timer);
      input.client.off("data", onData);
      input.client.off("end", onEnd);
      input.client.off("error", onError);
      input.signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > input.maximumBytes) {
        fail(new Error("authorized socket input exceeded its byte limit"));
        return;
      }
      try {
        if (input.inspect(buffered) === "complete") {
          input.client.pause();
          cleanup();
          resolvePromise(buffered);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("invalid socket input"));
      }
    };
    const onEnd = (): void => fail(new Error("client ended before authorization completed"));
    const onError = (): void => fail(new Error("client failed before authorization completed"));
    const onAbort = (): void => fail(new Error("authorization was aborted"));
    const timer = setTimeout(() => fail(new Error(input.timeoutMessage)), input.timeoutMilliseconds);
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    input.client.on("data", onData);
    input.client.once("end", onEnd);
    input.client.once("error", onError);
    input.signal.addEventListener("abort", onAbort, { once: true });
    input.client.resume();
  });
}

function parseClientHelloSni(hello: Buffer): string {
  let offset = 0;
  const need = (bytes: number): void => {
    if (bytes < 0 || offset + bytes > hello.length) {
      throw new Error("malformed TLS ClientHello");
    }
  };
  need(34);
  offset += 34;
  need(1);
  const sessionLength = hello[offset] ?? 0;
  offset += 1;
  need(sessionLength + 2);
  offset += sessionLength;
  const cipherLength = hello.readUInt16BE(offset);
  offset += 2;
  if (cipherLength < 2 || cipherLength % 2 !== 0) throw new Error("malformed TLS ciphers");
  need(cipherLength + 1);
  offset += cipherLength;
  const compressionLength = hello[offset] ?? 0;
  offset += 1;
  if (compressionLength < 1) throw new Error("malformed TLS compression methods");
  need(compressionLength + 2);
  offset += compressionLength;
  const extensionsLength = hello.readUInt16BE(offset);
  offset += 2;
  need(extensionsLength);
  if (offset + extensionsLength !== hello.length) throw new Error("malformed TLS extensions");
  const extensionsEnd = offset + extensionsLength;
  let sni: string | undefined;
  while (offset < extensionsEnd) {
    need(4);
    const type = hello.readUInt16BE(offset);
    const length = hello.readUInt16BE(offset + 2);
    offset += 4;
    need(length);
    if (type === 0) {
      if (sni !== undefined || length < 5) throw new Error("malformed TLS SNI extension");
      const extensionEnd = offset + length;
      const namesLength = hello.readUInt16BE(offset);
      offset += 2;
      if (offset + namesLength !== extensionEnd) throw new Error("malformed TLS SNI list");
      let hostCount = 0;
      while (offset < extensionEnd) {
        need(3);
        const nameType = hello[offset] ?? 255;
        const nameLength = hello.readUInt16BE(offset + 1);
        offset += 3;
        need(nameLength);
        if (nameType === 0) {
          hostCount += 1;
          const candidateBytes = hello.subarray(offset, offset + nameLength);
          if ([...candidateBytes].some((byte) => byte > 0x7f)) {
            throw new Error("invalid non-ASCII TLS SNI hostname");
          }
          const candidate = candidateBytes.toString("ascii");
          if (
            hostCount !== 1 ||
            nameLength === 0 ||
            !/^[a-z0-9.-]+$/u.test(candidate) ||
            candidate.endsWith(".")
          ) {
            throw new Error("invalid TLS SNI hostname");
          }
          sni = candidate;
        }
        offset += nameLength;
      }
      if (hostCount !== 1) throw new Error("TLS ClientHello omitted a unique DNS SNI");
      offset = extensionEnd;
    } else {
      offset += length;
    }
  }
  if (sni === undefined) throw new Error("TLS ClientHello omitted SNI");
  return sni;
}

async function establishProxyTunnel(
  proxySocket: Socket,
  providerAddress: ResolvedNetworkAddress,
  providerPort: number,
  signal: AbortSignal,
): Promise<Socket> {
  const authority = numericAuthority(providerAddress, providerPort);
  try {
    await writeSocket(
      proxySocket,
      Buffer.from(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\nProxy-Connection: keep-alive\r\n\r\n`,
        "ascii",
      ),
      signal,
    );
    const response = await readProxyResponse(proxySocket, signal);
    if (!/^HTTP\/1\.[01] 200(?: |\r\n)/u.test(response)) {
      throw new Error("configured proxy denied the pinned provider address");
    }
    return proxySocket;
  } catch (error) {
    proxySocket.destroy();
    throw error;
  }
}

async function readProxyResponse(socket: Socket, signal: AbortSignal): Promise<string> {
  const response = await readBoundedSocketInput({
    client: socket,
    signal,
    timeoutMilliseconds: DIAL_TIMEOUT_MS,
    maximumBytes: MAX_CONNECT_HEADER_BYTES,
    inspect(buffer) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return "incomplete";
      if (boundary + 4 !== buffer.length) {
        throw new Error("configured proxy sent bytes before the provider TLS handshake");
      }
      return "complete";
    },
    timeoutMessage: "configured proxy CONNECT deadline elapsed",
  });
  const text = response.toString("ascii");
  if (/[^\x0d\x0a\x20-\x7e]/u.test(text)) {
    throw new Error("configured proxy response contained unsafe bytes");
  }
  return text;
}

async function dialNumericAddresses(
  addresses: readonly ResolvedNetworkAddress[],
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  let lastFailure: unknown;
  for (const address of addresses) {
    throwIfAborted(signal);
    try {
      return await connectNumericAddress(address, port, signal);
    } catch (error) {
      lastFailure = error;
    }
  }
  throw lastFailure ?? new Error("provider address set was empty");
}

function connectNumericAddress(
  address: ResolvedNetworkAddress,
  port: number,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise<Socket>((resolvePromise, reject) => {
    const socket = createConnection({ host: address.address, family: address.family, port });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.off("connect", onConnect);
      socket.off("error", onFailure);
    };
    const fail = (message: string): void => {
      cleanup();
      socket.destroy();
      reject(new Error(message));
    };
    const onAbort = (): void => fail("numeric egress connection aborted");
    const onFailure = (): void => fail("numeric egress connection failed");
    const onConnect = (): void => {
      cleanup();
      socket.setNoDelay(true);
      resolvePromise(socket);
    };
    const timer = setTimeout(onFailure, DIAL_TIMEOUT_MS);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", onConnect);
    socket.once("error", onFailure);
  });
}

function connectTlsAddress(
  address: ResolvedNetworkAddress,
  port: number,
  servername: string | undefined,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise<Socket>((resolvePromise, reject) => {
    const socket = connectTls({
      host: address.address,
      port,
      rejectUnauthorized: true,
      ca: [...rootCertificates],
      ...(servername === undefined ? {} : { servername }),
    });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.off("secureConnect", onConnect);
      socket.off("error", onFailure);
    };
    const fail = (message: string): void => {
      cleanup();
      socket.destroy();
      reject(new Error(message));
    };
    const onAbort = (): void => fail("TLS proxy connection aborted");
    const onFailure = (): void => fail("TLS proxy connection failed");
    const onConnect = (): void => {
      cleanup();
      socket.setNoDelay(true);
      resolvePromise(socket);
    };
    const timer = setTimeout(onFailure, DIAL_TIMEOUT_MS);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", onConnect);
    socket.once("error", onFailure);
  });
}

function awaitDialWithAbort(operation: Promise<Socket>, signal: AbortSignal): Promise<Socket> {
  return new Promise<Socket>((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error("egress dial aborted")));
    const timer = setTimeout(
      () => finish(() => reject(new Error("egress dial deadline elapsed"))),
      DIAL_TIMEOUT_MS,
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (socket) => {
        if (settled || signal.aborted) {
          socket.destroy();
          return;
        }
        finish(() => resolvePromise(socket));
      },
      (error) => finish(() => reject(error)),
    );
  });
}

function writeSocket(socket: Socket, bytes: Buffer, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(new Error("socket write aborted"));
    };
    if (signal.aborted || socket.destroyed) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.write(bytes, (error) => {
      cleanup();
      if (error === null || error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

function requirePrivateRelayDirectory(directory: string): RelayDirectoryIdentity {
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory) {
    throw new Error("sidecar egress relay directory must be canonical and absolute");
  }
  const identity = lstatSync(directory);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== uid ||
    (identity.mode & 0o777) !== 0o700
  ) {
    throw new Error("sidecar egress relay directory must be owner-private");
  }
  return Object.freeze({
    path: directory,
    dev: identity.dev,
    ino: identity.ino,
    uid,
    mode: 0o700 as const,
  });
}

function requireRelaySocketIdentity(
  socketPath: string,
  expectedUid: number,
): RelaySocketIdentity {
  const identity = lstatSync(socketPath);
  if (
    !identity.isSocket() ||
    identity.isSymbolicLink() ||
    identity.uid !== expectedUid ||
    (identity.mode & 0o777) !== 0o600
  ) {
    throw new Error("sidecar egress relay socket identity is unsafe");
  }
  return Object.freeze({
    path: socketPath,
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mode: 0o600 as const,
  });
}

function requireUnchangedRelayIdentity(
  expectedDirectory: RelayDirectoryIdentity,
  expectedSocket: RelaySocketIdentity,
): void {
  const directory = requirePrivateRelayDirectory(expectedDirectory.path);
  if (
    directory.dev !== expectedDirectory.dev ||
    directory.ino !== expectedDirectory.ino ||
    directory.uid !== expectedDirectory.uid
  ) {
    throw new Error("sidecar egress relay directory identity changed before launch");
  }
  const socket = requireRelaySocketIdentity(expectedSocket.path, expectedSocket.uid);
  if (socket.dev !== expectedSocket.dev || socket.ino !== expectedSocket.ino) {
    throw new Error("sidecar egress relay socket identity changed before launch");
  }
}

function listenUnix(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

function unlinkIfIdentityMatches(socketPath: string, dev: number, ino: number): void {
  try {
    const current = lstatSync(socketPath);
    if (current.isSocket() && current.dev === dev && current.ino === ino) {
      unlinkSync(socketPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function numericAuthority(address: ResolvedNetworkAddress, port: number): string {
  return address.family === 6 ? `[${address.address}]:${port}` : `${address.address}:${port}`;
}

function decodePort(value: string): number {
  const port = Number(value);
  if (!/^[0-9]{1,5}$/u.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid proxy port");
  }
  return port;
}

function addressKey(address: ResolvedNetworkAddress): string {
  return `${address.family}:${address.address}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("egress operation aborted");
}

function requireOpen(socket: Socket, signal: AbortSignal): void {
  throwIfAborted(signal);
  if (socket.destroyed || !socket.writable) throw new Error("egress peer closed");
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolvePromise) =>
    signal.addEventListener("abort", () => resolvePromise(), { once: true }),
  );
}

async function systemCompatibleLookup(hostname: string): Promise<readonly ResolvedNetworkAddress[]> {
  const { lookup } = await import("node:dns/promises");
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

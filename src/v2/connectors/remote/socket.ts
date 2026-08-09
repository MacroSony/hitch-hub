import { constants as cryptoConstants, X509Certificate } from "node:crypto";
import { isIP, type Socket } from "node:net";
import {
  createServer,
  type Server as TlsServer,
  type TLSSocket,
} from "node:tls";

import type {
  AuthenticatedConnectorContext,
  RemoteConnectorAuthenticationPort,
} from "../../model/application.js";
import type { ClientCertificateVerificationPort } from "./certificate-verification.js";
import { MVP_REMOTE_TLS_VERSION } from "./certificate-verification.js";
import {
  decodeRemoteProtocolClientJsonlFrame,
  encodeRemoteProtocolServerJsonlFrame,
  RemoteProtocolCorrelationGuard,
} from "./framing.js";
import {
  LOCAL_PROTOCOL_LIMITS,
} from "../local/protocol.js";
import {
  decodeRemoteProtocolServerFrame,
  type RemoteProtocolClientFrame,
  type RemoteProtocolCommandOutcome,
  type RemoteProtocolServerFrame,
} from "./protocol.js";

export const REMOTE_TLS_LIMITS = Object.freeze({
  maximumConcurrentConnections: 64,
  maximumTlsMaterialBytes: 128 * 1024,
  handshakeTimeoutMs: 10_000,
  requestReadTimeoutMs: 10_000,
  maximumRequestLifetimeMs: 30_000,
  shutdownGraceMs: 1_000,
});

export interface AuthenticatedRemoteProtocolExchange {
  readonly context: AuthenticatedConnectorContext;
  readonly request: RemoteProtocolClientFrame;
  readonly signal: AbortSignal;
  respond(outcome: RemoteProtocolCommandOutcome): Promise<void>;
}

export interface ListenRemoteProtocolTlsOptions {
  /** An exact IPv4/IPv6 literal selected by trusted composition. */
  readonly host: string;
  /** Port zero is accepted only so deterministic tests can allocate a port. */
  readonly port: number;
  readonly serverCertificatePem: Uint8Array;
  readonly serverPrivateKeyPem: Uint8Array;
  /** Exactly one CA certificate; ambient operating-system roots are not used. */
  readonly clientCertificateAuthorityPem: Uint8Array;
  readonly certificateVerifier: ClientCertificateVerificationPort;
  readonly authentication: RemoteConnectorAuthenticationPort;
  readonly handle: (
    exchange: AuthenticatedRemoteProtocolExchange,
  ) => Promise<void>;
  readonly onConnectionError?: (error: unknown) => void;
  /** Trusted composition may narrow, never widen, the absolute deadline. */
  readonly requestDeadlineMs?: number;
}

export interface RemoteProtocolTlsServer {
  readonly host: string;
  readonly port: number;
  readonly isClosing: boolean;
  readonly isClosed: boolean;
  close(): Promise<void>;
}

export class RemoteTlsConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteTlsConfigurationError";
  }
}

export class RemoteTlsProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteTlsProtocolError";
  }
}

interface ActiveConnection {
  readonly socket: TLSSocket;
  readonly abort: AbortController;
  clearDeadline(): void;
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

function requireBoundedBytes(
  input: Uint8Array,
  subject: string,
): Buffer {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 1 ||
    input.byteLength > REMOTE_TLS_LIMITS.maximumTlsMaterialBytes
  ) {
    throw new RemoteTlsConfigurationError(
      `${subject} violates the TLS material byte limit`,
    );
  }
  return Buffer.from(input);
}

function requireSingleCertificatePem(
  input: Uint8Array,
  subject: string,
): { readonly pem: Buffer; readonly certificate: X509Certificate } {
  const pem = requireBoundedBytes(input, subject);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(pem).trim();
  } catch (error) {
    throw new RemoteTlsConfigurationError(
      `${subject} must be valid UTF-8 PEM`,
      { cause: error },
    );
  }
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  if (
    !text.startsWith(begin) ||
    !text.endsWith(end) ||
    text.indexOf(begin) !== text.lastIndexOf(begin) ||
    text.indexOf(end) !== text.lastIndexOf(end)
  ) {
    throw new RemoteTlsConfigurationError(
      `${subject} must contain exactly one PEM certificate`,
    );
  }
  try {
    return Object.freeze({
      pem: Buffer.from(`${text}\n`, "utf8"),
      certificate: new X509Certificate(text),
    });
  } catch (error) {
    throw new RemoteTlsConfigurationError(
      `${subject} is not a valid X.509 certificate`,
      { cause: error },
    );
  }
}

function validateConfiguration(options: ListenRemoteProtocolTlsOptions): {
  readonly serverCertificatePem: Buffer;
  readonly serverPrivateKeyPem: Buffer;
  readonly clientCertificateAuthorityPem: Buffer;
  readonly requestDeadlineMs: number;
} {
  if (isIP(options.host) === 0) {
    throw new RemoteTlsConfigurationError(
      "remote TLS ingress host must be an exact IP literal",
    );
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new RemoteTlsConfigurationError(
      "remote TLS ingress port must be an integer from 0 through 65535",
    );
  }
  const requestDeadlineMs =
    options.requestDeadlineMs ?? REMOTE_TLS_LIMITS.maximumRequestLifetimeMs;
  if (
    !Number.isFinite(requestDeadlineMs) ||
    requestDeadlineMs <= 0 ||
    requestDeadlineMs > REMOTE_TLS_LIMITS.maximumRequestLifetimeMs
  ) {
    throw new RemoteTlsConfigurationError(
      "remote request deadline must be positive and no greater than the fixed maximum",
    );
  }
  const server = requireSingleCertificatePem(
    options.serverCertificatePem,
    "server certificate",
  );
  if (server.certificate.ca) {
    throw new RemoteTlsConfigurationError(
      "remote TLS server certificate cannot be a CA certificate",
    );
  }
  const clientAuthority = requireSingleCertificatePem(
    options.clientCertificateAuthorityPem,
    "client certificate authority",
  );
  if (!clientAuthority.certificate.ca) {
    throw new RemoteTlsConfigurationError(
      "client certificate trust root must be a CA certificate",
    );
  }
  return Object.freeze({
    serverCertificatePem: server.pem,
    serverPrivateKeyPem: requireBoundedBytes(
      options.serverPrivateKeyPem,
      "server private key",
    ),
    clientCertificateAuthorityPem: clientAuthority.pem,
    requestDeadlineMs,
  });
}

function abortError(): RemoteTlsProtocolError {
  return new RemoteTlsProtocolError("remote protocol connection was closed");
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
  socket: TLSSocket,
  signal: AbortSignal,
): Promise<RemoteProtocolClientFrame> {
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
    const decode = (): void => {
      try {
        resolve(
          decodeRemoteProtocolClientJsonlFrame(
            Buffer.concat(chunks, byteLength),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = (): void => fail(abortError());
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      decode();
    };
    const onClose = (): void => fail(abortError());
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      const previousLength = byteLength;
      byteLength += chunk.length;
      if (byteLength > LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
        fail(
          new RemoteTlsProtocolError(
            "remote request frame exceeds its byte limit",
          ),
        );
        return;
      }
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        chunks.push(Buffer.from(chunk));
        if (byteLength >= LOCAL_PROTOCOL_LIMITS.maximumFrameBytes) {
          fail(
            new RemoteTlsProtocolError(
              "remote request frame exceeds its byte limit",
            ),
          );
        }
        return;
      }
      if (previousLength + newline !== byteLength - 1) {
        fail(
          new RemoteTlsProtocolError(
            "remote request carries data after its terminating line break",
          ),
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
      settled = true;
      socket.pause();
      cleanup();
      decode();
    };

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || socket.destroyed) onAbort();
  });
}

async function writeFrame(
  socket: TLSSocket,
  bytes: Uint8Array,
): Promise<void> {
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
  outcome: RemoteProtocolCommandOutcome,
): RemoteProtocolServerFrame {
  return decodeRemoteProtocolServerFrame({
    protocol: "hitch.remote",
    version: 1,
    frame: "response",
    requestId,
    outcome,
  });
}

function createExchange(
  socket: TLSSocket,
  signal: AbortSignal,
  context: AuthenticatedConnectorContext,
  request: RemoteProtocolClientFrame,
): {
  readonly exchange: AuthenticatedRemoteProtocolExchange;
  readonly correlation: RemoteProtocolCorrelationGuard;
  awaitWrites(): Promise<void>;
} {
  const correlation = new RemoteProtocolCorrelationGuard();
  correlation.acceptClient(request);
  let writes: Promise<void> = Promise.resolve();
  const exchange: AuthenticatedRemoteProtocolExchange = Object.freeze({
    context,
    request,
    signal,
    respond(outcome: RemoteProtocolCommandOutcome): Promise<void> {
      writes = writes.then(async () => {
        const frame = serverFrame(request.requestId, outcome);
        correlation.acceptServer(frame);
        await writeFrame(
          socket,
          encodeRemoteProtocolServerJsonlFrame(frame),
        );
      });
      return writes;
    },
  });
  return {
    exchange,
    correlation,
    awaitWrites: () => writes,
  };
}

function reportConnectionError(
  options: ListenRemoteProtocolTlsOptions,
  error: unknown,
): void {
  try {
    options.onConnectionError?.(error);
  } catch {
    // Observation must never keep an untrusted network connection alive.
  }
}

class RunningRemoteProtocolTlsServer implements RemoteProtocolTlsServer {
  readonly host: string;
  readonly port: number;
  readonly #server: TlsServer;
  readonly #sockets: Set<Socket>;
  readonly #connections: Map<TLSSocket, ActiveConnection>;
  readonly #stopAccepting: () => void;
  #closePromise?: Promise<void>;
  #closing = false;
  #closed = false;

  constructor(input: {
    readonly host: string;
    readonly port: number;
    readonly server: TlsServer;
    readonly sockets: Set<Socket>;
    readonly connections: Map<TLSSocket, ActiveConnection>;
    readonly stopAccepting: () => void;
  }) {
    this.host = input.host;
    this.port = input.port;
    this.#server = input.server;
    this.#sockets = input.sockets;
    this.#connections = input.connections;
    this.#stopAccepting = input.stopAccepting;
  }

  get isClosing(): boolean {
    return this.#closing;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#stopAccepting();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    for (const connection of this.#connections.values()) {
      connection.abort.abort();
      connection.socket.end();
    }
    const force = setTimeout(() => {
      for (const socket of this.#sockets) {
        socket.destroy();
      }
    }, REMOTE_TLS_LIMITS.shutdownGraceMs);
    force.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        if (!this.#server.listening) {
          resolve();
          return;
        }
        this.#server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    } finally {
      clearTimeout(force);
      this.#closed = true;
    }
  }
}

export async function listenRemoteProtocolTls(
  options: ListenRemoteProtocolTlsOptions,
): Promise<RemoteProtocolTlsServer> {
  const configuration = validateConfiguration(options);
  const sockets = new Set<Socket>();
  const connections = new Map<TLSSocket, ActiveConnection>();
  let accepting = true;

  const server = createServer(
    {
      key: configuration.serverPrivateKeyPem,
      cert: configuration.serverCertificatePem,
      ca: configuration.clientCertificateAuthorityPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: MVP_REMOTE_TLS_VERSION,
      maxVersion: MVP_REMOTE_TLS_VERSION,
      handshakeTimeout: REMOTE_TLS_LIMITS.handshakeTimeoutMs,
      honorCipherOrder: true,
      secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
    },
    (socket) => {
      if (!accepting) {
        socket.destroy();
        return;
      }
      const active: ActiveConnection = {
        socket,
        abort: new AbortController(),
        clearDeadline: () => undefined,
      };
      connections.set(socket, active);
      socket.once("close", () => {
        active.clearDeadline();
        active.abort.abort();
        connections.delete(socket);
      });
      const deadline = setTimeout(() => {
        active.abort.abort();
        socket.destroy();
      }, configuration.requestDeadlineMs);
      deadline.unref();
      active.clearDeadline = () => clearTimeout(deadline);
      socket.setTimeout(REMOTE_TLS_LIMITS.requestReadTimeoutMs, () => {
        active.abort.abort();
        socket.destroy();
      });

      void (async () => {
        try {
          const peer = socket.getPeerCertificate(true);
          const authorizationError = socket.authorizationError;
          const verification = options.certificateVerifier.verify({
            authorized: socket.authorized,
            protocol: socket.getProtocol(),
            completeDer: peer.raw ?? new Uint8Array(),
            ...(authorizationError === null || authorizationError === undefined
              ? {}
              : { authorizationError: String(authorizationError) }),
          });
          if (verification.status !== "verified") {
            socket.destroy();
            return;
          }
          const authentication = await raceAbort(
            options.authentication.authenticate(verification.evidence),
            active.abort.signal,
          );
          if (authentication.status !== "authenticated") {
            socket.destroy();
            return;
          }
          const request = await readOneClientFrame(
            socket,
            active.abort.signal,
          );
          socket.setTimeout(0);
          const rejectTrailingData = (): void => {
            active.abort.abort();
            socket.destroy();
          };
          socket.on("data", rejectTrailingData);
          socket.resume();
          try {
            const prepared = createExchange(
              socket,
              active.abort.signal,
              authentication.context,
              request,
            );
            const handling = Promise.resolve(options.handle(prepared.exchange));
            handling.catch(() => undefined);
            await raceAbort(handling, active.abort.signal);
            await prepared.awaitWrites();
            if (!prepared.correlation.isComplete) {
              throw new RemoteTlsProtocolError(
                "remote handler returned without one complete response",
              );
            }
            socket.end();
          } finally {
            socket.off("data", rejectTrailingData);
          }
        } catch (error) {
          if (!active.abort.signal.aborted) {
            reportConnectionError(options, error);
          }
          socket.destroy();
        }
      })();
    },
  );
  server.maxConnections = REMOTE_TLS_LIMITS.maximumConcurrentConnections;
  server.on("connection", (rawSocket: Socket) => {
    if (
      !accepting ||
      sockets.size >= REMOTE_TLS_LIMITS.maximumConcurrentConnections
    ) {
      rawSocket.destroy();
      return;
    }
    sockets.add(rawSocket);
    rawSocket.on("error", () => undefined);
    rawSocket.once("close", () => {
      sockets.delete(rawSocket);
    });
  });
  server.on("tlsClientError", (error) => {
    if (accepting) reportConnectionError(options, error);
  });

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
      server.listen(options.port, options.host);
    });
  } catch (error) {
    accepting = false;
    for (const socket of sockets) {
      socket.destroy();
    }
    try {
      server.close();
    } catch {
      // Preserve the listener setup failure.
    }
    throw new RemoteTlsConfigurationError(
      "unable to start remote TLS ingress",
      { cause: error },
    );
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    accepting = false;
    server.close();
    throw new RemoteTlsConfigurationError(
      "remote TLS ingress did not bind an IP address",
    );
  }
  const running = new RunningRemoteProtocolTlsServer({
    host: address.address,
    port: address.port,
    server,
    sockets,
    connections,
    stopAccepting: () => {
      accepting = false;
    },
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

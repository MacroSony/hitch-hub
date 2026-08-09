import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import {
  connect,
  type ConnectionOptions,
  type TLSSocket,
} from "node:tls";
import test from "node:test";

import { mvpScenarioCase } from "../../acceptance/runner.js";
import {
  decodeIsoTimestamp,
  fingerprintClientCertificateDer,
} from "../../codecs/primitives.js";
import type {
  AuthenticatedConnectorContext,
  Clock,
  ConnectorAuthenticationResult,
  RemoteConnectorAuthenticationPort,
  VerifiedClientCertificateEvidence,
} from "../../model/application.js";
import {
  createClientCertificateTrust,
  type ClientCertificateTrustBundle,
} from "./certificate-verification.js";
import {
  decodeRemoteProtocolServerJsonlFrame,
  encodeRemoteProtocolClientJsonlFrame,
} from "./framing.js";
import {
  decodeRemoteProtocolClientFrame,
  type RemoteProtocolCommandOutcome,
} from "./protocol.js";
import {
  listenRemoteProtocolTls,
  RemoteTlsConfigurationError,
  type AuthenticatedRemoteProtocolExchange,
  type ListenRemoteProtocolTlsOptions,
  type RemoteProtocolTlsServer,
} from "./socket.js";
import {
  TEST_CA_CERTIFICATE_PEM,
  TEST_CLIENT_CERTIFICATE_PEM,
  TEST_CLIENT_PRIVATE_KEY_PEM,
  TEST_SERVER_CERTIFICATE_PEM,
  TEST_SERVER_PRIVATE_KEY_PEM,
} from "./test-certificates.js";

const CLOCK: Clock = Object.freeze({
  now: () => decodeIsoTimestamp("2026-08-09T12:00:00.000Z"),
});

const CONTEXT = Object.freeze({
  actor: Object.freeze({
    kind: "authenticated-principal",
    principalId: "principal-2",
    identityBindingId: "binding-2",
    method: "mtls-client",
    assurance: "normal",
    requestId: "authentication-2",
    authenticatedAt: "2026-08-09T12:00:00.000Z",
  }),
  endpointId: "endpoint-2",
}) as AuthenticatedConnectorContext;

interface ClientResult {
  readonly bytes: Buffer;
  readonly error?: Error;
  readonly protocol?: string | null;
}

async function requestOverTls(input: {
  readonly server: RemoteProtocolTlsServer;
  readonly bytes: Uint8Array;
  readonly certificate?: boolean;
  readonly minVersion?: ConnectionOptions["minVersion"];
  readonly maxVersion?: ConnectionOptions["maxVersion"];
}): Promise<ClientResult> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let firstError: Error | undefined;
    let protocol: string | null | undefined;
    let settled = false;
    const options: ConnectionOptions = {
      host: input.server.host,
      port: input.server.port,
      ca: TEST_CA_CERTIFICATE_PEM,
      rejectUnauthorized: true,
      minVersion: input.minVersion ?? "TLSv1.3",
      maxVersion: input.maxVersion ?? "TLSv1.3",
      ...(input.certificate === false
        ? {}
        : {
            cert: TEST_CLIENT_CERTIFICATE_PEM,
            key: TEST_CLIENT_PRIVATE_KEY_PEM,
          }),
    };
    const socket: TLSSocket = connect(options);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        bytes: Buffer.concat(chunks),
        ...(firstError === undefined ? {} : { error: firstError }),
        ...(protocol === undefined ? {} : { protocol }),
      });
    };
    const timeout = setTimeout(() => {
      firstError ??= new Error("TLS test client timed out");
      socket.destroy();
      finish();
    }, 4_000);
    socket.once("secureConnect", () => {
      protocol = socket.getProtocol();
      socket.write(Buffer.from(input.bytes));
    });
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", (error) => {
      firstError ??= error;
    });
    socket.once("end", finish);
    socket.once("close", finish);
  });
}

function validRequest(): Uint8Array {
  return encodeRemoteProtocolClientJsonlFrame(
    decodeRemoteProtocolClientFrame({
      protocol: "hitch.remote",
      version: 1,
      frame: "request",
      requestId: "remote-request-1",
      command: { kind: "get-turn", turnId: "turn-1" },
    }),
  );
}

function serverOptions(input: {
  readonly trust: ClientCertificateTrustBundle;
  readonly authentication: RemoteConnectorAuthenticationPort;
  readonly handle: (
    exchange: AuthenticatedRemoteProtocolExchange,
  ) => Promise<void>;
  readonly errors?: unknown[];
}): ListenRemoteProtocolTlsOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    serverCertificatePem: Buffer.from(TEST_SERVER_CERTIFICATE_PEM),
    serverPrivateKeyPem: Buffer.from(TEST_SERVER_PRIVATE_KEY_PEM),
    clientCertificateAuthorityPem: Buffer.from(TEST_CA_CERTIFICATE_PEM),
    certificateVerifier: input.trust.verifier,
    authentication: input.authentication,
    handle: input.handle,
    onConnectionError: (error) => input.errors?.push(error),
  };
}

function authenticatingPort(
  trust: ClientCertificateTrustBundle,
  count: { value: number },
): RemoteConnectorAuthenticationPort {
  const expectedFingerprint = fingerprintClientCertificateDer(
    new X509Certificate(TEST_CLIENT_CERTIFICATE_PEM).raw,
  );
  return Object.freeze({
    async authenticate(
      evidence: VerifiedClientCertificateEvidence,
    ): Promise<ConnectorAuthenticationResult> {
      count.value += 1;
      assert.deepEqual(trust.evidenceConsumer.consume(evidence), {
        trustRootId: "private-alpha-client-ca-v1",
        fingerprint: expectedFingerprint,
      });
      return Object.freeze({
        status: "authenticated" as const,
        context: CONTEXT,
      });
    },
  });
}

async function realMtlsIngress(): Promise<void> {
  const trust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CLOCK,
  });
  const authenticated = { value: 0 };
  let handled = 0;
  const errors: unknown[] = [];
  const server = await listenRemoteProtocolTls(
    serverOptions({
      trust,
      authentication: authenticatingPort(trust, authenticated),
      handle: async (exchange) => {
        handled += 1;
        assert.equal(exchange.context, CONTEXT);
        assert.equal(exchange.request.command.kind, "get-turn");
        await exchange.respond({
          status: "succeeded",
          result: {
            kind: "turn-found",
            turnId: "turn-1",
            state: "queued",
            updatedAt: "2026-08-09T12:00:00.000Z",
          },
        } as RemoteProtocolCommandOutcome);
      },
      errors,
    }),
  );
  try {
    const result = await requestOverTls({ server, bytes: validRequest() });
    assert.equal(result.error, undefined);
    assert.equal(result.protocol, "TLSv1.3");
    assert.equal(errors.length, 0, String(errors[0]));
    assert.equal(authenticated.value, 1);
    assert.equal(handled, 1);
    const response = decodeRemoteProtocolServerJsonlFrame(result.bytes);
    assert.equal(response.requestId, "remote-request-1");
    assert.equal(response.outcome.status, "succeeded");
  } finally {
    await server.close();
  }
  assert.equal(server.isClosing, true);
  assert.equal(server.isClosed, true);
}

mvpScenarioCase({
  scenarioId: "V2-MVP-S01",
  caseId: "real-mtls-ingress",
  title: "real TLS 1.3 ingress derives identity before bounded framing",
  run: realMtlsIngress,
});

test("missing client certificates and TLS 1.2 fail before authentication or framing", async () => {
  const trust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CLOCK,
  });
  const authenticated = { value: 0 };
  let handled = 0;
  const errors: unknown[] = [];
  const server = await listenRemoteProtocolTls(
    serverOptions({
      trust,
      authentication: authenticatingPort(trust, authenticated),
      handle: async () => {
        handled += 1;
      },
      errors,
    }),
  );
  try {
    const noCertificate = await requestOverTls({
      server,
      bytes: validRequest(),
      certificate: false,
    });
    assert.equal(noCertificate.bytes.length, 0);
    assert.ok(noCertificate.error instanceof Error);

    const oldTls = await requestOverTls({
      server,
      bytes: validRequest(),
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    });
    assert.equal(oldTls.bytes.length, 0);
    assert.ok(oldTls.error instanceof Error);
    assert.equal(authenticated.value, 0);
    assert.equal(handled, 0);
    assert.ok(errors.length >= 2);
  } finally {
    await server.close();
  }
});

test("authentication rejection and forbidden remote frames close without dispatch", async () => {
  const rejectedTrust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CLOCK,
  });
  let rejectedAuthentication = 0;
  let rejectedHandled = 0;
  const rejectedErrors: unknown[] = [];
  const rejectedServer = await listenRemoteProtocolTls(
    serverOptions({
      trust: rejectedTrust,
      authentication: {
        async authenticate(evidence) {
          rejectedAuthentication += 1;
          rejectedTrust.evidenceConsumer.consume(evidence);
          return {
            status: "rejected",
            authenticationRequestId: "authentication-rejected",
            reason: "binding-revoked",
          } as ConnectorAuthenticationResult;
        },
      },
      handle: async () => {
        rejectedHandled += 1;
      },
      errors: rejectedErrors,
    }),
  );
  try {
    const result = await requestOverTls({
      server: rejectedServer,
      bytes: new TextEncoder().encode("not-json\n"),
    });
    assert.equal(result.bytes.length, 0);
    assert.equal(rejectedErrors.length, 0, String(rejectedErrors[0]));
    assert.equal(rejectedAuthentication, 1);
    assert.equal(rejectedHandled, 0);
  } finally {
    await rejectedServer.close();
  }

  const strictTrust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CLOCK,
  });
  const authenticated = { value: 0 };
  let strictHandled = 0;
  const strictServer = await listenRemoteProtocolTls(
    serverOptions({
      trust: strictTrust,
      authentication: authenticatingPort(strictTrust, authenticated),
      handle: async () => {
        strictHandled += 1;
      },
    }),
  );
  try {
    const admin = new TextEncoder().encode(
      '{"protocol":"hitch.remote","version":1,"frame":"request","requestId":"remote-admin","command":{"kind":"admin-disable-principal","principalReference":"user-b"}}\n',
    );
    const result = await requestOverTls({ server: strictServer, bytes: admin });
    assert.equal(result.bytes.length, 0);
    assert.equal(authenticated.value, 1);
    assert.equal(strictHandled, 0);
  } finally {
    await strictServer.close();
  }
});

test("remote listener rejects widened deadlines, DNS bind names, and CA bundles", async () => {
  const trust = createClientCertificateTrust({
    trustRootId: "private-alpha-client-ca-v1",
    clock: CLOCK,
  });
  const base = serverOptions({
    trust,
    authentication: authenticatingPort(trust, { value: 0 }),
    handle: async () => undefined,
  });
  for (const invalid of [
    { ...base, host: "localhost" },
    { ...base, requestDeadlineMs: 30_001 },
    {
      ...base,
      clientCertificateAuthorityPem: Buffer.from(
        `${TEST_CA_CERTIFICATE_PEM}\n${TEST_CA_CERTIFICATE_PEM}`,
      ),
    },
  ]) {
    await assert.rejects(
      listenRemoteProtocolTls(invalid),
      RemoteTlsConfigurationError,
    );
  }
});

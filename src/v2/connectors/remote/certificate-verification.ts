import { X509Certificate } from "node:crypto";

import {
  decodeClientCertificateTrustRootId,
  fingerprintClientCertificateDer,
} from "../../codecs/primitives.js";
import type {
  Clock,
  VerifiedClientCertificateEvidence,
} from "../../model/application.js";
import type {
  ClientCertificateFingerprint,
  ClientCertificateTrustRootId,
} from "../../model/primitives.js";

export const MVP_REMOTE_TLS_VERSION = "TLSv1.3" as const;
export const X509_CLIENT_AUTH_EXTENDED_KEY_USAGE =
  "1.3.6.1.5.5.7.3.2" as const;
export const MAXIMUM_CLIENT_CERTIFICATE_DER_BYTES = 64 * 1024;

const ALLOWED_EC_CURVES = new Set([
  "prime256v1",
  "secp384r1",
  "secp521r1",
]);

export type ClientCertificateVerificationRejection =
  | "tls-peer-unauthorized"
  | "tls-version-unsupported"
  | "certificate-der-invalid"
  | "certificate-not-currently-valid"
  | "certificate-is-ca"
  | "client-auth-purpose-missing"
  | "public-key-policy-denied";

export interface TlsClientCertificateInput {
  /** Result of Node/OpenSSL verification against the one configured CA. */
  readonly authorized: boolean;
  readonly authorizationError?: string;
  readonly protocol: string | null;
  /** Complete DER leaf bytes returned by the accepted TLS socket. */
  readonly completeDer: Uint8Array;
}

export type ClientCertificateVerificationResult =
  | {
      readonly status: "verified";
      readonly evidence: VerifiedClientCertificateEvidence;
    }
  | {
      readonly status: "rejected";
      readonly reason: ClientCertificateVerificationRejection;
    };

export interface ClientCertificateVerificationPort {
  verify(input: TlsClientCertificateInput): ClientCertificateVerificationResult;
}

export interface VerifiedClientCertificateMaterial {
  readonly trustRootId: ClientCertificateTrustRootId;
  readonly fingerprint: ClientCertificateFingerprint;
}

/** Passed only to the remote authentication adapter. Evidence is one-shot. */
export interface VerifiedClientCertificateEvidenceConsumer {
  consume(
    evidence: VerifiedClientCertificateEvidence,
  ): VerifiedClientCertificateMaterial;
}

export interface ClientCertificateTrustBundle {
  /** Passed only to the mTLS listener after the TLS handshake. */
  readonly verifier: ClientCertificateVerificationPort;
  /** Passed only to the remote authentication adapter. */
  readonly evidenceConsumer: VerifiedClientCertificateEvidenceConsumer;
}

export class ClientCertificateTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientCertificateTrustError";
  }
}

export class ClientCertificatePolicyError extends Error {
  readonly reason: Exclude<
    ClientCertificateVerificationRejection,
    "tls-peer-unauthorized" | "tls-version-unsupported"
  >;

  constructor(
    reason: ClientCertificatePolicyError["reason"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientCertificatePolicyError";
    this.reason = reason;
  }
}

function requireBoundedCompleteDer(input: Uint8Array): Buffer {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 1 ||
    input.byteLength > MAXIMUM_CLIENT_CERTIFICATE_DER_BYTES
  ) {
    throw new ClientCertificatePolicyError(
      "certificate-der-invalid",
      "client certificate DER has an invalid byte length",
    );
  }
  const bytes = Buffer.from(input);
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(bytes);
  } catch (error) {
    throw new ClientCertificatePolicyError(
      "certificate-der-invalid",
      "client certificate DER cannot be parsed",
      { cause: error },
    );
  }
  if (
    certificate.raw.byteLength !== bytes.byteLength ||
    !certificate.raw.equals(bytes)
  ) {
    throw new ClientCertificatePolicyError(
      "certificate-der-invalid",
      "client certificate input must be the complete canonical DER leaf",
    );
  }
  return bytes;
}

function requireAllowedPublicKey(certificate: X509Certificate): void {
  const { asymmetricKeyDetails: details, asymmetricKeyType: type } =
    certificate.publicKey;
  if (
    (type === "rsa" || type === "rsa-pss") &&
    details?.modulusLength !== undefined &&
    details.modulusLength >= 2_048
  ) {
    return;
  }
  if (
    type === "ec" &&
    details?.namedCurve !== undefined &&
    ALLOWED_EC_CURVES.has(details.namedCurve)
  ) {
    return;
  }
  if (type === "ed25519") return;
  throw new ClientCertificatePolicyError(
    "public-key-policy-denied",
    "client certificate public key is outside the MVP allowlist",
  );
}

/**
 * Applies the leaf-only policy shared by enrollment and live ingress. Chain
 * validation is intentionally absent here: live ingress receives that result
 * from OpenSSL configured with Hitch's exact trust root.
 */
export function inspectMvpClientCertificate(input: {
  readonly completeDer: Uint8Array;
  readonly clock: Clock;
}): { readonly fingerprint: ClientCertificateFingerprint } {
  const bytes = requireBoundedCompleteDer(input.completeDer);
  const certificate = new X509Certificate(bytes);
  const now = Date.parse(input.clock.now());
  if (
    !Number.isFinite(now) ||
    now < certificate.validFromDate.getTime() ||
    now > certificate.validToDate.getTime()
  ) {
    throw new ClientCertificatePolicyError(
      "certificate-not-currently-valid",
      "client certificate is outside its validity interval",
    );
  }
  if (certificate.ca) {
    throw new ClientCertificatePolicyError(
      "certificate-is-ca",
      "a CA certificate cannot authenticate an MVP client",
    );
  }
  if (
    !Array.isArray(certificate.keyUsage) ||
    !certificate.keyUsage.includes(X509_CLIENT_AUTH_EXTENDED_KEY_USAGE)
  ) {
    throw new ClientCertificatePolicyError(
      "client-auth-purpose-missing",
      "client certificate lacks the client-authentication purpose",
    );
  }
  requireAllowedPublicKey(certificate);
  return Object.freeze({
    fingerprint: fingerprintClientCertificateDer(bytes),
  });
}

/** Creates one process-local, one-shot trust domain for mTLS evidence. */
export function createClientCertificateTrust(options: {
  readonly trustRootId: string;
  readonly clock: Clock;
}): ClientCertificateTrustBundle {
  const trustRootId = decodeClientCertificateTrustRootId(options.trustRootId);
  const verified = new WeakMap<object, VerifiedClientCertificateMaterial>();

  const verifier: ClientCertificateVerificationPort = Object.freeze({
    verify(input: TlsClientCertificateInput): ClientCertificateVerificationResult {
      if (
        input.authorized !== true ||
        input.authorizationError !== undefined
      ) {
        return Object.freeze({
          status: "rejected" as const,
          reason: "tls-peer-unauthorized" as const,
        });
      }
      if (input.protocol !== MVP_REMOTE_TLS_VERSION) {
        return Object.freeze({
          status: "rejected" as const,
          reason: "tls-version-unsupported" as const,
        });
      }
      let fingerprint: ClientCertificateFingerprint;
      try {
        ({ fingerprint } = inspectMvpClientCertificate({
          completeDer: input.completeDer,
          clock: options.clock,
        }));
      } catch (error) {
        if (error instanceof ClientCertificatePolicyError) {
          return Object.freeze({
            status: "rejected" as const,
            reason: error.reason,
          });
        }
        throw error;
      }
      const evidence = Object.freeze(
        {},
      ) as VerifiedClientCertificateEvidence;
      verified.set(evidence, Object.freeze({ trustRootId, fingerprint }));
      return Object.freeze({ status: "verified" as const, evidence });
    },
  });

  const evidenceConsumer: VerifiedClientCertificateEvidenceConsumer =
    Object.freeze({
      consume(
        evidence: VerifiedClientCertificateEvidence,
      ): VerifiedClientCertificateMaterial {
        if (typeof evidence !== "object" || evidence === null) {
          throw new ClientCertificateTrustError(
            "client certificate evidence was not minted by this trust domain",
          );
        }
        const material = verified.get(evidence);
        if (material === undefined) {
          throw new ClientCertificateTrustError(
            "client certificate evidence was not minted here or was already consumed",
          );
        }
        verified.delete(evidence);
        return material;
      },
    });

  return Object.freeze({ verifier, evidenceConsumer });
}

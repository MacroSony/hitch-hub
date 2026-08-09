import type { EndpointAddress, EndpointAudience } from "../model/endpoint-binding.js";
import type {
  AuthenticationSource,
  InstallationRole,
  PrincipalKind,
} from "../model/identity-access.js";
import type {
  AuthenticationSubjectId,
  ClientCertificateFingerprint,
  LocalEndpointId,
} from "../model/primitives.js";
import { codecFail, type CodecPath } from "./errors.js";
import {
  decodeBoundedString,
  decodeClientCertificateFingerprint,
  decodeClientCertificateTrustRootId,
  decodeServiceId,
} from "./primitives.js";
import {
  at,
  decodeEnum,
  decodePlainObject,
  decodeString,
  requireExactFields,
} from "./structure.js";

export type MvpAuthenticationSource = Extract<
  AuthenticationSource,
  { readonly kind: "local-peer" | "mtls-client" }
>;

export type MvpEndpointAddress = Extract<
  EndpointAddress,
  { readonly kind: "local-client" | "remote-client" }
>;

function discriminant(
  input: Record<string, unknown>,
  supported: readonly string[],
  path: CodecPath,
): string {
  const kind = decodeString(input.kind, at(path, "kind"));
  if (!supported.includes(kind)) {
    codecFail(
      at(path, "kind"),
      "unsupported-discriminant",
      `MVP does not support ${JSON.stringify(kind)}`,
    );
  }
  return kind;
}

/** Executable MVP sources: bootstrap-local or exact mTLS leaf certificate. */
export function decodeMvpAuthenticationSource(
  input: unknown,
  path: CodecPath = [],
): MvpAuthenticationSource {
  const object = decodePlainObject(input, path);
  switch (discriminant(object, ["local-peer", "mtls-client"], path)) {
    case "local-peer":
      requireExactFields(object, ["kind", "localHostId"], [], path);
      return Object.freeze({
        kind: "local-peer" as const,
        localHostId: decodeServiceId(
          "LocalHost",
          object.localHostId,
          at(path, "localHostId"),
        ),
      });
    case "mtls-client":
      requireExactFields(object, ["kind", "trustRootId"], [], path);
      return Object.freeze({
        kind: "mtls-client" as const,
        trustRootId: decodeClientCertificateTrustRootId(
          object.trustRootId,
          at(path, "trustRootId"),
        ),
      });
    default:
      throw new Error("unreachable MVP authentication source");
  }
}

export function decodeMvpAuthenticationSubject(
  source: MvpAuthenticationSource,
  input: unknown,
  path: CodecPath = [],
): AuthenticationSubjectId | ClientCertificateFingerprint {
  const validatedSource = decodeMvpAuthenticationSource(source, path);
  switch (validatedSource.kind) {
    case "mtls-client":
      return decodeClientCertificateFingerprint(input, path);
    case "local-peer":
      return decodeBoundedString(
        input,
        {
          minimumLength: 1,
          maximumLength: 128,
          pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u,
          label: "local authentication subject",
        },
        path,
      ) as AuthenticationSubjectId;
    default:
      throw new Error("unreachable MVP authentication subject source");
  }
}

/** Executable MVP endpoints are private local or certificate-bound clients. */
export function decodeMvpEndpointAddress(
  input: unknown,
  path: CodecPath = [],
): MvpEndpointAddress {
  const object = decodePlainObject(input, path);
  switch (discriminant(object, ["local-client", "remote-client"], path)) {
    case "local-client":
      requireExactFields(
        object,
        ["kind", "localHostId", "localEndpointId"],
        [],
        path,
      );
      return Object.freeze({
        kind: "local-client" as const,
        localHostId: decodeServiceId(
          "LocalHost",
          object.localHostId,
          at(path, "localHostId"),
        ),
        localEndpointId: decodeBoundedString(
          object.localEndpointId,
          {
            minimumLength: 1,
            maximumLength: 128,
            pattern: /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u,
            label: "local endpoint ID",
          },
          at(path, "localEndpointId"),
        ) as LocalEndpointId,
      });
    case "remote-client":
      requireExactFields(object, ["kind", "identityBindingId"], [], path);
      return Object.freeze({
        kind: "remote-client" as const,
        identityBindingId: decodeServiceId(
          "IdentityBinding",
          object.identityBindingId,
          at(path, "identityBindingId"),
        ),
      });
    default:
      throw new Error("unreachable MVP endpoint address");
  }
}

export function decodeMvpEndpointAudience(
  input: unknown,
  path: CodecPath = [],
): Extract<EndpointAudience, { readonly kind: "private" }> {
  const object = decodePlainObject(input, path);
  discriminant(object, ["private"], path);
  requireExactFields(object, ["kind", "principalId"], [], path);
  return Object.freeze({
    kind: "private" as const,
    principalId: decodeServiceId(
      "Principal",
      object.principalId,
      at(path, "principalId"),
    ),
  });
}

export function decodeMvpPrincipalKind(
  input: unknown,
  path: CodecPath = [],
): Extract<PrincipalKind, "human"> {
  if (input !== "human") {
    codecFail(path, "unsupported-discriminant", "MVP principals must be human");
  }
  return "human";
}

export function decodeMvpInstallationRole(
  input: unknown,
  path: CodecPath = [],
): InstallationRole {
  return decodeEnum(input, ["admin", "member"], path);
}

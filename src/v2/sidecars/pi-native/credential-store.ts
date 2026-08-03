import { codecFail, type CodecPath } from "../../codecs/errors.js";
import {
  decodeBoundedString,
  decodeNonNegativeSafeInteger,
} from "../../codecs/primitives.js";
import {
  at,
  decodeLiteral,
  decodePlainObject,
  requireExactFields,
} from "../../codecs/structure.js";
import { decodePiNativeSidecarManifest } from "./manifest.js";

const MAXIMUM_CREDENTIAL_CHARACTERS = 65_536;

export type PiNativeCredential =
  | {
      readonly type: "api_key";
      readonly key: string;
    }
  | {
      readonly type: "oauth";
      readonly access: string;
      readonly refresh: string;
      readonly expires: number;
    };

/**
 * A V2-011-owned source will bind this port to one live credential resource.
 * A2 deliberately receives no path, environment, or raw credential config.
 */
export interface BoundPiNativeCredentialSource {
  readonly resolverId: string;
  readonly providerId: string;
  readonly credentialType: PiNativeCredential["type"];
  /** A linearizable read of the currently committed credential resource. */
  read(): Promise<unknown>;
  /**
   * One resource-wide atomic read/transform/write operation. V2-011 must
   * serialize this across every source and process bound to the resource.
   */
  modify(
    transform: (current: unknown) => unknown | Promise<unknown>,
  ): Promise<unknown>;
}

export interface PiNativeCredentialMetadata {
  readonly providerId: string;
  readonly type: PiNativeCredential["type"];
}

export interface PiNativeCredentialStore {
  read(providerId: string): Promise<PiNativeCredential | undefined>;
  list(): Promise<readonly PiNativeCredentialMetadata[]>;
  modify(
    providerId: string,
    transform: (
      current: PiNativeCredential | undefined,
    ) => PiNativeCredential | undefined | Promise<PiNativeCredential | undefined>,
  ): Promise<PiNativeCredential | undefined>;
  delete(providerId: string): Promise<never>;
}

export function createPiNativeCredentialStore(input: {
  readonly manifest: unknown;
  readonly source: BoundPiNativeCredentialSource;
}): PiNativeCredentialStore {
  const expected = decodePiNativeSidecarManifest(input.manifest).credentialStore;
  const source = Object.freeze({
    resolverId: input.source.resolverId,
    providerId: input.source.providerId,
    credentialType: input.source.credentialType,
    read: input.source.read.bind(input.source),
    modify: input.source.modify.bind(input.source),
  });
  if (
    source.resolverId !== expected.resolverId ||
    source.providerId !== expected.providerId ||
    (source.credentialType !== "api_key" && source.credentialType !== "oauth")
  ) {
    throw new Error("bound Pi credential source does not match the sidecar manifest");
  }
  const requireProvider = (providerId: string): void => {
    if (providerId !== expected.providerId) {
      throw new Error("Pi credential access crossed the frozen provider binding");
    }
  };
  const readCurrent = async (): Promise<PiNativeCredential> => {
    const credential = decodePiNativeCredential(await source.read());
    if (credential.type !== source.credentialType) {
      throw new Error("Pi credential type changed behind its bound source");
    }
    return credential;
  };
  const store: PiNativeCredentialStore = {
    async read(providerId): Promise<PiNativeCredential | undefined> {
      requireProvider(providerId);
      return detachCredential(await readCurrent());
    },
    async list(): Promise<readonly PiNativeCredentialMetadata[]> {
      return Object.freeze([
        Object.freeze({
          providerId: expected.providerId,
          type: source.credentialType,
        }),
      ]);
    },
    modify(providerId, transform): Promise<PiNativeCredential | undefined> {
      requireProvider(providerId);
      if (source.credentialType !== "oauth") {
        return Promise.reject(
          new Error("Pi API-key credentials do not grant native write authority"),
        );
      }
      return source.modify(async (rawCurrent) => {
        const current = decodePiNativeCredential(rawCurrent);
        if (current.type !== "oauth") {
          throw new Error("Pi credential type changed behind its bound source");
        }
        const proposed = await transform(detachCredential(current));
        if (proposed === undefined) return detachCredential(current);
        const replacement = decodePiNativeCredential(proposed);
        if (replacement.type !== "oauth") {
          throw new Error("Pi credential refresh cannot change credential type");
        }
        return detachCredential(replacement);
      }).then((rawCommitted) => {
        const committed = decodePiNativeCredential(rawCommitted);
        if (committed.type !== "oauth") {
          throw new Error("Pi credential type changed behind its bound source");
        }
        return detachCredential(committed);
      });
    },
    async delete(providerId): Promise<never> {
      requireProvider(providerId);
      throw new Error("Pi credential deletion is outside the native sidecar authority");
    },
  };
  return Object.freeze(store);
}

export function decodePiNativeCredential(
  input: unknown,
  path: CodecPath = [],
): PiNativeCredential {
  const object = decodePlainObject(input, path);
  if (object.type === "api_key") {
    requireExactFields(object, ["type", "key"], [], path);
    return Object.freeze({
      type: decodeLiteral(object.type, "api_key", at(path, "type")),
      key: decodeSecret(object.key, at(path, "key"), "Pi API key"),
    });
  }
  if (object.type === "oauth") {
    requireExactFields(object, ["type", "access", "refresh", "expires"], [], path);
    return Object.freeze({
      type: decodeLiteral(object.type, "oauth", at(path, "type")),
      access: decodeSecret(object.access, at(path, "access"), "Pi OAuth access token"),
      refresh: decodeSecret(object.refresh, at(path, "refresh"), "Pi OAuth refresh token"),
      expires: decodeNonNegativeSafeInteger(object.expires, at(path, "expires")),
    });
  }
  codecFail(at(path, "type"), "unsupported-discriminant", "unsupported Pi credential type");
}

function decodeSecret(input: unknown, path: CodecPath, label: string): string {
  const value = decodeBoundedString(
    input,
    {
      minimumLength: 1,
      maximumLength: MAXIMUM_CREDENTIAL_CHARACTERS,
      label,
    },
    path,
  );
  if (/\r|\n|\u0000/u.test(value)) {
    codecFail(path, "invalid-format", `${label} contains a control delimiter`);
  }
  return value;
}

function detachCredential(credential: PiNativeCredential): PiNativeCredential {
  return credential.type === "api_key"
    ? Object.freeze({ type: "api_key", key: credential.key })
    : Object.freeze({
        type: "oauth",
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      });
}

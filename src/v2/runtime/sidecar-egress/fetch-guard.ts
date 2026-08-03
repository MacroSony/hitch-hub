import type { TrustedUpstreamOrigin } from "../../model/primitives.js";

export type SidecarFetchPolicyFailure = "unregistered-origin" | "redirect-denied";

export class SidecarFetchPolicyError extends Error {
  constructor(readonly reason: SidecarFetchPolicyFailure) {
    super(`sidecar fetch policy rejected the operation: ${reason}`);
    this.name = "SidecarFetchPolicyError";
  }
}

export type SidecarFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const installedFetchGuardBrand: unique symbol = Symbol("installed-sidecar-fetch-guard");

export interface InstalledSidecarFetchGuard {
  readonly [installedFetchGuardBrand]: true;
}

const installedFetchGuards = new WeakSet<object>();

/**
 * Complements the OS boundary: the relay blocks alternate authorities, while
 * this guard makes every native-provider redirect observable and fatal,
 * including same-origin redirects that the relay cannot distinguish.
 */
export function createRedirectDenyingFetch(
  allowedOrigins: readonly TrustedUpstreamOrigin[],
  nativeFetch: SidecarFetch = globalThis.fetch,
): SidecarFetch {
  const allowed = new Set<string>(allowedOrigins);
  return async (input, init = {}) => {
    const url = requestUrl(input);
    if (!allowed.has(url.origin)) {
      throw new SidecarFetchPolicyError("unregistered-origin");
    }
    const response = await nativeFetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel();
      } catch {
        // The redirect is denied regardless of response-body cleanup outcome.
      }
      throw new SidecarFetchPolicyError("redirect-denied");
    }
    return response;
  };
}

/**
 * V2-006A2 calls this before importing Pi or provider code. The global fetch
 * seam becomes non-writable and non-configurable so redirect denial is part
 * of the sidecar's composite egress boundary, not an optional helper.
 */
export function installSidecarFetchGuard(
  allowedOrigins: readonly TrustedUpstreamOrigin[],
): InstalledSidecarFetchGuard {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (descriptor?.configurable === false) {
    throw new Error("sidecar fetch guard cannot replace the existing fetch seam");
  }
  const nativeFetch = globalThis.fetch.bind(globalThis) as SidecarFetch;
  const guardedFetch = createRedirectDenyingFetch(allowedOrigins, nativeFetch);
  Object.defineProperty(globalThis, "fetch", {
    value: guardedFetch,
    enumerable: descriptor?.enumerable ?? true,
    configurable: false,
    writable: false,
  });
  const proof = Object.freeze({ [installedFetchGuardBrand]: true as const });
  installedFetchGuards.add(proof);
  return proof;
}

/** V2-006B uses this proof gate before loading the verified Pi artifact. */
export function requireInstalledSidecarFetchGuard(
  proof: InstalledSidecarFetchGuard,
): void {
  if (!installedFetchGuards.has(proof)) {
    throw new Error("forged installed sidecar fetch guard proof");
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (
    descriptor?.configurable !== false ||
    descriptor.writable !== false ||
    typeof descriptor.value !== "function"
  ) {
    throw new Error("sidecar fetch guard changed after installation");
  }
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
}

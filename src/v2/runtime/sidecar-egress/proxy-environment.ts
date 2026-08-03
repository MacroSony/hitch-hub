const LOOPBACK_PROXY_HOST = "127.0.0.1";
export const SIDECAR_EGRESS_PROXY_PORT = 43_817;
export const SIDECAR_EGRESS_PROXY_URL = `http://${LOOPBACK_PROXY_HOST}:${SIDECAR_EGRESS_PROXY_PORT}`;

export interface SidecarProxyEnvironment {
  readonly NODE_USE_ENV_PROXY: "1";
  readonly HTTP_PROXY: typeof SIDECAR_EGRESS_PROXY_URL;
  readonly HTTPS_PROXY: typeof SIDECAR_EGRESS_PROXY_URL;
}

/**
 * An exact environment, not a projection of the host environment. In
 * particular, Node options, TLS overrides, CA paths, credentials, provider
 * variables, and lowercase/bypass proxy variables cannot cross this seam.
 */
export function projectSidecarProxyEnvironment(): SidecarProxyEnvironment {
  return Object.freeze({
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: SIDECAR_EGRESS_PROXY_URL,
    HTTPS_PROXY: SIDECAR_EGRESS_PROXY_URL,
  });
}

export type HostProxySelection =
  | { readonly kind: "direct" }
  | { readonly kind: "http-connect"; readonly url: string };

/**
 * Reads only HTTPS_PROXY/https_proxy under explicit fixed precedence. Other
 * ambient proxy variables are never forwarded to the sidecar or relay.
 */
export function selectHostHttpsProxy(
  environment: Readonly<NodeJS.ProcessEnv>,
): HostProxySelection {
  const upper = nonempty(environment.HTTPS_PROXY);
  const lower = nonempty(environment.https_proxy);
  if (upper !== undefined && lower !== undefined && upper !== lower) {
    throw new Error("ambiguous HTTPS proxy environment");
  }
  const selected = upper ?? lower;
  if (selected === undefined) return Object.freeze({ kind: "direct" });
  let url: URL;
  try {
    url = new URL(selected);
  } catch {
    throw new Error("invalid HTTPS proxy environment");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname === ""
  ) {
    throw new Error("unsupported HTTPS proxy environment");
  }
  return Object.freeze({ kind: "http-connect", url: url.href });
}

function nonempty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

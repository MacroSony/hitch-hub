import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { decodeTrustedUpstreamOrigin } from "../../codecs/primitives.js";
import type { TrustedUpstreamOrigin } from "../../model/primitives.js";

const MAX_ORIGINS = 8;
const MAX_ADDRESSES_PER_HOST = 32;
const DNS_DEADLINE_MILLISECONDS = 5_000;

export type SidecarEgressPolicyFailure =
  | "invalid-origin"
  | "literal-origin-address-denied"
  | "duplicate-origin-authority"
  | "dns-unavailable"
  | "dns-address-limit-exceeded"
  | "non-public-provider-address"
  | "disallowed-operator-proxy-address"
  | "dns-address-set-changed"
  | "unregistered-authority";

export class SidecarEgressPolicyError extends Error {
  constructor(readonly reason: SidecarEgressPolicyFailure) {
    super(`sidecar egress policy rejected the operation: ${reason}`);
    this.name = "SidecarEgressPolicyError";
  }
}

export interface ResolvedNetworkAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type SidecarDnsLookup = (
  hostname: string,
) => Promise<readonly ResolvedNetworkAddress[]>;

export interface AuthorizedEgressTarget {
  readonly origin: TrustedUpstreamOrigin;
  readonly hostname: string;
  readonly authority: string;
  readonly hostHeader: string;
  readonly port: number;
  readonly addresses: readonly ResolvedNetworkAddress[];
}

interface PinnedOrigin extends AuthorizedEgressTarget {
  readonly addressKeys: readonly string[];
}

export interface SidecarEgressPolicySnapshot {
  readonly version: 1;
  readonly dns: "host-resolved-exact-address-set";
  readonly addressPolicy: "public-unicast-only";
  readonly origins: readonly {
    readonly origin: TrustedUpstreamOrigin;
    readonly authority: string;
    readonly addresses: readonly ResolvedNetworkAddress[];
  }[];
}

export class PinnedSidecarEgressPolicy {
  readonly #lookup: SidecarDnsLookup;
  readonly #byAuthority: ReadonlyMap<string, PinnedOrigin>;
  readonly #snapshot: SidecarEgressPolicySnapshot;

  private constructor(input: {
    readonly lookup: SidecarDnsLookup;
    readonly origins: readonly PinnedOrigin[];
  }) {
    this.#lookup = input.lookup;
    this.#byAuthority = new Map(
      input.origins.map((origin) => [origin.authority, origin]),
    );
    this.#snapshot = deepFreeze({
      version: 1,
      dns: "host-resolved-exact-address-set",
      addressPolicy: "public-unicast-only",
      origins: input.origins.map((origin) => ({
        origin: origin.origin,
        authority: origin.authority,
        addresses: origin.addresses.map((address) => ({ ...address })),
      })),
    });
    Object.freeze(this);
  }

  static async pin(
    origins: readonly TrustedUpstreamOrigin[],
    lookup: SidecarDnsLookup = lookupAll,
  ): Promise<PinnedSidecarEgressPolicy> {
    const detachedOrigins = [...origins];
    if (detachedOrigins.length === 0 || detachedOrigins.length > MAX_ORIGINS) {
      throw new SidecarEgressPolicyError("invalid-origin");
    }
    const pinned: PinnedOrigin[] = [];
    const authorities = new Set<string>();
    for (const rawOrigin of detachedOrigins) {
      let origin: TrustedUpstreamOrigin;
      try {
        origin = decodeTrustedUpstreamOrigin(rawOrigin);
      } catch {
        throw new SidecarEgressPolicyError("invalid-origin");
      }
      const url = new URL(origin);
      const hostname = unbracketUrlHostname(url.hostname);
      if (isIP(hostname) !== 0 || hostname.endsWith(".")) {
        throw new SidecarEgressPolicyError("literal-origin-address-denied");
      }
      const port = url.port === "" ? 443 : decodePort(url.port);
      const authority = `${hostname}:${port}`;
      if (authorities.has(authority)) {
        throw new SidecarEgressPolicyError("duplicate-origin-authority");
      }
      authorities.add(authority);
      const addresses = await resolveAddresses(hostname, lookup, "provider");
      pinned.push(
        deepFreeze({
          origin,
          hostname,
          authority,
          hostHeader: port === 443 ? hostname : authority,
          port,
          addresses,
          addressKeys: addresses.map(addressKey),
        }),
      );
    }
    return new PinnedSidecarEgressPolicy({ lookup, origins: pinned });
  }

  snapshot(): SidecarEgressPolicySnapshot {
    return this.#snapshot;
  }

  expectedHostHeader(authority: string): string | undefined {
    return this.#byAuthority.get(authority)?.hostHeader;
  }

  async authorizeConnect(authority: string): Promise<AuthorizedEgressTarget> {
    return this.authorizeConnectWithSignal(authority);
  }

  async authorizeConnectWithSignal(
    authority: string,
    signal?: AbortSignal,
  ): Promise<AuthorizedEgressTarget> {
    const pinned = this.#byAuthority.get(authority);
    if (pinned === undefined) {
      throw new SidecarEgressPolicyError("unregistered-authority");
    }
    const current = await resolveAddresses(
      pinned.hostname,
      this.#lookup,
      "provider",
      signal,
    );
    const currentKeys = current.map(addressKey);
    if (!sameStrings(pinned.addressKeys, currentKeys)) {
      throw new SidecarEgressPolicyError("dns-address-set-changed");
    }
    return pinned;
  }
}

/** Node URL.hostname retains brackets around IPv6 literals. */
export function unbracketUrlHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export async function lookupAll(
  hostname: string,
): Promise<readonly ResolvedNetworkAddress[]> {
  const answers = await systemLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new SidecarEgressPolicyError("dns-unavailable");
    }
    return { address: answer.address, family: answer.family };
  });
}

export async function resolveAddresses(
  hostname: string,
  lookup: SidecarDnsLookup,
  use: "provider" | "operator-proxy",
  signal?: AbortSignal,
): Promise<readonly ResolvedNetworkAddress[]> {
  let answers: readonly ResolvedNetworkAddress[];
  try {
    answers = await awaitWithDeadline(
      lookup(hostname),
      signal,
      DNS_DEADLINE_MILLISECONDS,
    );
  } catch {
    throw new SidecarEgressPolicyError("dns-unavailable");
  }
  if (answers.length === 0) {
    throw new SidecarEgressPolicyError("dns-unavailable");
  }
  if (answers.length > MAX_ADDRESSES_PER_HOST) {
    throw new SidecarEgressPolicyError("dns-address-limit-exceeded");
  }
  const normalized = new Map<string, ResolvedNetworkAddress>();
  for (const answer of answers) {
    const address = normalizeNetworkAddress(answer.address, answer.family);
    if (use === "provider" && !isPublicProviderAddress(address)) {
      throw new SidecarEgressPolicyError("non-public-provider-address");
    }
    if (use === "operator-proxy" && !isAllowedOperatorProxyAddress(address)) {
      throw new SidecarEgressPolicyError("disallowed-operator-proxy-address");
    }
    normalized.set(addressKey(address), address);
  }
  return deepFreeze(
    [...normalized.values()].sort((left, right) => {
      const leftKey = addressKey(left);
      const rightKey = addressKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  );
}

export function normalizeNetworkAddress(
  input: string,
  expectedFamily?: 4 | 6,
): ResolvedNetworkAddress {
  if (input.includes("%")) {
    throw new SidecarEgressPolicyError("non-public-provider-address");
  }
  const family = isIP(input);
  if (
    (family !== 4 && family !== 6) ||
    (expectedFamily !== undefined && family !== expectedFamily)
  ) {
    throw new SidecarEgressPolicyError("non-public-provider-address");
  }
  return Object.freeze({
    address: family === 4 ? normalizeIpv4(input) : normalizeIpv6(input),
    family,
  });
}

export function isPublicProviderAddress(
  address: ResolvedNetworkAddress,
): boolean {
  if (address.family === 4) {
    const value = ipv4Number(address.address);
    return !IPV4_DENIED_RANGES.some(([network, prefix]) =>
      inIpv4Prefix(value, network, prefix),
    );
  }
  const groups = address.address.split(":").map((group) => Number.parseInt(group, 16));
  const first = groups[0];
  const second = groups[1];
  if (first === undefined || second === undefined) return false;
  // First-slice provider endpoints must resolve to ordinary global unicast.
  if ((first & 0xe000) !== 0x2000) return false;
  // Deny IPv6 special-use/transition ranges that can encode a non-public IPv4
  // destination, plus the two documentation ranges inside global unicast.
  if (first === 0x2001 && second <= 0x01ff) return false; // 2001::/23
  if (first === 0x2001 && second === 0x0db8) return false; // 2001:db8::/32
  if (first === 0x2002) return false; // 6to4 2002::/16
  if (first === 0x3fff && (second & 0xf000) === 0) return false; // 3fff::/20
  return true;
}

/** Explicit proxies may be global, RFC1918/ULA, or loopback unicast only. */
export function isAllowedOperatorProxyAddress(
  address: ResolvedNetworkAddress,
): boolean {
  if (isPublicProviderAddress(address)) return true;
  if (address.family === 4) {
    const value = ipv4Number(address.address);
    return (
      inIpv4Prefix(value, 0x0a000000, 8) ||
      inIpv4Prefix(value, 0x7f000000, 8) ||
      inIpv4Prefix(value, 0xac100000, 12) ||
      inIpv4Prefix(value, 0xc0a80000, 16)
    );
  }
  const groups = address.address.split(":").map((group) => Number.parseInt(group, 16));
  const first = groups[0];
  if (first === undefined) return false;
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  return loopback || uniqueLocal;
}

const IPV4_DENIED_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc0af3000, 24],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function decodePort(value: string): number {
  if (!/^[0-9]{1,5}$/u.test(value)) {
    throw new SidecarEgressPolicyError("invalid-origin");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new SidecarEgressPolicyError("invalid-origin");
  }
  return port;
}

function normalizeIpv4(input: string): string {
  const octets = input.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new SidecarEgressPolicyError("non-public-provider-address");
  }
  return octets.join(".");
}

function normalizeIpv6(input: string): string {
  let source = input.toLowerCase();
  const lastColon = source.lastIndexOf(":");
  const suffix = source.slice(lastColon + 1);
  if (suffix.includes(".")) {
    const ipv4 = normalizeIpv4(suffix);
    const value = ipv4Number(ipv4);
    source = `${source.slice(0, lastColon)}:${(value >>> 16).toString(16)}:${(
      value & 0xffff
    ).toString(16)}`;
  }
  if ((source.match(/::/gu) ?? []).length > 1) {
    throw new SidecarEgressPolicyError("non-public-provider-address");
  }
  const compressed = source.includes("::");
  const [leftSource = "", rightSource = ""] = compressed
    ? source.split("::")
    : [source, ""];
  const left = leftSource === "" ? [] : leftSource.split(":");
  const right = rightSource === "" ? [] : rightSource.split(":");
  if (
    [...left, ...right].some((group) => !/^[0-9a-f]{1,4}$/u.test(group)) ||
    (!compressed && left.length !== 8) ||
    (compressed && left.length + right.length >= 8)
  ) {
    throw new SidecarEgressPolicyError("non-public-provider-address");
  }
  const groups = compressed
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) {
    throw new SidecarEgressPolicyError("non-public-provider-address");
  }
  return groups.map((group) => group.padStart(4, "0")).join(":");
}

function ipv4Number(input: string): number {
  return input
    .split(".")
    .map(Number)
    .reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function inIpv4Prefix(value: number, network: number, prefix: number): boolean {
  const shift = 32 - prefix;
  return value >>> shift === network >>> shift;
}

function addressKey(address: ResolvedNetworkAddress): string {
  return `${address.family}:${address.address}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function awaitWithDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() => reject(new SidecarEgressPolicyError("dns-unavailable")));
    const timer = setTimeout(
      () => finish(() => reject(new SidecarEgressPolicyError("dns-unavailable"))),
      timeoutMilliseconds,
    );
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolvePromise(value)),
      () => finish(() => reject(new SidecarEgressPolicyError("dns-unavailable"))),
    );
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

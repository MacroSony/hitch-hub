import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeTrustedUpstreamOrigin } from "../../codecs/primitives.js";
import {
  isAllowedOperatorProxyAddress,
  isPublicProviderAddress,
  normalizeNetworkAddress,
  PinnedSidecarEgressPolicy,
  SidecarEgressPolicyError,
  type ResolvedNetworkAddress,
  type SidecarDnsLookup,
} from "./address-policy.js";

const origin = (value: string) => decodeTrustedUpstreamOrigin(value);
const answer = (address: string, family: 4 | 6): ResolvedNetworkAddress => ({
  address,
  family,
});

test("operator proxy addresses allow only global, private, ULA, or loopback unicast", () => {
  for (const address of [
    answer("8.8.8.8", 4),
    answer("10.1.2.3", 4),
    answer("172.16.2.3", 4),
    answer("192.168.2.3", 4),
    answer("127.0.0.1", 4),
    answer("fc00::1", 6),
    answer("::1", 6),
  ]) {
    assert.equal(
      isAllowedOperatorProxyAddress(
        normalizeNetworkAddress(address.address, address.family),
      ),
      true,
      address.address,
    );
  }
  for (const address of [
    answer("0.0.0.0", 4),
    answer("169.254.1.1", 4),
    answer("192.0.2.1", 4),
    answer("224.0.0.1", 4),
    answer("::", 6),
    answer("2001:db8::1", 6),
    answer("fe80::1", 6),
    answer("ff02::1", 6),
  ]) {
    assert.equal(
      isAllowedOperatorProxyAddress(
        normalizeNetworkAddress(address.address, address.family),
      ),
      false,
      address.address,
    );
  }
});

test("sidecar egress address policy permits only ordinary public unicast", () => {
  for (const address of [
    answer("8.8.8.8", 4),
    answer("93.184.216.34", 4),
    answer("2606:4700:4700::1111", 6),
  ]) {
    assert.equal(isPublicProviderAddress(normalizeNetworkAddress(address.address, address.family)), true);
  }
  for (const address of [
    answer("0.0.0.0", 4),
    answer("10.0.0.1", 4),
    answer("100.64.0.1", 4),
    answer("127.0.0.1", 4),
    answer("169.254.1.1", 4),
    answer("172.16.0.1", 4),
    answer("192.168.0.1", 4),
    answer("198.18.0.1", 4),
    answer("224.0.0.1", 4),
    answer("255.255.255.255", 4),
    answer("::", 6),
    answer("::1", 6),
    answer("64:ff9b::7f00:1", 6),
    answer("2001::ffff", 6),
    answer("2001:db8::1", 6),
    answer("2002:0808:0808::1", 6),
    answer("3fff::1", 6),
    answer("fc00::1", 6),
    answer("fe80::1", 6),
    answer("ff02::1", 6),
  ]) {
    assert.equal(
      isPublicProviderAddress(normalizeNetworkAddress(address.address, address.family)),
      false,
      address.address,
    );
  }
  assert.deepEqual(normalizeNetworkAddress("2606:4700:4700::1111", 6), {
    address: "2606:4700:4700:0000:0000:0000:0000:1111",
    family: 6,
  });
});

test("registered origins pin one exact public DNS address set", async () => {
  let chatAnswers: readonly ResolvedNetworkAddress[] = [
    answer("2606:4700:4700::1111", 6),
    answer("8.8.8.8", 4),
  ];
  const lookup: SidecarDnsLookup = async (hostname) =>
    hostname === "chatgpt.com" ? chatAnswers : [answer("1.1.1.1", 4)];
  const policy = await PinnedSidecarEgressPolicy.pin(
    [origin("https://chatgpt.com"), origin("https://auth.openai.com")],
    lookup,
  );

  assert.equal(policy.expectedHostHeader("chatgpt.com:443"), "chatgpt.com");
  assert.equal(policy.expectedHostHeader("attacker.invalid:443"), undefined);
  const target = await policy.authorizeConnect("chatgpt.com:443");
  assert.equal(target.origin, "https://chatgpt.com");
  assert.deepEqual(target.addresses, [
    answer("8.8.8.8", 4),
    answer("2606:4700:4700:0000:0000:0000:0000:1111", 6),
  ]);
  assert.equal(Object.isFrozen(policy.snapshot()), true);
  assert.equal(Object.isFrozen(policy.snapshot().origins), true);

  chatAnswers = [answer("1.0.0.1", 4)];
  await assert.rejects(
    policy.authorizeConnect("chatgpt.com:443"),
    (error: unknown) =>
      error instanceof SidecarEgressPolicyError &&
      error.reason === "dns-address-set-changed",
  );
  await assert.rejects(
    policy.authorizeConnect("attacker.invalid:443"),
    (error: unknown) =>
      error instanceof SidecarEgressPolicyError &&
      error.reason === "unregistered-authority",
  );
});

test("origin pinning rejects literals, private answers, mixed answers, and DNS failure", async () => {
  for (const literal of ["https://127.0.0.1", "https://[::1]"]) {
    await assert.rejects(
      PinnedSidecarEgressPolicy.pin(
        [origin(literal)],
        async () => [answer("127.0.0.1", 4)],
      ),
      (error: unknown) =>
        error instanceof SidecarEgressPolicyError &&
        error.reason === "literal-origin-address-denied",
    );
  }
  for (const answers of [
    [answer("10.0.0.1", 4)],
    [answer("8.8.8.8", 4), answer("169.254.169.254", 4)],
  ]) {
    await assert.rejects(
      PinnedSidecarEgressPolicy.pin(
        [origin("https://provider.example")],
        async () => answers,
      ),
      (error: unknown) =>
        error instanceof SidecarEgressPolicyError &&
        error.reason === "non-public-provider-address",
    );
  }
  await assert.rejects(
    PinnedSidecarEgressPolicy.pin(
      [origin("https://provider.example")],
      async () => {
        throw new Error("resolver unavailable");
      },
    ),
    (error: unknown) =>
      error instanceof SidecarEgressPolicyError && error.reason === "dns-unavailable",
  );
});

test("DNS revalidation is abortable before a dial can begin", async () => {
  let calls = 0;
  const policy = await PinnedSidecarEgressPolicy.pin(
    [origin("https://provider.example")],
    async () => {
      calls += 1;
      if (calls === 1) return [answer("8.8.8.8", 4)];
      return new Promise<readonly ResolvedNetworkAddress[]>(() => undefined);
    },
  );
  const abortController = new AbortController();
  const authorization = policy.authorizeConnectWithSignal(
    "provider.example:443",
    abortController.signal,
  );
  abortController.abort();
  await assert.rejects(
    authorization,
    (error: unknown) =>
      error instanceof SidecarEgressPolicyError && error.reason === "dns-unavailable",
  );
});

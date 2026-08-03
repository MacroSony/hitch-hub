import assert from "node:assert/strict";
import { test } from "node:test";

import {
  projectSidecarProxyEnvironment,
  selectHostHttpsProxy,
  SIDECAR_EGRESS_PROXY_URL,
} from "./proxy-environment.js";

test("sidecar proxy environment is an exact allowlist with fixed TLS policy", () => {
  const projected = projectSidecarProxyEnvironment();
  assert.deepEqual(projected, {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: SIDECAR_EGRESS_PROXY_URL,
    HTTPS_PROXY: SIDECAR_EGRESS_PROXY_URL,
  });
  for (const name of [
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "OPENAI_API_KEY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
  ]) {
    assert.equal(name in projected, false, name);
  }
  assert.equal(Object.isFrozen(projected), true);
});

test("host proxy selection has fixed HTTPS-only precedence and rejects ambiguity", () => {
  assert.deepEqual(selectHostHttpsProxy({}), { kind: "direct" });
  const selected = selectHostHttpsProxy({
    HTTPS_PROXY: "http://proxy.example:3128",
    https_proxy: "http://proxy.example:3128",
    ALL_PROXY: "socks5://ignored.example:1080",
  });
  assert.equal(selected.kind, "http-connect");
  if (selected.kind === "http-connect") {
    assert.equal(selected.url, "http://proxy.example:3128/");
  }
  assert.throws(
    () =>
      selectHostHttpsProxy({
        HTTPS_PROXY: "http://one.example:3128",
        https_proxy: "http://two.example:3128",
      }),
    /ambiguous/u,
  );
  for (const value of [
    "socks5://proxy.example:1080",
    "http://user:secret@proxy.example:3128",
    "http://proxy.example:3128/path",
  ]) {
    assert.throws(() => selectHostHttpsProxy({ HTTPS_PROXY: value }), /unsupported/u);
  }
});

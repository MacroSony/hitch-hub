import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";

import { decodeTrustedUpstreamOrigin } from "../../codecs/primitives.js";
import {
  createRedirectDenyingFetch,
  SidecarFetchPolicyError,
  type SidecarFetch,
} from "./fetch-guard.js";

test("sidecar fetch guard forces manual redirect handling and denies every redirect", async () => {
  let observedRedirect: "error" | "follow" | "manual" | undefined;
  const nativeFetch: SidecarFetch = async (_input, init) => {
    observedRedirect = init?.redirect;
    return new Response(null, {
      status: 302,
      headers: { location: "https://chatgpt.com/other" },
    });
  };
  const guarded = createRedirectDenyingFetch(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    nativeFetch,
  );
  await assert.rejects(
    guarded("https://chatgpt.com/backend-api/codex", { redirect: "follow" }),
    (error: unknown) =>
      error instanceof SidecarFetchPolicyError && error.reason === "redirect-denied",
  );
  assert.equal(observedRedirect, "manual");
});

test("installed sidecar fetch guard is nonreplaceable and produces runtime proof", async () => {
  const moduleUrl = new URL("./fetch-guard.ts", import.meta.url).href;
  const codecUrl = new URL("../../codecs/primitives.ts", import.meta.url).href;
  const source = `
    import {
      installSidecarFetchGuard,
      requireInstalledSidecarFetchGuard,
    } from ${JSON.stringify(moduleUrl)};
    import { decodeTrustedUpstreamOrigin } from ${JSON.stringify(codecUrl)};
    const proof = installSidecarFetchGuard([
      decodeTrustedUpstreamOrigin("https://chatgpt.com"),
    ]);
    requireInstalledSidecarFetchGuard(proof);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    let forged = false;
    try { requireInstalledSidecarFetchGuard({}); } catch { forged = true; }
    let replaced = false;
    try { globalThis.fetch = async () => new Response("unsafe"); } catch { replaced = true; }
    process.stdout.write(JSON.stringify({
      configurable: descriptor?.configurable,
      writable: descriptor?.writable,
      forged,
      replaced,
    }));
  `;
  const result = await runNode(source);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    configurable: false,
    writable: false,
    forged: true,
    replaced: true,
  });
});

function runNode(source: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), env: {} },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`fetch guard subprocess failed: ${stderr || error.message}`));
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });
}

test("sidecar fetch guard rejects alternate origins before native transport", async () => {
  let calls = 0;
  const guarded = createRedirectDenyingFetch(
    [decodeTrustedUpstreamOrigin("https://chatgpt.com")],
    async () => {
      calls += 1;
      return new Response("ok");
    },
  );
  await assert.rejects(
    guarded("https://attacker.invalid/exfiltrate"),
    (error: unknown) =>
      error instanceof SidecarFetchPolicyError &&
      error.reason === "unregistered-origin",
  );
  assert.equal(calls, 0);
  const response = await guarded("https://chatgpt.com/backend-api/codex");
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 1);
});

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { ApiClient, SendMessageReq } from "wechat-ilink-client";
import type { ChannelHealth } from "../channels/types.js";
import { WeChatAdapter, wechatReliabilityTestHooks } from "../channels/wechat.js";
import { MediaCache } from "../core/media-cache.js";

type InstrumentableAdapter = {
  instrumentSendMessage(api: ApiClient): void;
  updateHealth(health: ChannelHealth): void;
};

async function main(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-smoke/wechat-reliability");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  await verifyExpiredContextFallback(dataDir);
  verifyHealthTransitionRecovery(dataDir);
  await verifyCdnCancellation();

  process.stdout.write("WeChat reliability smoke ok\n");
}

async function verifyExpiredContextFallback(dataDir: string): Promise<void> {
  const adapter = createAdapter(dataDir) as unknown as InstrumentableAdapter;
  const requests: SendMessageReq[] = [];
  const api = {
    sendMessage: async () => undefined,
    apiFetch: async ({ body }: { body: string }) => {
      const request = JSON.parse(body) as SendMessageReq;
      requests.push(request);
      return requests.length === 1
        ? JSON.stringify({ ret: -2, errcode: 0, errmsg: "expired context" })
        : JSON.stringify({ ret: 0, errcode: 0 });
    },
    buildBaseInfo: () => ({ test: true }),
  } as unknown as ApiClient;

  adapter.instrumentSendMessage(api);
  await api.sendMessage({ msg: { context_token: "expired-token" } } as SendMessageReq);

  if (
    requests.length !== 2 ||
    requests[0]?.msg?.context_token !== "expired-token" ||
    requests[1]?.msg?.context_token !== ""
  ) {
    throw new Error(`ret=-2 did not retry once without the expired context token: ${JSON.stringify(requests)}`);
  }
}

function verifyHealthTransitionRecovery(dataDir: string): void {
  const channel = createAdapter(dataDir);
  const adapter = channel as unknown as InstrumentableAdapter;
  const transitions: Array<{ previousState: string; state: string }> = [];
  channel.setHealthReporter((transition) => {
    transitions.push({ previousState: transition.previousState, state: transition.health.state });
  });

  adapter.updateHealth({ state: "degraded", lastErrorAt: new Date().toISOString(), lastError: "poll failed" });
  adapter.updateHealth({ state: "degraded", lastErrorAt: new Date().toISOString(), lastError: "poll failed again" });
  adapter.updateHealth({ state: "healthy", lastSuccessAt: new Date().toISOString() });

  if (
    transitions.length !== 2 ||
    transitions[0]?.previousState !== "starting" ||
    transitions[0]?.state !== "degraded" ||
    transitions[1]?.previousState !== "degraded" ||
    transitions[1]?.state !== "healthy"
  ) {
    throw new Error(`Polling health transitions were not deduplicated through recovery: ${JSON.stringify(transitions)}`);
  }
}

async function verifyCdnCancellation(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;

  const controller = new AbortController();
  const upload = wechatReliabilityTestHooks.postCiphertextToCdn(
    "https://cdn.invalid/upload",
    Buffer.from("ciphertext"),
    controller.signal,
  );
  controller.abort(new Error("cancelled upload"));
  const message = await upload.then(
    () => "",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  globalThis.fetch = originalFetch;

  if (!message.includes("cancelled upload") || attempts !== 1) {
    throw new Error(`CDN cancellation was not prompt and retry-free: ${message}/${attempts}`);
  }
}

function createAdapter(dataDir: string): WeChatAdapter {
  return new WeChatAdapter({
    dataDir,
    mediaCache: new MediaCache(dataDir),
    allowedChatIds: ["smoke"],
    unsafeAllowAll: false,
    botType: "3",
    maxInboundBytes: 1024,
    sendTimeoutMs: 1_000,
    sendMinIntervalMs: 0,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

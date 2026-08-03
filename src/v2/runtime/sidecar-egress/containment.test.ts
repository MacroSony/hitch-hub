import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { scenarioCase } from "../../acceptance/runner.js";
import { decodeTrustedUpstreamOrigin } from "../../codecs/primitives.js";
import { PinnedSidecarEgressPolicy } from "./address-policy.js";
import {
  claimSidecarEgressLaunchForSpawn,
  consumeSidecarEgressLaunchAuthorization,
  listenPinnedConnectRelay,
  type EgressTunnelDialer,
} from "./connect-relay.js";
import type { SidecarProxyEnvironment } from "./proxy-environment.js";

const BUBBLEWRAP = "/usr/bin/bwrap";

scenarioCase({
  scenarioId: "V2-S15",
  caseId: "sidecar-egress-launch-contract",
  title: "sidecar launch contract requires an empty network namespace and authenticated relay mount",
  run: async () => {
    const fixture = await createRelayFixture();
    try {
      const specification = consumeSidecarEgressLaunchAuthorization(
        fixture.relay.prepareLaunchAuthorization(),
      );
      assert.deepEqual(specification.bubblewrapArguments, [
        "--unshare-net",
        "--ro-bind",
        fixture.directory,
        "/hitch-egress",
      ]);
      assert.equal(specification.expectedRelayIdentity.directory.mode, 0o700);
      assert.equal(specification.expectedRelayIdentity.socket.mode, 0o600);
      assert.deepEqual(Object.keys(specification.environment).sort(), [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "NODE_USE_ENV_PROXY",
      ]);
      claimSidecarEgressLaunchForSpawn(specification);
    } finally {
      await fixture.close();
    }
  },
});

const capabilitySkip =
  process.platform !== "linux"
    ? "requires Linux network namespaces"
    : !isExecutable(BUBBLEWRAP)
      ? "requires executable /usr/bin/bwrap"
      : false;

test(
  "Bubblewrap namespace cannot reach a controlled host listener but can reach the mounted relay",
  { skip: capabilitySkip },
  async () => {
    const hostServer = createServer((socket) => socket.end("host-network-reachable"));
    const hostPort = await listenTcp(hostServer);
    const fixture = await createRelayFixture();
    try {
      const specification = consumeSidecarEgressLaunchAuthorization(
        fixture.relay.prepareLaunchAuthorization(),
      );
      claimSidecarEgressLaunchForSpawn(specification);
      const nodeRoot = dirname(dirname(process.execPath));
      const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
      const childSource = String.raw`
        import fs from "node:fs";
        import net from "node:net";
        import { startSidecarLoopbackAdapter } from "./src/v2/runtime/sidecar-egress/loopback-adapter.ts";
        function directAttempt() {
          return new Promise((resolve) => {
            const socket = net.createConnection({ host: "127.0.0.1", port: ${hostPort} });
            const finish = (outcome) => { socket.destroy(); resolve(outcome); };
            socket.setTimeout(750, () => finish("blocked"));
            socket.once("connect", () => finish("connected"));
            socket.once("error", () => finish("blocked"));
          });
        }
        function relayAttempt() {
          return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: "127.0.0.1", port: 43817 });
            let response = "";
            socket.once("connect", () => socket.write(
              "CONNECT attacker.invalid:443 HTTP/1.1\r\nhost: attacker.invalid\r\n\r\n"
            ));
            socket.on("data", (chunk) => {
              response += chunk.toString("ascii");
              if (response.includes("\r\n\r\n")) socket.destroy();
            });
            socket.once("error", reject);
            socket.once("close", () => resolve(response));
          });
        }
        const route = fs.readFileSync("/proc/net/route", "utf8");
        const interfaces = fs.readFileSync("/proc/net/dev", "utf8")
          .split("\n").slice(2).map((line) => line.split(":")[0]?.trim()).filter(Boolean);
        const hasDefaultRoute = route.split("\n").slice(1).some((line) =>
          line.trim().split(/\s+/u)[1] === "00000000"
        );
        const adapter = await startSidecarLoopbackAdapter();
        try {
          const [direct, relay] = await Promise.all([directAttempt(), relayAttempt()]);
          process.stdout.write(JSON.stringify({ direct, relay, interfaces, hasDefaultRoute }));
        } finally {
          await adapter.close();
        }
      `;
      const result = await runChild(
        BUBBLEWRAP,
        [
          "--die-with-parent",
          "--new-session",
          "--unshare-user",
          "--disable-userns",
          "--unshare-pid",
          "--unshare-ipc",
          "--unshare-uts",
          ...specification.bubblewrapArguments,
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/tmp",
          "--ro-bind",
          "/usr",
          "/usr",
          "--ro-bind",
          "/bin",
          "/bin",
          "--ro-bind",
          "/lib",
          "/lib",
          "--ro-bind-try",
          "/lib64",
          "/lib64",
          "--ro-bind",
          nodeRoot,
          "/node",
          "--ro-bind",
          workspaceRoot,
          "/workspace",
          "--chdir",
          "/workspace",
          "--",
          "/node/bin/node",
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          childSource,
        ],
        specification.environment,
      );
      assert.equal(result.code, 0, result.stderr);
      const observation = JSON.parse(result.stdout) as {
        readonly direct: string;
        readonly relay: string;
        readonly interfaces: readonly string[];
        readonly hasDefaultRoute: boolean;
      };
      assert.equal(observation.direct, "blocked");
      assert.match(observation.relay, /^HTTP\/1\.1 403 Forbidden/u);
      assert.deepEqual(observation.interfaces, ["lo"]);
      assert.equal(observation.hasDefaultRoute, false);
    } finally {
      await fixture.close();
      await closeServer(hostServer);
    }
  },
);

async function createRelayFixture(): Promise<{
  readonly directory: string;
  readonly relay: Awaited<ReturnType<typeof listenPinnedConnectRelay>>;
  close(): Promise<void>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "hitch-v2-egress-namespace-"));
  chmodSync(directory, 0o700);
  const policy = await PinnedSidecarEgressPolicy.pin(
    [decodeTrustedUpstreamOrigin("https://provider.example")],
    async () => [{ address: "8.8.8.8", family: 4 }],
  );
  const neverDial: EgressTunnelDialer = {
    async dial() {
      throw new Error("unregistered authority unexpectedly reached the dialer");
    },
  };
  const relay = await listenPinnedConnectRelay({ directory, policy, dialer: neverDial });
  return {
    directory,
    relay,
    async close() {
      await relay.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listenTcp(server: Server): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test host server had no TCP address"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}

function runChild(
  command: string,
  args: readonly string[],
  environment: SidecarProxyEnvironment,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Bubblewrap capability probe exceeded 5 seconds")));
    }, 5_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => finish(() => resolvePromise({ code, stdout, stderr })));
  });
}

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HubConfig } from "../config/schema.js";
import type { AgentBackend, AgentEvent, AgentInput } from "../agents/types.js";
import type { AgentToolContext } from "../core/tool-bridge.js";
import type { ChannelAdapter, InboundChatEvent, OutboundArtifact, SendOptions } from "../channels/types.js";
import type { ChatTarget, HubAttachment, HubSession } from "../core/types.js";
import { MediaCache } from "../core/media-cache.js";
import { DeliveryStore } from "../core/delivery-store.js";
import { AuditLog } from "../core/audit-log.js";
import { RemoteAgentHub } from "../core/hub.js";
import { HubToolService } from "../core/hub-tools.js";
import { resolveSessionMediaPath } from "../core/tool-bridge.js";
import { executionPolicySchema } from "../security/policy.js";
import { SessionRuntimeStore } from "../security/session-runtime.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

class MediaFlowChannel implements ChannelAdapter {
  readonly artifacts: OutboundArtifact[] = [];
  readonly artifactBytes: Buffer[] = [];
  readonly texts: string[] = [];

  constructor(private readonly events: InboundChatEvent[]) {}

  async *receive(): AsyncIterable<InboundChatEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  async sendText(_target: ChatTarget, text: string, _opts?: SendOptions): Promise<void> {
    this.texts.push(text);
  }

  async sendArtifact(_target: ChatTarget, artifact: OutboundArtifact, _opts?: SendOptions): Promise<void> {
    this.artifactBytes.push(readFileSync(artifact.path));
    this.artifacts.push(artifact);
  }
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}

class MediaFlowBackend implements AgentBackend {
  readonly queue = new AsyncEventQueue<AgentEvent>();
  receivedInput: AgentInput | undefined;
  private finalTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly artifactPath: string) {}

  async start(_session: HubSession): Promise<number | undefined> {
    return process.pid;
  }

  async send(input: AgentInput): Promise<void> {
    this.receivedInput = input;
    this.queue.push({ type: "tool_call", name: "read_file", preview: `{"path":"${this.artifactPath}"}` });
    this.queue.push({
      type: "tool_result",
      name: "read_file",
      succeeded: true,
      text: `hidden tool output marker: ${this.artifactPath}`,
    });
    this.finalTimer = setTimeout(() => {
      this.finalTimer = undefined;
      this.queue.push({ type: "final", text: `Generated artifact: "${this.artifactPath}"` });
      this.queue.close();
    }, 100);
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield* this.queue.iterate();
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {
    if (this.finalTimer) {
      clearTimeout(this.finalTimer);
      this.finalTimer = undefined;
    }
    this.queue.close();
  }
}

class BridgeMediaBackend implements AgentBackend {
  readonly queue = new AsyncEventQueue<AgentEvent>();
  private toolContext: AgentToolContext | undefined;

  constructor(private readonly artifactPath: string) {}

  async start(_session: HubSession, toolContext?: AgentToolContext): Promise<number | undefined> {
    this.toolContext = toolContext;
    return process.pid;
  }

  async send(_input: AgentInput): Promise<void> {
    if (!this.toolContext) {
      throw new Error("Expected Hitch tool context.");
    }
    const requestId = "bridge-send-media";
    appendFileSync(
      this.toolContext.outboxPath,
      `${JSON.stringify({
        id: requestId,
        type: "send_media",
        token: this.toolContext.token,
        path: this.artifactPath,
        caption: "bridge caption",
        kind: "image",
      })}\n`,
      "utf8",
    );
    this.queue.push({ type: "final", text: "Bridge requested media send." });
    this.queue.close();
  }

  async *events(): AsyncIterable<AgentEvent> {
    yield* this.queue.iterate();
  }

  isAlive(): boolean {
    return true;
  }

  async abort(): Promise<void> {}

  async stop(): Promise<void> {
    this.queue.close();
  }
}

async function main(): Promise<void> {
  const summary = await runScenario(false);
  await runScenario(true);
  await runToolStatusBatchScenario();
  await runFailureOnlyToolStatusScenario();
  await runExplicitSendScenario();
  await runAutoDiscoveryDisabledScenario();
  await runToolBridgeScenario();
  await runToolBridgeIsolationScenario();
  runMountResolutionScenario();
  await runImmutableSnapshotScenario();
  await runStoppedMediaAuditScenario();
  process.stdout.write(`Media flow smoke ok: inbound=${summary.inbound} outbound=${summary.outbound}\n`);
}

async function runFailureOnlyToolStatusScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "failure-only-tools");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const artifactPath = path.join(dataDir, "quiet.png");
  writeFileSync(artifactPath, PNG_1X1);
  const target: ChatTarget = { platform: "fake", chatId: "failure-only-tools", userId: "media-user" };
  const channel = new MediaFlowChannel([
    { id: "new", target, text: "!new pi", receivedAt: new Date().toISOString() },
    { id: "prompt", target, text: "Keep successful tools quiet.", receivedAt: new Date().toISOString() },
  ]);
  const config = mediaFlowConfig(dataDir, false);
  config.delivery.tool_status_mode = "failures";
  const hub = new RemoteAgentHub(config, channel, () => new MediaFlowBackend(artifactPath));
  await hub.run();

  if (channel.texts.some((text) => text.startsWith("Tool started:") || text.startsWith("Tool finished:"))) {
    throw new Error(`Failure-only tool status mode leaked successful tool chatter: ${JSON.stringify(channel.texts)}`);
  }
  if (!channel.texts.some((text) => text.startsWith(`Generated artifact: "${artifactPath}"`))) {
    throw new Error("Failure-only tool status mode suppressed the final agent response.");
  }
}

async function runScenario(fullToolOutput: boolean): Promise<{ inbound: number; outbound: number }> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", fullToolOutput ? "full" : "summary");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const mediaCache = new MediaCache(dataDir);
  const image = mediaCache.storeInbound({
    source: "fake",
    kind: "image",
    data: PNG_1X1,
    filename: "pixel.png",
  });
  const file = mediaCache.storeInbound({
    source: "fake",
    kind: "file",
    data: Buffer.from("hello media", "utf8"),
    filename: "note.txt",
  });

  const artifactPath = path.join(dataDir, "outbound.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow",
    userId: "media-user",
  };
  const events: InboundChatEvent[] = [
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Inspect these attachments.",
      attachments: [image, file],
      receivedAt: new Date().toISOString(),
    },
  ];

  const config = mediaFlowConfig(dataDir, fullToolOutput);
  const channel = new MediaFlowChannel(events);
  const backend = new MediaFlowBackend(artifactPath);
  const hub = new RemoteAgentHub(config, channel, () => backend);
  await hub.run();

  assertAttachmentFlow(backend.receivedInput?.attachments);
  if (
    channel.artifacts.length !== 1 ||
    !channel.artifactBytes[0]?.equals(PNG_1X1) ||
    existsSync(channel.artifacts[0]?.path ?? "")
  ) {
    throw new Error(`Expected outbound artifact delivery for ${artifactPath}`);
  }
  const hasFullToolOutput = channel.texts.some((text) => text.includes("hidden tool output marker"));
  const hasToolPreview = channel.texts.some((text) => text.includes('{"path"'));
  if (!fullToolOutput && (hasFullToolOutput || hasToolPreview)) {
    throw new Error("Default delivery should hide tool preview args and full tool output");
  }
  if (fullToolOutput && (!hasFullToolOutput || !hasToolPreview)) {
    throw new Error("Full tool-output delivery should include preview args and result text when progress sends in time.");
  }
  if (
    !channel.texts.some((text) => text.startsWith(`Generated artifact: "${artifactPath}"`))
  ) {
    throw new Error("Authoritative final response was not delivered.");
  }

  return { inbound: backend.receivedInput.attachments.length, outbound: channel.artifacts.length };
}

async function runToolStatusBatchScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "batched-tools");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "batched.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-batched-tools",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Inspect this with batched tool statuses.",
      receivedAt: new Date().toISOString(),
    },
  ]);
  const config = mediaFlowConfig(dataDir, false, false, 60_000);
  const backend = new MediaFlowBackend(artifactPath);
  const hub = new RemoteAgentHub(config, channel, () => backend);
  await hub.run();

  const finalIndex = channel.texts.findIndex((text) => text.startsWith(`Generated artifact: "${artifactPath}"`));
  if (finalIndex === -1 || channel.texts.some((text) => text.startsWith("Tool started:") || text.startsWith("Tool finished:"))) {
    throw new Error(`Authoritative final did not supersede the pending tool-status batch: ${JSON.stringify(channel.texts)}`);
  }
}

async function runExplicitSendScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "send");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "explicit.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-send",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "send",
      target,
      text: `!send ${artifactPath} explicit caption`,
      receivedAt: new Date().toISOString(),
    },
    {
      id: "blocked-send",
      target,
      text: `!send ${path.resolve("package.json")}`,
      receivedAt: new Date().toISOString(),
    },
  ]);
  const hub = new RemoteAgentHub(mediaFlowConfig(dataDir, false, false), channel, () => new MediaFlowBackend(artifactPath));
  await hub.run();

  if (
    channel.artifacts.length !== 1 ||
    !channel.artifactBytes[0]?.equals(PNG_1X1) ||
    channel.artifacts[0]?.caption !== "explicit caption" ||
    existsSync(channel.artifacts[0]?.path ?? "")
  ) {
    throw new Error("Expected explicit !send to deliver exactly one outbound media artifact.");
  }
  if (!channel.texts.some((text) => text === "Media sent: explicit.png")) {
    throw new Error("Expected explicit !send success confirmation.");
  }
  if (!channel.texts.some((text) => text.startsWith("Media delivery failed: Media path is outside outbound roots"))) {
    throw new Error("Expected explicit !send to reject media outside outbound roots.");
  }
}

async function runAutoDiscoveryDisabledScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "auto-disabled");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(dataDir, "mentioned.png");
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-auto-disabled",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Generate an image.",
      receivedAt: new Date().toISOString(),
    },
  ]);
  const backend = new MediaFlowBackend(artifactPath);
  const hub = new RemoteAgentHub(mediaFlowConfig(dataDir, false, false), channel, () => backend);
  await hub.run();

  if (channel.artifacts.length !== 0) {
    throw new Error("Expected auto-discovery disabled config to avoid sending mentioned artifact paths.");
  }
}

async function runToolBridgeScenario(): Promise<void> {
  const dataDir = path.resolve("examples/.remote-agent-hub-media-flow", "bridge");
  rmSync(dataDir, { force: true, recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const artifactPath = path.join(path.dirname(dataDir), "bridge-workspace.png");
  rmSync(artifactPath, { force: true });
  writeFileSync(artifactPath, PNG_1X1);

  const target: ChatTarget = {
    platform: "fake",
    chatId: "media-flow-bridge",
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    {
      id: "new",
      target,
      text: "!new pi",
      receivedAt: new Date().toISOString(),
    },
    {
      id: "prompt",
      target,
      text: "Send this through the Hitch tool bridge.",
      receivedAt: new Date().toISOString(),
    },
  ]);
  const config = mediaFlowConfig(dataDir, false, false);
  config.outboundRoots.push(path.dirname(dataDir));
  config.media.outbound_roots.push(path.dirname(dataDir));
  const hub = new RemoteAgentHub(config, channel, () => new BridgeMediaBackend(artifactPath));
  await hub.run();

  if (
    channel.artifacts.length !== 1 ||
    !channel.artifactBytes[0]?.equals(PNG_1X1) ||
    channel.artifacts[0]?.caption !== "bridge caption" ||
    existsSync(channel.artifacts[0]?.path ?? "")
  ) {
    throw new Error("Expected tool bridge send_media request to deliver one outbound media artifact.");
  }
  const resultPath = findBridgeResultPath(dataDir);
  if (!resultPath || !existsSync(resultPath)) {
    throw new Error("Expected tool bridge to write a send_media result file.");
  }
  const toolResult = JSON.parse(readFileSync(resultPath, "utf8")) as { deliveryId?: string; status?: string };
  if (!toolResult.deliveryId || toolResult.status !== "sent") {
    throw new Error(`Expected a successful tool result with a delivery ID: ${JSON.stringify(toolResult)}`);
  }
  const store = new DeliveryStore(dataDir);
  const delivery = store.get(toolResult.deliveryId);
  store.close();
  if (
    delivery?.status !== "sent" ||
    delivery.kind !== "artifact" ||
    delivery.source !== "agent_tool" ||
    !delivery.sessionId ||
    !delivery.turnId
  ) {
    throw new Error(`Tool result did not correlate to one durable artifact delivery: ${JSON.stringify(delivery)}`);
  }
  const artifactAudit = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { type?: string; details?: { deliveryId?: string } })
    .find((row) => row.type === "artifact.delivery" && row.details?.deliveryId === toolResult.deliveryId);
  if (!artifactAudit) {
    throw new Error("Artifact audit and durable ledger did not share the tool result delivery ID.");
  }
  if (readFileSync(path.join(dataDir, "hub.sqlite")).includes(Buffer.from(artifactPath))) {
    throw new Error("Delivery ledger persisted an artifact path.");
  }
  rmSync(artifactPath, { force: true });
}

async function runToolBridgeIsolationScenario(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "hitch-media-mount-isolation-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    const sibling = path.join(tempRoot, "sibling");
    mkdirSync(workspace);
    mkdirSync(sibling);
    const siblingArtifact = path.join(sibling, "not-mounted.png");
    writeFileSync(siblingArtifact, PNG_1X1);
    const escapedLink = path.join(workspace, "escaped.png");
    symlinkSync(siblingArtifact, escapedLink);

    await assertBridgeMediaBlocked(tempRoot, workspace, siblingArtifact, "unmounted-sibling");
    await assertBridgeMediaBlocked(tempRoot, workspace, escapedLink, "symlink-escape");
    await assertBridgeMediaBlocked(tempRoot, workspace, "/agent-config/auth.json", "agent-config");
    const globallyBlocked = path.join(workspace, "mounted-but-not-outbound.png");
    writeFileSync(globallyBlocked, PNG_1X1);
    await assertBridgeMediaBlocked(
      tempRoot,
      workspace,
      globallyBlocked,
      "mounted-but-not-outbound",
      sibling,
      "outbound roots",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function assertBridgeMediaBlocked(
  tempRoot: string,
  workspace: string,
  requestedPath: string,
  scenario: string,
  globalOutboundRoot = tempRoot,
  expectedMessage = "active session mount",
): Promise<void> {
  const dataDir = path.join(tempRoot, `data-${scenario}`);
  mkdirSync(dataDir);
  const target: ChatTarget = {
    platform: "fake",
    chatId: `media-flow-bridge-${scenario}`,
    userId: "media-user",
  };
  const channel = new MediaFlowChannel([
    { id: "new", target, text: "!new pi", receivedAt: new Date().toISOString() },
    { id: "prompt", target, text: "Attempt a session-scoped media send.", receivedAt: new Date().toISOString() },
  ]);
  const config = mediaFlowConfig(dataDir, false, false);
  config.default_cwd = workspace;
  config.defaultCwd = workspace;
  config.allowedRoots = [tempRoot];
  config.principalRoots = { media: [tempRoot] };
  config.outboundRoots = [globalOutboundRoot];
  config.users.media!.allowed_roots = [tempRoot];
  config.media.outbound_roots = [globalOutboundRoot];
  const hub = new RemoteAgentHub(config, channel, () => new BridgeMediaBackend(requestedPath));
  await hub.run();

  if (channel.artifacts.length !== 0) {
    throw new Error(`Session bridge delivered media outside its attested mount (${scenario}).`);
  }
  const resultPath = findBridgeResultPath(dataDir);
  const result = resultPath
    ? JSON.parse(readFileSync(resultPath, "utf8")) as { status?: string; message?: string }
    : undefined;
  if (result?.status !== "failed" || !result.message?.includes(expectedMessage)) {
    throw new Error(`Session bridge did not fail closed for ${scenario}: ${JSON.stringify(result)}`);
  }
}

function runMountResolutionScenario(): void {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "hitch-media-mount-resolution-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    const policyDirectory = path.join(tempRoot, "policy-directory");
    const policyFile = path.join(tempRoot, "policy-file.png");
    mkdirSync(workspace);
    mkdirSync(policyDirectory);
    const workspaceFile = path.join(workspace, "workspace.png");
    const policyDirectoryFile = path.join(policyDirectory, "directory.png");
    writeFileSync(workspaceFile, PNG_1X1);
    writeFileSync(policyDirectoryFile, PNG_1X1);
    writeFileSync(policyFile, PNG_1X1);
    const dataDir = path.join(workspace, ".hitch-data");
    const runtime = new SessionRuntimeStore(dataDir);
    const security = runtime.materialize(
      "media",
      "mount-resolution",
      workspace,
      executionPolicySchema.parse({
        mounts: [
          { host_path: policyDirectory, sandbox_path: "/media-directory", mode: "rw" },
          { host_path: policyFile, sandbox_path: "/media-file.png", mode: "ro" },
        ],
      }),
      [tempRoot],
    );

    assertResolvedMediaPath(security.mountPlan, "workspace.png", workspaceFile, "relative workspace");
    assertResolvedMediaPath(security.mountPlan, "/workspace/workspace.png", workspaceFile, "absolute workspace");
    assertResolvedMediaPath(
      security.mountPlan,
      "/media-directory/directory.png",
      policyDirectoryFile,
      "policy directory",
    );
    assertResolvedMediaPath(security.mountPlan, "/media-file.png", policyFile, "exact policy file");
    assertResolutionRejected(security.mountPlan, "/media-file.png/child", "descends through a file mount");

    const maskedArtifact = path.join(dataDir, "media", "outbound", "masked.png");
    mkdirSync(path.dirname(maskedArtifact), { recursive: true });
    writeFileSync(maskedArtifact, PNG_1X1);
    const relativeDataDir = path.relative(workspace, dataDir).split(path.sep).join("/");
    assertResolutionRejected(
      security.mountPlan,
      `/workspace/${relativeDataDir}/media/outbound/masked.png`,
      "masked from the active session",
    );
    assertResolutionRejected(security.mountPlan, maskedArtifact, "masked from the active session");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runImmutableSnapshotScenario(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "hitch-media-snapshot-"));
  try {
    const dataDir = path.join(tempRoot, "data");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(dataDir);
    mkdirSync(workspace);
    const sourcePath = path.join(workspace, "mutable.png");
    const replacementPath = path.join(tempRoot, "replacement.txt");
    writeFileSync(sourcePath, PNG_1X1);
    writeFileSync(replacementPath, "replacement content must not be delivered");
    const config = mediaFlowConfig(dataDir, false, false);
    config.outboundRoots = [workspace];
    config.media.outbound_roots = [workspace];
    let deliveredBytes: Buffer | undefined;
    let snapshotPath: string | undefined;
    const channel = new MediaFlowChannel([]);
    const tools = new HubToolService(
      config,
      channel,
      new AuditLog(dataDir),
      async () => undefined,
      async (_target, artifact) => {
        snapshotPath = artifact.path;
        if ((statSync(artifact.path).mode & 0o777) !== 0o400) {
          throw new Error("Validated media snapshot was not read-only.");
        }
        rmSync(sourcePath);
        symlinkSync(replacementPath, sourcePath);
        deliveredBytes = readFileSync(artifact.path);
      },
    );
    const result = await tools.sendMedia(
      { platform: "fake", chatId: "snapshot", userId: "media-user" },
      { path: sourcePath, kind: "image" },
      { source: "agent_tool", requiredAllowedRoots: [workspace] },
    );
    if (
      result.status !== "sent" ||
      !deliveredBytes?.equals(PNG_1X1) ||
      !snapshotPath ||
      existsSync(snapshotPath)
    ) {
      throw new Error(`Media delivery did not use and clean an immutable snapshot: ${JSON.stringify(result)}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runStoppedMediaAuditScenario(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "hitch-media-stopped-audit-"));
  try {
    const dataDir = path.join(tempRoot, "data");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(dataDir);
    mkdirSync(workspace);
    const sourcePath = path.join(workspace, "stopped.png");
    writeFileSync(sourcePath, PNG_1X1);
    const config = mediaFlowConfig(dataDir, false, false);
    config.outboundRoots = [workspace];
    config.media.outbound_roots = [workspace];
    const audit = new AuditLog(dataDir);
    const tools = new HubToolService(
      config,
      new MediaFlowChannel([]),
      audit,
      async () => undefined,
      async () => {
        const error = new Error("Delivery stopped before its send attempt started");
        error.name = "DeliveryStoppedError";
        throw error;
      },
    );
    const result = await tools.sendMedia(
      { platform: "wechat", chatId: "stopped-audit", userId: "media-user" },
      { path: sourcePath, kind: "image" },
      { source: "agent_tool", requiredAllowedRoots: [workspace] },
    );
    await audit.drain();
    const auditRows = readFileSync(path.join(dataDir, "logs", "audit.jsonl"), "utf8");
    if (result.status !== "failed" || !auditRows.includes('"status":"expired"')) {
      throw new Error(`Stopped media durable/audit status mismatch: ${auditRows}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertResolvedMediaPath(
  mountPlan: HubSession["mountPlan"],
  requestedPath: string,
  expectedPath: string,
  scenario: string,
): void {
  const result = resolveSessionMediaPath(mountPlan, requestedPath);
  if (result.hostPath !== expectedPath) {
    throw new Error(`Media mount resolution failed for ${scenario}: ${JSON.stringify(result)}`);
  }
}

function assertResolutionRejected(
  mountPlan: HubSession["mountPlan"],
  requestedPath: string,
  expectedMessage: string,
): void {
  try {
    resolveSessionMediaPath(mountPlan, requestedPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }
  throw new Error(`Media mount resolution accepted ${requestedPath}; expected ${expectedMessage}.`);
}

function findBridgeResultPath(dataDir: string): string | undefined {
  const stateRoot = path.join(dataDir, "session-state");
  if (!existsSync(stateRoot)) {
    return undefined;
  }
  const pending = [stateRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name === "bridge-send-media.json" && path.basename(path.dirname(entryPath)) === "results") {
        return entryPath;
      }
    }
  }
  return undefined;
}

function mediaFlowConfig(dataDir: string, fullToolOutput: boolean, autoDiscovery = true, toolStatusBatchMs = 0): HubConfig {
  const cwd = path.resolve(".");
  return {
    data_dir: dataDir,
    dataDir,
    default_cwd: cwd,
    defaultCwd: cwd,
    agent_turn_timeout_ms: 20_000,
    worker_idle_timeout_ms: 30 * 60 * 1000,
    approval_timeout_ms: 20_000,
    media: {
      max_inbound_bytes: 20 * 1024 * 1024,
      max_outbound_bytes: 50 * 1024 * 1024,
      auto_discovery: autoDiscovery,
      outbound_roots: [dataDir],
    },
    delivery: {
      full_tool_output: fullToolOutput,
      tool_status_mode: "all",
      tool_status_batch_ms: toolStatusBatchMs,
      checkpoint_batch_ms: 0,
      checkpoint_max_wait_ms: 0,
      checkpoint_max_digests_per_turn: 3,
      checkpoint_max_chars: 1_000,
      send_timeout_ms: 5_000,
      queue_ttl_ms: 5 * 60 * 1000,
      retention_ms: 30 * 24 * 60 * 60 * 1000,
    },
    audit: { max_bytes: 10 * 1024 * 1024, max_files: 5 },
    allowedRoots: [cwd, dataDir],
    principalRoots: { media: [cwd, dataDir] },
    outboundRoots: [dataDir],
    users: {
      media: {
        telegram_ids: [],
        wechat_ids: [],
        allowed_roots: [cwd, dataDir],
      },
    },
    channels: {
      fake: { enabled: true },
      telegram: {
        enabled: false,
        bot_token_env: "TELEGRAM_BOT_TOKEN",
        allowed_chat_ids: [],
        unsafe_allow_all: false,
      },
      wechat: {
        enabled: false,
        allowed_chat_ids: [],
        bot_type: "3",
        send_min_interval_ms: 4_000,
        failure_cooldown_ms: 60_000,
        unsafe_allow_all: false,
      },
    },
    agents: {
      pi: {
        command: "pi",
        default_args: ["--mode", "rpc"],
        default_policy: "ask",
        config_scope: "hitch",
        credential_isolation: "disabled",
      },
    },
  };
}

function assertAttachmentFlow(attachments: HubAttachment[] | undefined): asserts attachments is HubAttachment[] {
  if (!attachments || attachments.length !== 2) {
    throw new Error(`Expected two inbound attachments, got ${attachments?.length ?? 0}`);
  }
  if (attachments[0]?.kind !== "image" || attachments[0].mimeType !== "image/png") {
    throw new Error("Expected first attachment to be a sniffed PNG image");
  }
  if (attachments[1]?.kind !== "file" || attachments[1].mimeType !== "text/plain") {
    throw new Error("Expected second attachment to be a sniffed text file");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

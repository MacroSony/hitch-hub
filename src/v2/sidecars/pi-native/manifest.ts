import { digestCanonicalJson } from "../../codecs/json.js";
import { codecFail, type CodecPath } from "../../codecs/errors.js";
import {
  decodeAgentImageMimeType,
  decodeBoundedArray,
  decodeBoundedString,
  decodeIntegrityDigest,
  decodePositiveSafeInteger,
  decodeServiceId,
  decodeTrustedUpstreamOrigin,
} from "../../codecs/primitives.js";
import {
  at,
  decodeBoolean,
  decodeEnum,
  decodeLiteral,
  decodePlainObject,
  requireExactFields,
} from "../../codecs/structure.js";
import type {
  BootstrapPublicationArtifactBindings,
} from "../../model/application.js";
import type {
  IntegrityDigest,
  JsonObject,
  ProviderConnectionId,
  TrustedUpstreamOrigin,
} from "../../model/primitives.js";
import type {
  ProviderConnectionSpec,
  ProviderModelManifest,
} from "../../model/provider-broker.js";
import {
  PI_NATIVE_BRIDGE_COMPATIBILITY,
  PI_NATIVE_BRIDGE_ID,
  PI_NATIVE_BRIDGE_PROTOCOL_VERSION,
} from "../../bridges/pi-native/frames.js";
import {
  generatePiNativeBridgeExtension,
  type GeneratedPiNativeBridgeExtension,
} from "../../bridges/pi-native/extension-generator.js";
import { decodeProviderConnectionSpec } from "../../bootstrap/records.js";

export const PI_NATIVE_SIDECAR_MANIFEST_VERSION = 1 as const;

export interface PiNativeCatalogModel {
  readonly providerId: string;
  readonly id: string;
  readonly displayName: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly tokenEstimatorId: string;
  readonly imageInput: ProviderModelManifest["imageInput"];
  readonly tools: ProviderModelManifest["tools"];
  readonly reasoningPolicy: ProviderModelManifest["reasoning"];
  readonly nativeModelMetadata: Readonly<JsonObject>;
  readonly integrityDigest: IntegrityDigest;
}

export interface PiNativeSidecarManifest {
  readonly manifestVersion: 1;
  readonly packages: {
    readonly piCodingAgent: {
      readonly name: "@earendil-works/pi-coding-agent";
      readonly version: "0.82.0";
    };
    readonly piAi: {
      readonly name: "@earendil-works/pi-ai";
      readonly version: "0.82.0";
    };
  };
  readonly nativeStackDigest: IntegrityDigest;
  readonly bridge: {
    readonly id: "pi-native-sidecar-v1";
    readonly protocolVersion: 1;
    readonly artifactDigest: IntegrityDigest;
    readonly semanticManifestDigest: IntegrityDigest;
  };
  readonly connection: {
    readonly id: ProviderConnectionId;
    readonly allowedOrigins: readonly [
      TrustedUpstreamOrigin,
      ...TrustedUpstreamOrigin[],
    ];
  };
  readonly catalog: {
    readonly digest: IntegrityDigest;
    readonly discovery: "disabled";
    readonly model: PiNativeCatalogModel;
  };
  readonly credentialStore: {
    readonly resolverId: string;
    readonly providerId: string;
  };
  readonly invocation: {
    readonly maxRetries: 0;
    readonly transport: "sse";
  };
}

const SAFE_REFERENCE = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/u;

export function decodePiNativeSidecarManifest(
  input: unknown,
  path: CodecPath = [],
): PiNativeSidecarManifest {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    [
      "manifestVersion",
      "packages",
      "nativeStackDigest",
      "bridge",
      "connection",
      "catalog",
      "credentialStore",
      "invocation",
    ],
    [],
    path,
  );
  const packages = decodePlainObject(object.packages, at(path, "packages"));
  requireExactFields(packages, ["piCodingAgent", "piAi"], [], at(path, "packages"));
  const codingAgent = decodePackage(
    packages.piCodingAgent,
    "@earendil-works/pi-coding-agent",
    at(at(path, "packages"), "piCodingAgent"),
  );
  const piAi = decodePackage(
    packages.piAi,
    "@earendil-works/pi-ai",
    at(at(path, "packages"), "piAi"),
  );
  const bridge = decodePlainObject(object.bridge, at(path, "bridge"));
  requireExactFields(
    bridge,
    ["id", "protocolVersion", "artifactDigest", "semanticManifestDigest"],
    [],
    at(path, "bridge"),
  );
  const connection = decodePlainObject(object.connection, at(path, "connection"));
  requireExactFields(connection, ["id", "allowedOrigins"], [], at(path, "connection"));
  const catalog = decodePlainObject(object.catalog, at(path, "catalog"));
  requireExactFields(catalog, ["digest", "discovery", "model"], [], at(path, "catalog"));
  const credentialStore = decodePlainObject(
    object.credentialStore,
    at(path, "credentialStore"),
  );
  requireExactFields(
    credentialStore,
    ["resolverId", "providerId"],
    [],
    at(path, "credentialStore"),
  );
  const invocation = decodePlainObject(object.invocation, at(path, "invocation"));
  requireExactFields(invocation, ["maxRetries", "transport"], [], at(path, "invocation"));
  if (invocation.maxRetries !== 0) {
    codecFail(at(at(path, "invocation"), "maxRetries"), "invalid-format", "Pi native retries must be disabled");
  }
  if (object.manifestVersion !== PI_NATIVE_SIDECAR_MANIFEST_VERSION) {
    codecFail(at(path, "manifestVersion"), "invalid-format", "expected Pi sidecar manifest version 1");
  }
  if (bridge.protocolVersion !== PI_NATIVE_BRIDGE_PROTOCOL_VERSION) {
    codecFail(at(at(path, "bridge"), "protocolVersion"), "invalid-format", "expected Pi bridge protocol version 1");
  }
  const nativeStackDigest = decodeIntegrityDigest(
    object.nativeStackDigest,
    at(path, "nativeStackDigest"),
  );
  const allowedOrigins = decodeBoundedArray(
    connection.allowedOrigins,
    decodeTrustedUpstreamOrigin,
    { minimumItems: 1, maximumItems: 8, uniqueBy: String },
    at(at(path, "connection"), "allowedOrigins"),
  ) as [TrustedUpstreamOrigin, ...TrustedUpstreamOrigin[]];
  const model = decodeCatalogModel(catalog.model, at(at(path, "catalog"), "model"));
  const decoded: PiNativeSidecarManifest = {
    manifestVersion: PI_NATIVE_SIDECAR_MANIFEST_VERSION,
    packages: { piCodingAgent: codingAgent, piAi },
    nativeStackDigest,
    bridge: {
      id: decodeLiteral(bridge.id, PI_NATIVE_BRIDGE_ID, at(at(path, "bridge"), "id")),
      protocolVersion: PI_NATIVE_BRIDGE_PROTOCOL_VERSION,
      artifactDigest: decodeIntegrityDigest(
        bridge.artifactDigest,
        at(at(path, "bridge"), "artifactDigest"),
      ),
      semanticManifestDigest: decodeIntegrityDigest(
        bridge.semanticManifestDigest,
        at(at(path, "bridge"), "semanticManifestDigest"),
      ),
    },
    connection: {
      id: decodeServiceId(
        "ProviderConnection",
        connection.id,
        at(at(path, "connection"), "id"),
      ),
      allowedOrigins,
    },
    catalog: {
      digest: decodeIntegrityDigest(catalog.digest, at(at(path, "catalog"), "digest")),
      discovery: decodeLiteral(
        catalog.discovery,
        "disabled",
        at(at(path, "catalog"), "discovery"),
      ),
      model,
    },
    credentialStore: {
      resolverId: decodeReference(
        credentialStore.resolverId,
        at(at(path, "credentialStore"), "resolverId"),
        "credential resolver ID",
      ),
      providerId: decodeReference(
        credentialStore.providerId,
        at(at(path, "credentialStore"), "providerId"),
        "provider ID",
      ),
    },
    invocation: {
      maxRetries: 0,
      transport: decodeLiteral(
        invocation.transport,
        "sse",
        at(at(path, "invocation"), "transport"),
      ),
    },
  };
  const expectedCatalogDigest = calculatePiNativeCatalogDigest(decoded);
  if (decoded.catalog.digest !== expectedCatalogDigest) {
    codecFail(at(at(path, "catalog"), "digest"), "invalid-format", "Pi native catalog digest drift");
  }
  if (decoded.catalog.model.integrityDigest !== calculatePiNativeModelDigest(decoded.catalog.model)) {
    codecFail(
      at(at(at(path, "catalog"), "model"), "integrityDigest"),
      "invalid-format",
      "Pi native model integrity digest drift",
    );
  }
  if (decoded.credentialStore.providerId !== decoded.catalog.model.providerId) {
    codecFail(
      at(at(path, "credentialStore"), "providerId"),
      "invalid-format",
      "credential provider must equal the frozen catalog provider",
    );
  }
  return deepFreeze(decoded);
}

export function assemblePiNativeSidecarManifest(input: {
  readonly connection: ProviderConnectionSpec;
  readonly artifacts: BootstrapPublicationArtifactBindings["provider"];
  readonly extension: GeneratedPiNativeBridgeExtension;
}): PiNativeSidecarManifest {
  const connection = decodeProviderConnectionSpec(input.connection);
  const { artifacts, extension } = input;
  const reviewedExtension = generatePiNativeBridgeExtension(
    extension.semanticManifest,
  );
  let extensionBytes: Uint8Array;
  try {
    extensionBytes = extension.sourceUtf8();
  } catch {
    throw new Error("Pi sidecar bridge extension could not reproduce its artifact bytes");
  }
  if (
    extension.fileName !== reviewedExtension.fileName ||
    extension.semanticManifestDigest !== reviewedExtension.semanticManifestDigest ||
    extension.source !== reviewedExtension.source ||
    extension.artifactDigest !== reviewedExtension.artifactDigest ||
    !sameBytes(extensionBytes, reviewedExtension.sourceUtf8())
  ) {
    throw new Error("Pi sidecar bridge extension is not the reviewed generated artifact");
  }
  if (
    connection.transport.mode !== "native-library-sidecar" ||
    connection.transport.nativeStack !== "pi-ai" ||
    connection.transport.nativeStackVersion !== "0.82.0" ||
    connection.transport.bridgeId !== PI_NATIVE_BRIDGE_ID ||
    connection.transport.bridgeProtocolVersion !== PI_NATIVE_BRIDGE_PROTOCOL_VERSION ||
    connection.transport.nativeRetries !== "disabled" ||
    connection.transport.invocation !== "structured-native-request" ||
    connection.models.length !== 1
  ) {
    throw new Error("provider connection is not the reviewed Pi 0.82.0 native sidecar shape");
  }
  const semantic = reviewedExtension.semanticManifest;
  const model = connection.models[0]!;
  if (
    artifacts.providerConnectionId !== connection.id ||
    artifacts.bridgeId !== connection.transport.bridgeId ||
    artifacts.bridgeArtifactDigest !== reviewedExtension.artifactDigest ||
    artifacts.nativeStack !== connection.transport.nativeStack ||
    artifacts.nativeStackVersion !== connection.transport.nativeStackVersion ||
    artifacts.nativeCatalogDigest !== connection.transport.nativeCatalogDigest ||
    semantic.compatibility.nativeStackDigest !== artifacts.nativeStackDigest ||
    semantic.nativeCatalogDigest !== artifacts.nativeCatalogDigest ||
    semantic.provider.id !== connection.providerId ||
    semantic.provider.id !== model.providerId ||
    semantic.provider.model.id !== model.modelId ||
    semantic.provider.model.api !== model.apiProtocolId ||
    semantic.provider.model.contextWindowTokens !== model.contextWindowTokens ||
    semantic.provider.model.maximumOutputTokens !== model.maximumOutputTokens ||
    semantic.provider.model.reasoning !== (model.reasoning.kind !== "unsupported") ||
    !sameStrings(
      semantic.provider.model.input,
      model.imageInput.kind === "supported" ? ["text", "image"] : ["text"],
    )
  ) {
    throw new Error("Pi sidecar artifact, catalog, connection, or model binding drift");
  }
  return decodePiNativeSidecarManifest({
    manifestVersion: 1,
    packages: {
      piCodingAgent: {
        name: "@earendil-works/pi-coding-agent",
        version: "0.82.0",
      },
      piAi: { name: "@earendil-works/pi-ai", version: "0.82.0" },
    },
    nativeStackDigest: artifacts.nativeStackDigest,
    bridge: {
      id: connection.transport.bridgeId,
      protocolVersion: connection.transport.bridgeProtocolVersion,
      artifactDigest: reviewedExtension.artifactDigest,
      semanticManifestDigest: reviewedExtension.semanticManifestDigest,
    },
    connection: {
      id: connection.id,
      allowedOrigins: connection.allowedUpstreamOrigins,
    },
    catalog: {
      digest: connection.transport.nativeCatalogDigest,
      discovery: "disabled",
      model: {
        providerId: semantic.provider.id,
        id: semantic.provider.model.id,
        displayName: semantic.provider.model.displayName,
        api: semantic.provider.model.api,
        reasoning: semantic.provider.model.reasoning,
        input: semantic.provider.model.input,
        contextWindowTokens: semantic.provider.model.contextWindowTokens,
        maximumOutputTokens: semantic.provider.model.maximumOutputTokens,
        tokenEstimatorId: model.tokenEstimatorId,
        imageInput: model.imageInput,
        tools: model.tools,
        reasoningPolicy: model.reasoning,
        nativeModelMetadata: model.nativeModelMetadata,
        integrityDigest: model.integrityDigest,
      },
    },
    credentialStore: {
      resolverId: connection.transport.credentialResolverId,
      providerId: semantic.provider.id,
    },
    invocation: { maxRetries: 0, transport: "sse" },
  });
}

export function calculatePiNativeCatalogDigest(
  manifest: Pick<
    PiNativeSidecarManifest,
    "packages" | "nativeStackDigest" | "connection" | "catalog"
  >,
): IntegrityDigest {
  const model = manifest.catalog.model;
  return digestCanonicalJson({
    piVersion: manifest.packages.piCodingAgent.version,
    nativeStackDigest: manifest.nativeStackDigest,
    connectionId: manifest.connection.id,
    allowedOrigins: manifest.connection.allowedOrigins,
    modelIntegrityDigest: model.integrityDigest,
    model: {
      id: model.id,
      name: model.displayName,
      api: model.api,
      provider: model.providerId,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindowTokens,
      maxTokens: model.maximumOutputTokens,
    },
  });
}

export function calculatePiNativeModelDigest(
  model: PiNativeCatalogModel,
): IntegrityDigest {
  return digestCanonicalJson({
    providerId: model.providerId,
    id: model.id,
    apiProtocol: model.api,
    contextWindowTokens: model.contextWindowTokens,
    maximumOutputTokens: model.maximumOutputTokens,
    tokenEstimatorId: model.tokenEstimatorId,
    imageInput: model.imageInput,
    tools: model.tools,
    reasoning: model.reasoningPolicy,
    nativeModelMetadata: model.nativeModelMetadata,
  });
}

function decodePackage<Name extends "@earendil-works/pi-coding-agent" | "@earendil-works/pi-ai">(
  input: unknown,
  name: Name,
  path: CodecPath,
): { readonly name: Name; readonly version: "0.82.0" } {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["name", "version"], [], path);
  return {
    name: decodeLiteral(object.name, name, at(path, "name")),
    version: decodeLiteral(object.version, "0.82.0", at(path, "version")),
  };
}

function decodeCatalogModel(input: unknown, path: CodecPath): PiNativeCatalogModel {
  const object = decodePlainObject(input, path);
  requireExactFields(
    object,
    [
      "providerId",
      "id",
      "displayName",
      "api",
      "reasoning",
      "input",
      "contextWindowTokens",
      "maximumOutputTokens",
      "tokenEstimatorId",
      "imageInput",
      "tools",
      "reasoningPolicy",
      "nativeModelMetadata",
      "integrityDigest",
    ],
    [],
    path,
  );
  const contextWindowTokens = decodePositiveSafeInteger(
    object.contextWindowTokens,
    at(path, "contextWindowTokens"),
  );
  const maximumOutputTokens = decodePositiveSafeInteger(
    object.maximumOutputTokens,
    at(path, "maximumOutputTokens"),
  );
  if (maximumOutputTokens > contextWindowTokens) {
    codecFail(at(path, "maximumOutputTokens"), "out-of-range", "native output limit exceeds context window");
  }
  const inputKinds = decodeBoundedArray(
    object.input,
    (value, itemPath) => decodeEnum(value, ["text", "image"] as const, itemPath),
    { minimumItems: 1, maximumItems: 2, uniqueBy: String },
    at(path, "input"),
  );
  if (!inputKinds.includes("text")) {
    codecFail(at(path, "input"), "invalid-format", "Pi native catalog requires text input");
  }
  const imageInput = decodeImagePolicy(object.imageInput, at(path, "imageInput"));
  if (inputKinds.includes("image") !== (imageInput.kind === "supported")) {
    codecFail(at(path, "input"), "invalid-format", "native image catalog and connection policy disagree");
  }
  const reasoning = decodeBoolean(object.reasoning, at(path, "reasoning"));
  const reasoningPolicy = decodeReasoningPolicy(
    object.reasoningPolicy,
    at(path, "reasoningPolicy"),
  );
  if (reasoning !== (reasoningPolicy.kind !== "unsupported")) {
    codecFail(at(path, "reasoning"), "invalid-format", "native reasoning catalog and connection policy disagree");
  }
  return {
    providerId: decodeReference(object.providerId, at(path, "providerId"), "provider ID"),
    id: decodeReference(object.id, at(path, "id"), "model ID"),
    displayName: decodeDisplayName(object.displayName, at(path, "displayName")),
    api: decodeReference(object.api, at(path, "api"), "Pi API"),
    reasoning,
    input: inputKinds,
    contextWindowTokens,
    maximumOutputTokens,
    tokenEstimatorId: decodeReference(
      object.tokenEstimatorId,
      at(path, "tokenEstimatorId"),
      "token estimator ID",
    ),
    imageInput,
    tools: decodeEnum(object.tools, ["unsupported", "supported"] as const, at(path, "tools")),
    reasoningPolicy,
    nativeModelMetadata: decodeNativeModelMetadata(
      object.nativeModelMetadata,
      decodeReference(object.api, at(path, "api"), "Pi API"),
      at(path, "nativeModelMetadata"),
    ),
    integrityDigest: decodeIntegrityDigest(
      object.integrityDigest,
      at(path, "integrityDigest"),
    ),
  };
}

function decodeImagePolicy(input: unknown, path: CodecPath): ProviderModelManifest["imageInput"] {
  const object = decodePlainObject(input, path);
  if (object.kind === "unsupported") {
    requireExactFields(object, ["kind"], [], path);
    return { kind: "unsupported" };
  }
  requireExactFields(
    object,
    [
      "kind",
      "acceptedMimeTypes",
      "maximumImagesPerRequest",
      "maximumImageBytesEach",
      "maximumTotalImageBytesPerRequest",
    ],
    [],
    path,
  );
  const maximumImageBytesEach = decodePositiveSafeInteger(
    object.maximumImageBytesEach,
    at(path, "maximumImageBytesEach"),
  );
  const maximumTotalImageBytesPerRequest = decodePositiveSafeInteger(
    object.maximumTotalImageBytesPerRequest,
    at(path, "maximumTotalImageBytesPerRequest"),
  );
  if (maximumTotalImageBytesPerRequest < maximumImageBytesEach) {
    codecFail(
      at(path, "maximumTotalImageBytesPerRequest"),
      "out-of-range",
      "total native image limit must cover at least one image",
    );
  }
  return {
    kind: decodeLiteral(object.kind, "supported", at(path, "kind")),
    acceptedMimeTypes: decodeBoundedArray(
      object.acceptedMimeTypes,
      decodeAgentImageMimeType,
      { minimumItems: 1, maximumItems: 4, uniqueBy: String },
      at(path, "acceptedMimeTypes"),
    ) as [
      ReturnType<typeof decodeAgentImageMimeType>,
      ...ReturnType<typeof decodeAgentImageMimeType>[],
    ],
    maximumImagesPerRequest: decodePositiveSafeInteger(
      object.maximumImagesPerRequest,
      at(path, "maximumImagesPerRequest"),
    ),
    maximumImageBytesEach,
    maximumTotalImageBytesPerRequest,
  };
}

function decodeNativeModelMetadata(
  input: unknown,
  expectedApi: string,
  path: CodecPath,
): JsonObject {
  const object = decodePlainObject(input, path);
  requireExactFields(object, ["transport", "streaming"], [], path);
  const transport = decodeReference(
    object.transport,
    at(path, "transport"),
    "Pi native transport",
  );
  if (transport !== expectedApi) {
    codecFail(
      at(path, "transport"),
      "invalid-format",
      "Pi native transport must equal the frozen model API",
    );
  }
  return {
    transport,
    streaming: decodeLiteral(object.streaming, "sse", at(path, "streaming")),
  };
}

function decodeReasoningPolicy(
  input: unknown,
  path: CodecPath,
): ProviderModelManifest["reasoning"] {
  const object = decodePlainObject(input, path);
  if (object.kind === "unsupported") {
    requireExactFields(object, ["kind"], [], path);
    return { kind: "unsupported" };
  }
  requireExactFields(
    object,
    ["kind", "supportedEfforts", "agentDefaultSupported"],
    [],
    path,
  );
  return {
    kind: decodeLiteral(object.kind, "portable-efforts", at(path, "kind")),
    supportedEfforts: decodeBoundedArray(
      object.supportedEfforts,
      (value, itemPath) =>
        decodeEnum(value, ["none", "low", "medium", "high"] as const, itemPath),
      { minimumItems: 1, maximumItems: 4, uniqueBy: String },
      at(path, "supportedEfforts"),
    ) as ["none" | "low" | "medium" | "high", ...("none" | "low" | "medium" | "high")[]],
    agentDefaultSupported: decodeBoolean(
      object.agentDefaultSupported,
      at(path, "agentDefaultSupported"),
    ),
  };
}

function decodeReference(input: unknown, path: CodecPath, label: string): string {
  return decodeBoundedString(
    input,
    { minimumLength: 1, maximumLength: 128, pattern: SAFE_REFERENCE, label },
    path,
  );
}

function decodeDisplayName(input: unknown, path: CodecPath): string {
  const value = decodeBoundedString(
    input,
    { minimumLength: 1, maximumLength: 120, label: "native model display name" },
    path,
  );
  if (/[/\\\u0000-\u001f\u007f]/u.test(value)) {
    codecFail(path, "invalid-format", "native model display name contains unsafe characters");
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

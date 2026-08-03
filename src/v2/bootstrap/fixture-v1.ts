import { digestCanonicalJson } from "../codecs/json.js";

/**
 * The installation publication for the deliberately narrow first v2 slice.
 *
 * This is an input document, not a host configuration file: it deliberately
 * contains neither a canonical host path nor credentials, commands, headers,
 * nor environment values. The supervisor supplies the trusted canonical
 * workspace binding before admission and the control plane resolves the named
 * credential binding.
 */

export const FIRST_SLICE_NUMERIC_DEFAULTS_V1 = Object.freeze({
  turnPolicy: Object.freeze({
    maxQueuedTurns: 3,
    initialActiveWorkMs: 900_000,
    toolExtensionMs: 300_000,
    maximumActiveWorkMs: 3_600_000,
    interactionWaitMs: 600_000,
    maximumBeforeAcceptanceAttempts: 1,
    maximumProviderRequests: 4,
    maximumTotalTokens: 100_000,
    maximumOutputTokensPerRequest: 16_384,
    checkpointIntervalMs: 5_000,
    maximumCheckpointCharacters: 4_000,
  }),
  executionPolicyLimits: Object.freeze({
    memoryBytes: 2_147_483_648,
    maxProcesses: 32,
    temporaryStorageBytes: 1_073_741_824,
    outputBytes: 1_048_576,
  }),
  installationHardCeilings: Object.freeze({
    maximumQueuedTurnsPerSession: 3,
    maximumActiveWorkMs: 3_600_000,
    maximumInteractionWaitMs: 600_000,
    maximumBeforeAcceptanceAttempts: 1,
    maximumProviderRequestsPerTurn: 4,
    maximumTotalInferenceTokensPerTurn: 100_000,
    maximumOutputTokensPerInferenceRequest: 16_384,
    maximumImageBytesPerAttachment: 10_485_760,
    maximumBrokerRequestBytes: 1_048_576,
    maximumConcurrentBrokerRequests: 1,
    maximumMemoryBytes: 2_147_483_648,
    maximumProcesses: 32,
    maximumTemporaryStorageBytes: 1_073_741_824,
    maximumAgentOutputBytes: 1_048_576,
  }),
});

/**
 * Digest coverage is explicit so a future publisher can recompute it from the
 * canonical secret-free value instead of treating a digest as a magic label.
 * The Pi stack and bridge values are the immutable V2 spike artifacts.
 */
export const FIRST_SLICE_DIGEST_COVERAGE_V1 = Object.freeze({
  nativeStack: "Pi 0.82.0 package tree recorded by the native-sidecar spike",
  bridgeArtifact: "reviewed pi-native-sidecar bridge artifact",
  catalog: "canonical JSON: piVersion, nativeStackDigest, connectionId, allowedOrigins, model integrity digest, public native model",
  model: "canonical JSON: provider/model identity, API, capacities, tools, reasoning, secret-free native metadata",
  connection: "canonical JSON: provider connection, transport, selected model, allowed origins, credential binding reference",
});

const MODEL_MANIFEST_COVERAGE_V1 = Object.freeze({
  providerId: "openai-codex",
  id: "gpt-5.4-mini",
  apiProtocol: "openai-codex-responses",
  contextWindowTokens: 272_000,
  maximumOutputTokens: 128_000,
  tokenEstimatorId: "pi-native-openai-codex-estimator-v1",
  imageInput: Object.freeze({
    kind: "supported",
    acceptedMimeTypes: Object.freeze(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    maximumImagesPerRequest: 1,
    maximumImageBytesEach: 10_485_760,
    maximumTotalImageBytesPerRequest: 10_485_760,
  }),
  tools: "supported",
  reasoning: Object.freeze({
    kind: "portable-efforts",
    supportedEfforts: Object.freeze(["none", "low", "medium", "high"]),
    agentDefaultSupported: true,
  }),
  nativeModelMetadata: Object.freeze({ transport: "openai-codex-responses", streaming: "sse" }),
});

const MODEL_MANIFEST_DIGEST_V1 = digestCanonicalJson(MODEL_MANIFEST_COVERAGE_V1);
const NATIVE_STACK_DIGEST_V1 = "sha256:feec8a6356a52ef9a5ace0a53390e35b68ad20183e5f7a4a86cf6b25d9849376";
const BRIDGE_ARTIFACT_DIGEST_V1 = "sha256:17d83f43fb8a571ab2d3fe36732c8ae784ffedab9fe811c51435a5985785a1cf";
const ALLOWED_ORIGINS_V1 = Object.freeze(["https://chatgpt.com", "https://auth.openai.com"]);
const PI_NATIVE_CATALOG_MODEL_V1 = Object.freeze({
  id: "gpt-5.4-mini",
  name: "GPT-5.4 mini",
  api: "openai-codex-responses",
  provider: "openai-codex",
  reasoning: true,
  input: Object.freeze(["text", "image"]),
  contextWindow: 272_000,
  maxTokens: 128_000,
});
const NATIVE_CATALOG_DIGEST_V1 = digestCanonicalJson({
  piVersion: "0.82.0",
  nativeStackDigest: NATIVE_STACK_DIGEST_V1,
  connectionId: "pi-native-openai-codex-v1",
  allowedOrigins: ALLOWED_ORIGINS_V1,
  modelIntegrityDigest: MODEL_MANIFEST_DIGEST_V1,
  model: PI_NATIVE_CATALOG_MODEL_V1,
});
const NATIVE_LIBRARY_TRANSPORT_V1 = Object.freeze({
  mode: "native-library-sidecar",
  credentialCustody: "hitch-control-plane",
  bridgeId: "pi-native-sidecar-v1",
  bridgeArtifactDigest: BRIDGE_ARTIFACT_DIGEST_V1,
  nativeStack: "pi-ai",
  nativeStackVersion: "0.82.0",
  bridgeProtocolVersion: 1,
  nativeStackDigest: NATIVE_STACK_DIGEST_V1,
  nativeCatalogDigest: NATIVE_CATALOG_DIGEST_V1,
  credentialResolverId: "pi-native-credential-resolver-v1",
  nativeRetries: "disabled",
  invocation: "structured-native-request",
});
const CONNECTION_DIGEST_V1 = digestCanonicalJson({
  id: "pi-native-openai-codex-v1",
  providerId: "openai-codex",
  displayName: "OpenAI Codex through Pi native sidecar",
  transport: NATIVE_LIBRARY_TRANSPORT_V1,
  allowedOrigins: ALLOWED_ORIGINS_V1,
  modelIntegrityDigest: MODEL_MANIFEST_DIGEST_V1,
  credentialBindingId: "openai-codex-pi-auth-v1",
});

/**
 * One resolved Pi/OpenAI-Codex installation. All non-resource facts are exact
 * for V2-S01; resource arrays may contain independently pinned declarations.
 */
export const FIRST_SLICE_CONFIGURATION_V1 = Object.freeze({
  configurationVersion: 1,
  bootstrap: Object.freeze({
    installationRef: "hitch-v2-first-slice",
    displayName: "Hitch v2 first slice",
    owner: Object.freeze({
      principalRef: "bootstrap-owner-v1",
      kind: "human",
      displayName: "Installation owner",
      state: "active",
      localHostRef: "local-host-v1",
      identityBindingRef: "bootstrap-owner-local-peer-v1",
      subjectRef: "service-owner-local-peer-v1",
      subjectResolution: "service-owner-effective-uid",
    }),
  }),
  ownerAccess: Object.freeze({
    installationRole: "admin",
    configurationUse: Object.freeze([
      Object.freeze({
        kind: "workspace",
        reference: "workspace-v1",
      }),
      Object.freeze({
        kind: "agent-profile",
        reference: "pi-openai-codex-v1",
      }),
      Object.freeze({
        kind: "execution-policy",
        reference: "standard-rw-no-shell-v1",
      }),
      Object.freeze({
        kind: "turn-policy",
        reference: "bounded-private-turns-v1",
      }),
      Object.freeze({
        kind: "provider-credential-binding",
        reference: "openai-codex-pi-auth-v1",
      }),
    ]),
  }),
  workspaceBinding: Object.freeze({
    kind: "trusted-supervisor-workspace-binding",
    bindingRef: "workspace-binding-v1",
    displayName: "First workspace",
    publicationRequirement: "supervisor-resolved-canonical-host-path",
    workspaceRef: "workspace-v1",
    revision: 1,
    workspaceResourceRef: "workspace-root-v1",
    sandboxPath: "/workspace",
    mounts: Object.freeze([]),
    access: "read-write",
  }),
  localEndpoint: Object.freeze({
    kind: "private-local-client",
    localHostRef: "local-host-v1",
    endpointRef: "local-endpoint-v1",
    ownership: "bootstrap-owner-only",
    socketSecurity: "service-owned-0700-parent-and-0600-socket",
  }),
  agentDriver: Object.freeze({
    id: "pi-rpc-driver-v1",
    protocol: "pi-rpc",
    piVersion: "0.82.0",
    launchProfileRef: "pi-rpc-0-82-0-v1",
    endpoint: "supervisor-owned-private-local",
    modelSelection: "resolved-before-admission",
  }),
  credentialBinding: Object.freeze({
    id: "openai-codex-pi-auth-v1",
    providerId: "openai-codex",
    displayName: "OpenAI Codex Pi credential",
    custody: "hitch-control-plane",
    resolverId: "pi-native-credential-resolver-v1",
    state: "active",
  }),
  provider: Object.freeze({
    connection: Object.freeze({
      id: "pi-native-openai-codex-v1",
      providerId: "openai-codex",
      displayName: "OpenAI Codex through Pi native sidecar",
      integrityDigest: CONNECTION_DIGEST_V1,
      allowedOrigins: ALLOWED_ORIGINS_V1,
      model: Object.freeze({ ...MODEL_MANIFEST_COVERAGE_V1, integrityDigest: MODEL_MANIFEST_DIGEST_V1 }),
      transport: NATIVE_LIBRARY_TRANSPORT_V1,
    }),
  }),
  executionPolicy: Object.freeze({
    id: "execution-policy-v1",
    reference: "standard-rw-no-shell-v1",
    displayName: "Read/write workspace without shell",
    revision: 1,
    sandbox: "required",
    workspaceFilesystem: "read-write",
    resourceGrants: Object.freeze([
      Object.freeze({ resourceRef: "workspace-root-v1", access: "read-write" }),
    ]),
    process: "deny",
    network: "deny",
    tools: Object.freeze(["tool-read-v1", "tool-write-v1", "tool-edit-v1", "tool-ls-v1"]),
    limits: Object.freeze({
      ...FIRST_SLICE_NUMERIC_DEFAULTS_V1.executionPolicyLimits,
    }),
  }),
  turnPolicy: Object.freeze({
    id: "turn-policy-v1",
    reference: "bounded-private-turns-v1",
    displayName: "Bounded private Turns",
    revision: 1,
    admission: Object.freeze({
      whenBusy: "bounded-fifo",
      maxQueuedTurns:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.maxQueuedTurns,
    }),
    timing: Object.freeze({
      initialActiveWorkMs:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.initialActiveWorkMs,
      toolExtensionMs:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.toolExtensionMs,
      maximumActiveWorkMs:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.maximumActiveWorkMs,
      interactionWaitMs:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.interactionWaitMs,
    }),
    interaction: Object.freeze({
      approval: "ask-authorized-approver",
      onApprovalTimeout: "deny",
      inputRequests: "deny",
      onInputTimeout: "no-input",
    }),
    retry: Object.freeze({
      maximumBeforeAcceptanceAttempts:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy
          .maximumBeforeAcceptanceAttempts,
      afterPossibleAcceptance: "never",
    }),
    inference: Object.freeze({
      maximumProviderRequests:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.maximumProviderRequests,
      maximumTotalTokens:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.maximumTotalTokens,
      maximumOutputTokensPerRequest:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy
          .maximumOutputTokensPerRequest,
    }),
    output: Object.freeze({
      progressDelivery: "checkpoints",
      checkpointIntervalMs:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy.checkpointIntervalMs,
      maximumCheckpointCharacters:
        FIRST_SLICE_NUMERIC_DEFAULTS_V1.turnPolicy
          .maximumCheckpointCharacters,
      persistFinalMessages: true,
      persistRawReasoning: false,
      persistRawToolInputOutput: false,
    }),
  }),
  installationHardCeilings:
    FIRST_SLICE_NUMERIC_DEFAULTS_V1.installationHardCeilings,
  profile: Object.freeze({
    id: "pi-profile-v1",
    reference: "pi-openai-codex-v1",
    revision: 1,
    driverId: "pi-rpc-driver-v1",
    displayName: "Pi RPC",
    providers: Object.freeze([
      Object.freeze({ providerId: "openai-codex", connectionId: "pi-native-openai-codex-v1", modelIds: Object.freeze(["gpt-5.4-mini"]) }),
    ]),
    defaultModel: Object.freeze({ providerId: "openai-codex", modelId: "gpt-5.4-mini" }),
    defaultReasoning: Object.freeze({ kind: "agent-default" }),
    configuration: Object.freeze({}),
    resourcePolicy: Object.freeze({
      skills: Object.freeze({ mode: "pinned", projectResources: "disabled" }),
      promptTemplates: Object.freeze({ mode: "pinned", projectResources: "disabled" }),
      themes: Object.freeze({ mode: "pinned", projectResources: "disabled" }),
      extensions: Object.freeze({ mode: "granted-only", discovery: "explicit-only", hotReload: false, promptLifecycle: "agent-loop-preserving" }),
    }),
  }),
  worker: Object.freeze({
    network: "deny",
    ambientLoaders: "disabled",
    projectAutoDiscovery: false,
    hotReload: false,
    shell: "deny",
    processTools: "deny",
  }),
  resources: Object.freeze({
    skills: Object.freeze({ mode: "pinned", projectResources: "disabled", snapshots: Object.freeze([]) }),
    promptTemplates: Object.freeze({ mode: "pinned", projectResources: "disabled", snapshots: Object.freeze([]) }),
    themes: Object.freeze({ mode: "pinned", projectResources: "disabled", snapshots: Object.freeze([]) }),
    extensions: Object.freeze({
      mode: "granted-only",
      loading: "explicit-pinned",
      promptLifecycle: "agent-loop-preserving",
      grants: Object.freeze([]),
    }),
  }),
});

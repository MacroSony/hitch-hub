import {
  decodePiNativeBridgeClientFrame,
  type PiNativeContext,
  type PiNativeInvokeFrame,
  type PiNativeReasoning,
} from "../../bridges/pi-native/frames.js";
import type { PiNativeCredentialStore, BoundPiNativeCredentialSource } from "./credential-store.js";
import { createPiNativeCredentialStore } from "./credential-store.js";
import type { FrozenPiNativeCatalog } from "./catalog.js";
import { createFrozenPiNativeCatalog } from "./catalog.js";
import type { PiNativeCatalogModel, PiNativeSidecarManifest } from "./manifest.js";
import type { InstalledPiNativeSidecarFetchBoundary } from "./fetch-boundary.js";
import { requireInstalledPiNativeSidecarFetchBoundary } from "./fetch-boundary.js";

export interface PiNativeInvocationInput {
  readonly correlationId: string;
  readonly model: PiNativeCatalogModel;
  readonly context: PiNativeContext;
  readonly options: {
    readonly maximumOutputTokens: number;
    readonly maxRetries: 0;
    readonly transport: "sse";
    readonly reasoning?: PiNativeReasoning;
  };
  readonly credentials: PiNativeCredentialStore;
}

/** A3 supplies the real Pi event adapter behind this deterministic A2 port. */
export interface PiNativeInvocationExecutor<Result = unknown> {
  invoke(input: PiNativeInvocationInput): Promise<Result>;
}

export interface PreparedPiNativeSidecar<Result = unknown> {
  readonly manifest: PiNativeSidecarManifest;
  readonly catalog: FrozenPiNativeCatalog;
  readonly credentials: PiNativeCredentialStore;
  invoke(frame: unknown): Promise<Result>;
}

export function preparePiNativeSidecar<Result>(input: {
  readonly boundary: InstalledPiNativeSidecarFetchBoundary;
  readonly credentialSource: BoundPiNativeCredentialSource;
  readonly executor: PiNativeInvocationExecutor<Result>;
}): PreparedPiNativeSidecar<Result> {
  const invokeNative = input.executor.invoke.bind(input.executor);
  const manifest = requireInstalledPiNativeSidecarFetchBoundary(input.boundary);
  const catalog = createFrozenPiNativeCatalog(manifest);
  const credentials = createPiNativeCredentialStore({
    manifest,
    source: input.credentialSource,
  });
  const expectedBinding = Object.freeze({
    bridgeId: manifest.bridge.id,
    nativeStackDigest: manifest.nativeStackDigest,
    nativeCatalogDigest: manifest.catalog.digest,
  });
  const prepared: PreparedPiNativeSidecar<Result> = {
    manifest,
    catalog,
    credentials,
    async invoke(rawFrame): Promise<Result> {
      const frame = decodePiNativeBridgeClientFrame(rawFrame, {
        binding: expectedBinding,
      });
      if (frame.kind !== "invoke") {
        throw new Error("Pi native invoke seam does not accept cancellation frames");
      }
      const model = catalog.require(
        manifest.credentialStore.providerId,
        manifest.catalog.model.id,
      );
      enforcePiNativeInvocationPolicy(frame, model);
      return invokeNative(
        deepFreeze({
          correlationId: frame.correlationId,
          model,
          context: frame.context,
          options: {
            maximumOutputTokens:
              frame.options.maximumOutputTokens ?? model.maximumOutputTokens,
            maxRetries: 0 as const,
            transport: "sse" as const,
            ...(frame.options.reasoning === undefined
              ? {}
              : { reasoning: frame.options.reasoning }),
          },
          credentials,
        }),
      );
    },
  };
  return Object.freeze(prepared);
}

export function enforcePiNativeInvocationPolicy(
  frame: PiNativeInvokeFrame,
  model: PiNativeCatalogModel,
): void {
  if (
    frame.options.maximumOutputTokens !== undefined &&
    frame.options.maximumOutputTokens > model.maximumOutputTokens
  ) {
    throw new Error("Pi native invocation exceeds the frozen output-token limit");
  }
  const reasoning = frame.options.reasoning;
  if (
    reasoning === undefined &&
    model.reasoningPolicy.kind === "portable-efforts" &&
    !model.reasoningPolicy.agentDefaultSupported
  ) {
    throw new Error("Pi native invocation cannot omit its required reasoning effort");
  }
  if (reasoning !== undefined) {
    if (
      model.reasoningPolicy.kind === "unsupported" ||
      !model.reasoningPolicy.supportedEfforts.includes(reasoning)
    ) {
      throw new Error("Pi native invocation selected unsupported reasoning");
    }
  }
  for (const message of frame.context.messages) {
    if (message.role === "assistant") {
      if (
        message.api !== model.api ||
        message.provider !== model.providerId ||
        message.model !== model.id
      ) {
        throw new Error("Pi native assistant history crossed the frozen model binding");
      }
      if (
        model.tools === "unsupported" &&
        message.content.some((content) => content.type === "toolCall")
      ) {
        throw new Error("Pi native history contains unsupported tool use");
      }
      if (
        model.reasoningPolicy.kind === "unsupported" &&
        message.content.some((content) => content.type === "thinking")
      ) {
        throw new Error("Pi native history contains unsupported reasoning");
      }
    }
    if (model.tools === "unsupported" && message.role === "toolResult") {
      throw new Error("Pi native history contains unsupported tool results");
    }
  }
  if (
    model.tools === "unsupported" &&
    frame.context.tools !== undefined &&
    frame.context.tools.length > 0
  ) {
    throw new Error("Pi native invocation selected unsupported tools");
  }
  const images = frame.context.messages.flatMap((message) => {
    if (
      (message.role !== "user" && message.role !== "toolResult") ||
      !Array.isArray(message.content)
    ) {
      return [];
    }
    return message.content.filter(
      (content): content is Extract<typeof content, { readonly type: "image" }> =>
        content.type === "image",
    );
  });
  if (images.length === 0) return;
  if (model.imageInput.kind === "unsupported") {
    throw new Error("Pi native invocation selected unsupported image input");
  }
  if (images.length > model.imageInput.maximumImagesPerRequest) {
    throw new Error("Pi native invocation exceeds its image-count limit");
  }
  let totalBytes = 0;
  for (const image of images) {
    if (!model.imageInput.acceptedMimeTypes.includes(image.mimeType)) {
      throw new Error("Pi native invocation selected an unsupported image MIME type");
    }
    const bytes = Buffer.byteLength(image.data, "base64");
    if (bytes > model.imageInput.maximumImageBytesEach) {
      throw new Error("Pi native invocation exceeds its per-image byte limit");
    }
    totalBytes += bytes;
  }
  if (totalBytes > model.imageInput.maximumTotalImageBytesPerRequest) {
    throw new Error("Pi native invocation exceeds its total image-byte limit");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

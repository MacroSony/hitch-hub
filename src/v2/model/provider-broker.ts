/**
 * Compile-only fixed-origin provider-broker adapter contract.
 *
 * The first wire protocol is OpenAI-compatible Chat Completions. A reusable
 * codec validates that protocol, while a reviewed immutable dialect manifest
 * pins one provider origin and its exact compatibility behavior.
 */

import type {
  AgentImageMimeType,
  BrokerEndpoint,
  CredentialLeaseId,
  InferenceRequestReservationId,
  IntegrityDigest,
  IsoTimestamp,
  JsonObject,
  ModelId,
  ProviderApiProtocolId,
  ProviderDialectId,
  ProviderId,
  ProviderTokenEstimatorId,
  TrustedHttpsOrigin,
  TurnId,
  WorkerLeaseId,
} from "./primitives.js";
import type { ModelRef, TurnReasoningSelection } from "./session.js";
import type { InferenceTokenUsage } from "./turn.js";

declare const validatedProviderRequestBrand: unique symbol;
declare const providerReservationAuthorizationBrand: unique symbol;
declare const providerForwardAuthorizationBrand: unique symbol;
declare const upstreamAuthenticationMaterialBrand: unique symbol;

/** Ephemeral secret material resolved only inside the trusted broker. */
export type UpstreamAuthenticationMaterial = string & {
  readonly [upstreamAuthenticationMaterialBrand]: true;
};

export interface OpenAIChatCompletionsModelSpec {
  readonly modelId: ModelId;
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly tokenEstimatorId: ProviderTokenEstimatorId;
  readonly imageInput:
    | { readonly kind: "unsupported" }
    | {
        readonly kind: "openai-content-parts";
        readonly acceptedMimeTypes: readonly [
          AgentImageMimeType,
          ...AgentImageMimeType[],
        ];
        readonly maximumImagesPerRequest: number;
        readonly maximumImageBytesEach: number;
        readonly maximumTotalImageBytesPerRequest: number;
      };
  readonly supportsTools: boolean;
  readonly reasoning:
    | { readonly kind: "unsupported" }
    | {
        readonly kind: "effort-map";
        /**
         * Null means that portable effort is unavailable for this exact model;
         * strings are the exact provider values projected into Pi.
         */
        readonly efforts: {
          readonly none: string | null;
          readonly low: string | null;
          readonly medium: string | null;
          readonly high: string | null;
        };
      };
}

export type OpenAIChatReasoningEncoding =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "pi-openai-completions";
      readonly thinkingFormat:
        | "openai"
        | "openrouter"
        | "together"
        | "deepseek"
        | "zai"
        | "qwen"
        | "chat-template"
        | "qwen-chat-template"
        | "string-thinking"
        | "ant-ling";
      readonly supportsReasoningEffort: boolean;
      readonly omitForAgentDefault: true;
    };

export type OpenAIChatCompletionsRequestField =
  | "model"
  | "messages"
  | "stream"
  | "stream_options"
  | "max_tokens"
  | "max_completion_tokens"
  | "temperature"
  | "top_p"
  | "stop"
  | "tools"
  | "tool_choice"
  | "tool_stream"
  | "parallel_tool_calls"
  | "response_format"
  | "reasoning_effort"
  | "reasoning"
  | "thinking"
  | "enable_thinking"
  | "chat_template_kwargs"
  | "preserve_thinking";

export type OpenAIChatCompletionsSemanticRequestHeader =
  | "accept"
  | "content-type";

/**
 * Headers emitted automatically by the pinned Pi/OpenAI client version. They
 * may be accepted after exact syntax/size validation but are stripped rather
 * than forwarded upstream.
 */
export type OpenAIChatCompletionsIgnoredClientHeader =
  | "user-agent"
  | "x-stainless-arch"
  | "x-stainless-lang"
  | "x-stainless-os"
  | "x-stainless-package-version"
  | "x-stainless-retry-count"
  | "x-stainless-runtime"
  | "x-stainless-runtime-version"
  | "x-stainless-timeout";

/** Safe protocol behavior projected into the agent runtime. */
export interface OpenAIChatCompletionsAgentCompatibility {
  readonly kind: "openai-chat-completions";
  readonly outputTokenField: "max_tokens" | "max_completion_tokens";
  readonly reasoning: OpenAIChatReasoningEncoding;
  readonly developerRole: "supported" | "map-to-system";
  readonly store: "unsupported";
  readonly streamingUsage:
    | "include-usage"
    | "unavailable-charge-reservation";
  readonly images: "unsupported" | "openai-content-parts";
  readonly tools: "unsupported" | "openai-function-tools";
  readonly strictToolSchema: "supported" | "unsupported";
  readonly requiresToolResultName: boolean;
  readonly requiresAssistantAfterToolResult: boolean;
  readonly requiresThinkingAsText: boolean;
  readonly requiresReasoningContentOnAssistantMessages: boolean;
  readonly deferredToolsMode: "disabled" | "kimi";
  readonly zaiToolStream: boolean;
}

/**
 * A reviewed provider compatibility manifest, never request-supplied
 * configuration. Pi receives these compatibility values explicitly because
 * its apparent base URL is Hitch's loopback broker rather than the real
 * provider origin.
 */
export interface OpenAIChatCompletionsDialectSpec
  extends OpenAIChatCompletionsAgentCompatibility {
  readonly id: ProviderDialectId;
  readonly providerId: ProviderId;
  readonly apiProtocolId: ProviderApiProtocolId;
  readonly wireProtocol: "openai-chat-completions";
  readonly fixedUpstreamOrigin: TrustedHttpsOrigin;
  readonly route: "/v1/chat/completions";
  readonly authentication: "bearer";
  readonly requestMethod: "POST";
  readonly streaming: "required";
  readonly unknownRequestFields: "reject";
  readonly requestBodyFields: readonly OpenAIChatCompletionsRequestField[];
  /** Carries only the local broker capability and is never forwarded. */
  readonly brokerAuthenticationHeader: "authorization";
  readonly semanticRequestHeaderNames: readonly OpenAIChatCompletionsSemanticRequestHeader[];
  readonly ignoredClientHeaderNames: readonly OpenAIChatCompletionsIgnoredClientHeader[];
  readonly modelSpecs: readonly [
    OpenAIChatCompletionsModelSpec,
    ...OpenAIChatCompletionsModelSpec[],
  ];
  /** Digest of the reviewed built-in manifest used for audit and fixtures. */
  readonly integrityDigest: IntegrityDigest;
}

export interface BrokerInboundHttpRequest {
  readonly method: string;
  readonly originFormTarget: string;
  /**
   * Ordered pre-canonicalization fields. Duplicate/framing/authority checks must
   * run before names are merged into a map.
   */
  readonly rawHeaders: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: unknown;
  readonly bodyByteLength: number;
  readonly receivedAt: IsoTimestamp;
}

export interface ProviderRequestAuthorizationContext {
  readonly turnId: TurnId;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly brokerEndpoint: BrokerEndpoint;
  readonly expectedDialectId: ProviderDialectId;
  readonly expectedModel: ModelRef;
  readonly expectedReasoning: TurnReasoningSelection;
  readonly maximumOutputTokens: number;
}

/**
 * Normalized only after method, origin-form route, headers, body fields, model,
 * reasoning, feature support, and finite output limit all pass validation.
 */
export interface ValidatedOpenAIChatCompletionsRequest {
  readonly [validatedProviderRequestBrand]: true;
  readonly providerId: ProviderId;
  readonly dialectId: ProviderDialectId;
  readonly turnId: TurnId;
  readonly model: ModelRef;
  readonly reasoning: TurnReasoningSelection;
  readonly stream: true;
  readonly includeStreamingUsage: boolean;
  readonly requestedOutputTokens: number;
  readonly normalizedBody: JsonObject;
  /** Digest of dialect, Turn, model, reasoning, and normalized body. */
  readonly requestFingerprint: IntegrityDigest;
}

export type ProviderRequestValidationResult =
  | {
      readonly accepted: true;
      readonly request: ValidatedOpenAIChatCompletionsRequest;
    }
  | {
      readonly accepted: false;
      readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429;
      readonly code: string;
      readonly sanitizedMessage: string;
    };

export interface ProviderInferenceReservationEstimate {
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedTotalTokens: number;
}

/**
 * Evidence returned only after live authorization and a durable reservation
 * commit. It does not yet permit upstream I/O.
 */
export interface ProviderReservationAuthorization {
  readonly [providerReservationAuthorizationBrand]: true;
  readonly reservationId: InferenceRequestReservationId;
  readonly requestFingerprint: IntegrityDigest;
  readonly turnId: TurnId;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly reservedAt: IsoTimestamp;
}

/**
 * Evidence that the same reservation is durably `forwarding`. Only this brand
 * permits the adapter to inject an upstream credential and build a sendable
 * request.
 */
export interface ProviderForwardAuthorization {
  readonly [providerForwardAuthorizationBrand]: true;
  readonly reservationId: InferenceRequestReservationId;
  readonly requestFingerprint: IntegrityDigest;
  readonly turnId: TurnId;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly forwardingAt: IsoTimestamp;
}

export type ProviderReservationAuthorizationResult =
  | {
      readonly authorized: true;
      readonly reservation: ProviderReservationAuthorization;
    }
  | {
      readonly authorized: false;
      readonly code: string;
      readonly sanitizedMessage: string;
    };

export type ProviderForwardAuthorizationResult =
  | {
      readonly authorized: true;
      readonly forwarding: ProviderForwardAuthorization;
    }
  | {
      readonly authorized: false;
      readonly code: string;
      readonly sanitizedMessage: string;
    };

/**
 * Trusted repository/application boundary. Both operations recheck current
 * Turn, lease, fence, credential, and budget authority in their transactions.
 */
export interface ProviderBrokerAuthorizationBoundary {
  reserveRequest(
    request: ValidatedOpenAIChatCompletionsRequest,
    estimate: ProviderInferenceReservationEstimate,
    authorization: ProviderRequestAuthorizationContext,
  ): Promise<ProviderReservationAuthorizationResult>;
  markForwarding(
    reservation: ProviderReservationAuthorization,
  ): Promise<ProviderForwardAuthorizationResult>;
}

/**
 * The adapter cannot choose an origin here. It is copied from its immutable
 * dialect manifest after validation; redirects are never followed.
 */
export interface FixedOriginUpstreamRequest {
  readonly origin: TrustedHttpsOrigin;
  readonly route: "/v1/chat/completions";
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: JsonObject;
}

export type ProviderUsageObservation =
  | {
      readonly reservationId: InferenceRequestReservationId;
      readonly usage: InferenceTokenUsage;
      readonly observedAt: IsoTimestamp;
      readonly source: "stream-final-usage";
    }
  | {
      readonly reservationId: InferenceRequestReservationId;
      readonly observedAt: IsoTimestamp;
      readonly source: "usage-unavailable";
    };

export interface AdaptedProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  readonly usage: Promise<ProviderUsageObservation>;
}

export interface RawUpstreamProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
}

/**
 * Reusable OpenAI Chat Completions codec bound to exactly one reviewed dialect.
 * Arbitrary URLs, routes, extra body fields, auth schemes, and model aliases
 * are not adapter inputs.
 */
export interface OpenAIChatCompletionsProviderAdapter {
  readonly dialect: OpenAIChatCompletionsDialectSpec;
  validateRequest(
    inbound: BrokerInboundHttpRequest,
    authorization: ProviderRequestAuthorizationContext,
  ): ProviderRequestValidationResult;
  estimateReservation(
    request: ValidatedOpenAIChatCompletionsRequest,
  ): ProviderInferenceReservationEstimate;
  buildUpstreamRequest(
    request: ValidatedOpenAIChatCompletionsRequest,
    forwarding: ProviderForwardAuthorization,
    authentication: UpstreamAuthenticationMaterial,
  ): FixedOriginUpstreamRequest;
  adaptResponse(
    request: ValidatedOpenAIChatCompletionsRequest,
    forwarding: ProviderForwardAuthorization,
    response: RawUpstreamProviderResponse,
  ): AdaptedProviderResponse;
}

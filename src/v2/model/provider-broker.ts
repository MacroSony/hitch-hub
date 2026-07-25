/**
 * Compile-only v2 inference control-plane and transport-bridge contract.
 *
 * Hitch owns authorization, credential custody, Turn budgets, reservations,
 * and audit. Provider request serialization and response parsing should be
 * reused from the selected agent/provider stack whenever a reviewed bridge is
 * available. Hitch-authored protocol adapters are a fallback, not the default.
 */

import type {
  AgentDriverId,
  AgentImageMimeType,
  BrokerEndpoint,
  CredentialLeaseId,
  InferenceProtocolInspectorId,
  InferenceForwardingAttemptId,
  InferenceRequestFingerprint,
  InferenceRequestReservationId,
  InferenceTransportBridgeId,
  InstallationId,
  IntegrityDigest,
  IsoTimestamp,
  JsonObject,
  ModelId,
  ProviderApiProtocolId,
  ProviderConnectionId,
  ProviderCredentialResolverId,
  ProviderId,
  ProviderTokenEstimatorId,
  TrustedUpstreamOrigin,
  TurnId,
  WorkerLeaseId,
} from "./primitives.js";
import type { ModelRef, TurnReasoningSelection } from "./session.js";
import type { InferenceTokenUsage } from "./turn.js";

declare const validatedInferenceRequestBrand: unique symbol;
declare const preparedProviderInferenceRequestBrand: unique symbol;
declare const providerReservationAuthorizationBrand: unique symbol;
declare const providerForwardAuthorizationBrand: unique symbol;
declare const boundProviderInvocationBrand: unique symbol;

/**
 * How one agent/provider connection performs inference. Only `agent-native`
 * places the real provider credential in the agent runtime.
 */
export type InferenceExecutionMode =
  | "native-library-sidecar"
  | "native-wire-gateway"
  | "agent-native"
  | "hitch-protocol-adapter";

export type ProviderCredentialCustody =
  | "hitch-control-plane"
  | "agent-runtime";

export interface ProviderModelManifest {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly apiProtocolId: ProviderApiProtocolId;
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly tokenEstimatorId: ProviderTokenEstimatorId;
  readonly imageInput:
    | { readonly kind: "unsupported" }
    | {
        readonly kind: "supported";
        readonly acceptedMimeTypes: readonly [
          AgentImageMimeType,
          ...AgentImageMimeType[],
        ];
        readonly maximumImagesPerRequest: number;
        readonly maximumImageBytesEach: number;
        readonly maximumTotalImageBytesPerRequest: number;
      };
  readonly tools: "unsupported" | "supported";
  readonly reasoning:
    | { readonly kind: "unsupported" }
    | {
        readonly kind: "portable-efforts";
        readonly supportedEfforts: readonly [
          "none" | "low" | "medium" | "high",
          ...("none" | "low" | "medium" | "high")[],
        ];
        readonly agentDefaultSupported: boolean;
      };
  /**
   * Secret-free exact metadata consumed only by the matching version-pinned
   * bridge/driver. It may describe native compatibility behavior but cannot
   * select an origin, credential, command, environment entry, or host path.
   */
  readonly nativeModelMetadata: JsonObject;
  readonly integrityDigest: IntegrityDigest;
}

export interface NativeLibrarySidecarTransport {
  readonly mode: "native-library-sidecar";
  readonly credentialCustody: "hitch-control-plane";
  readonly bridgeId: InferenceTransportBridgeId;
  readonly nativeStack: "pi-ai" | "other";
  readonly nativeStackVersion: string;
  readonly bridgeProtocolVersion: number;
  readonly nativeCatalogDigest: IntegrityDigest;
  readonly credentialResolverId: ProviderCredentialResolverId;
  /**
   * The first secure slice forbids hidden native-client retries under one
   * forwarding authorization. A later bridge may expose retries as new
   * attempts, each with its own durable reservation.
   */
  readonly nativeRetries: "disabled";
  /**
   * The bridge invokes a reviewed native provider library. Neither the worker
   * nor its extensions receive the upstream authentication material.
   */
  readonly invocation: "structured-native-request";
}

export interface NativeWireGatewayTransport {
  readonly mode: "native-wire-gateway";
  readonly credentialCustody: "hitch-control-plane";
  readonly bridgeId: InferenceTransportBridgeId;
  readonly inspectorId: InferenceProtocolInspectorId;
  readonly apiProtocolId: ProviderApiProtocolId;
  readonly credentialResolverId: ProviderCredentialResolverId;
  readonly requestBodyHandling: "opaque-after-inspection";
  readonly responseBodyHandling: "opaque-stream";
  readonly redirects: "deny";
}

export interface AgentNativeTransport {
  readonly mode: "agent-native";
  readonly credentialCustody: "agent-runtime";
  readonly driverId: AgentDriverId;
  readonly nativeProviderId: string;
  readonly enforcement: "turn-and-process-bound-observation";
  /**
   * This mode cannot claim broker-enforced per-request authorization, hard
   * token reservation, or credential isolation from the agent/extensions.
   */
  readonly assurance: "trusted-agent-runtime";
}

export interface HitchProtocolAdapterTransport {
  readonly mode: "hitch-protocol-adapter";
  readonly credentialCustody: "hitch-control-plane";
  readonly bridgeId: InferenceTransportBridgeId;
  readonly apiProtocolId: ProviderApiProtocolId;
  readonly credentialResolverId: ProviderCredentialResolverId;
  readonly redirects: "deny";
}

export type ProviderConnectionTransport =
  | NativeLibrarySidecarTransport
  | NativeWireGatewayTransport
  | AgentNativeTransport
  | HitchProtocolAdapterTransport;

export type BrokeredProviderConnectionTransport = Exclude<
  ProviderConnectionTransport,
  AgentNativeTransport
>;

/**
 * Immutable reviewed connection definition. A connection may target any
 * deliberately registered upstream supported by its native stack; an agent
 * request can never supply or replace an origin.
 */
export interface ProviderConnectionSpec {
  readonly id: ProviderConnectionId;
  readonly installationId: InstallationId;
  readonly providerId: ProviderId;
  readonly displayName: string;
  readonly transport: ProviderConnectionTransport;
  readonly allowedUpstreamOrigins: readonly [
    TrustedUpstreamOrigin,
    ...TrustedUpstreamOrigin[],
  ];
  readonly models: readonly [
    ProviderModelManifest,
    ...ProviderModelManifest[],
  ];
  readonly integrityDigest: IntegrityDigest;
  readonly createdAt: IsoTimestamp;
}

export type BrokeredProviderConnectionSpec = ProviderConnectionSpec & {
  readonly transport: BrokeredProviderConnectionTransport;
};

export interface BrokerInboundHttpRequest {
  readonly method: string;
  readonly originFormTarget: string;
  /**
   * Ordered pre-canonicalization fields. Duplicate/framing/authority checks run
   * before names are merged. The wire gateway never accepts `CONNECT`, an
   * absolute-form target, or a request-selected upstream authority.
   */
  readonly rawHeaders: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly body: Uint8Array;
  readonly receivedAt: IsoTimestamp;
}

/**
 * One bridge request. Structured sidecars use `nativePayload`; wire gateways
 * use `wireRequest`. A transport implementation accepts exactly one shape.
 */
export type InferenceBridgeInboundRequest =
  | {
      readonly kind: "structured-native";
      readonly nativePayload: JsonObject;
      readonly payloadByteLength: number;
      readonly receivedAt: IsoTimestamp;
    }
  | {
      readonly kind: "native-wire-http";
      readonly wireRequest: BrokerInboundHttpRequest;
    };

export interface ProviderRequestAuthorizationContext {
  readonly turnId: TurnId;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly brokerEndpoint: BrokerEndpoint;
  readonly expectedConnectionId: ProviderConnectionId;
  readonly expectedProviderId: ProviderId;
  readonly expectedModel: ModelRef;
  readonly expectedReasoning: TurnReasoningSelection;
  readonly maximumOutputTokens: number;
}

interface ValidatedInferenceRequestBase {
  readonly [validatedInferenceRequestBrand]: true;
  readonly connectionId: ProviderConnectionId;
  readonly providerId: ProviderId;
  readonly transportMode: Exclude<InferenceExecutionMode, "agent-native">;
  readonly bridgeId: InferenceTransportBridgeId;
  readonly apiProtocolId: ProviderApiProtocolId;
  readonly turnId: TurnId;
  readonly model: ModelRef;
  readonly reasoning: TurnReasoningSelection;
  readonly requestedOutputTokens: number;
  /** Digest of connection, bridge, Turn, model, reasoning, and native payload. */
  readonly requestFingerprint: InferenceRequestFingerprint;
}

/**
 * Produced only after the version-pinned bridge/inspector validates the exact
 * connection/model/reasoning, finite limits, request size, and transport
 * envelope. The discriminant preserves everything the selected native
 * transport needs without accepting a destination or credential.
 */
export type ValidatedInferenceRequest = ValidatedInferenceRequestBase &
  (
    | {
        readonly kind: "structured-native";
        readonly validatedNativePayload: JsonObject;
      }
    | {
        readonly kind: "native-wire-http";
        readonly validatedWireRequest: BrokerInboundHttpRequest;
      }
  );

export interface ProviderInferenceReservationEstimate {
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedTotalTokens: number;
}

/**
 * One trusted validation result that binds the exact request bytes/identity to
 * the token estimate reserved for them. The bridge creates it in the same
 * operation that validates the registered connection and request envelope, so
 * callers cannot pair request A with the cheaper estimate for request B.
 */
export interface PreparedProviderInferenceRequest {
  readonly [preparedProviderInferenceRequestBrand]: true;
  readonly request: ValidatedInferenceRequest;
  readonly reservationEstimate: ProviderInferenceReservationEstimate;
}

export type ProviderRequestValidationResult =
  | {
      readonly accepted: true;
      readonly prepared: PreparedProviderInferenceRequest;
    }
  | {
      readonly accepted: false;
      readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429;
      readonly code: string;
      readonly sanitizedMessage: string;
    };

/**
 * Evidence returned only after live authorization and a durable reservation
 * commit. It does not yet permit upstream I/O.
 */
export interface ProviderReservationAuthorization {
  readonly [providerReservationAuthorizationBrand]: true;
  readonly reservationId: InferenceRequestReservationId;
  readonly requestFingerprint: InferenceRequestFingerprint;
  readonly providerConnectionId: ProviderConnectionId;
  readonly turnId: TurnId;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly reservedAt: IsoTimestamp;
}

/**
 * Evidence that the same reservation is durably `forwarding` and its exact
 * attempt is `ready-for-one-send`. Implementations must consume the attempt
 * once; only this evidence permits native invocation or upstream credential
 * injection.
 */
export interface ProviderForwardAuthorization {
  readonly [providerForwardAuthorizationBrand]: true;
  readonly reservationId: InferenceRequestReservationId;
  readonly forwardingAttemptId: InferenceForwardingAttemptId;
  readonly requestFingerprint: InferenceRequestFingerprint;
  readonly providerConnectionId: ProviderConnectionId;
  readonly turnId: TurnId;
  readonly credentialLeaseId: CredentialLeaseId;
  readonly workerLeaseId: WorkerLeaseId;
  readonly workerFencingToken: number;
  readonly forwardingAt: IsoTimestamp;
}

/**
 * Trusted aggregate produced only after the control boundary proves that the
 * registered connection, validated request, reservation, and forwarding
 * authorization carry the same connection, Turn, fingerprint, lease, and
 * fence identities. Keeping them behind one brand prevents bridge callers from
 * pairing authorization A with request B.
 */
export interface BoundProviderInvocation {
  readonly [boundProviderInvocationBrand]: true;
  readonly connection: BrokeredProviderConnectionSpec;
  readonly request: ValidatedInferenceRequest;
  readonly forwarding: ProviderForwardAuthorization;
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
      readonly invocation: BoundProviderInvocation;
    }
  | {
      readonly authorized: false;
      readonly code: string;
      readonly sanitizedMessage: string;
    };

/**
 * Trusted repository/application boundary. Both operations recheck current
 * Turn, connection, lease, fence, credential, and budget authority.
 */
export interface InferenceControlAuthorizationBoundary {
  reserveRequest(
    prepared: PreparedProviderInferenceRequest,
    authorization: ProviderRequestAuthorizationContext,
  ): Promise<ProviderReservationAuthorizationResult>;
  /**
   * Before changing durable state, proves exact equality between the validated
   * request and reservation identities and resolves the same live registered
   * connection. A mismatch returns denial and performs no forwarding
   * transition, credential resolution, native invocation, or upstream I/O.
  */
  markForwarding(
    prepared: PreparedProviderInferenceRequest,
    reservation: ProviderReservationAuthorization,
  ): Promise<ProviderForwardAuthorizationResult>;
}

export type ProviderUsageObservation =
  | {
      readonly reservationId: InferenceRequestReservationId;
      readonly usage: InferenceTokenUsage;
      readonly observedAt: IsoTimestamp;
      readonly source: "native-final-usage" | "wire-inspector";
    }
  | {
      readonly reservationId: InferenceRequestReservationId;
      readonly observedAt: IsoTimestamp;
      readonly source: "usage-unavailable";
    };

export type BrokeredInferenceStream =
  | {
      readonly kind: "structured-native";
      /** Versioned events from the native provider library back to its agent. */
      readonly events: AsyncIterable<JsonObject>;
      readonly usage: Promise<ProviderUsageObservation>;
      cancel(reason: string): Promise<void>;
    }
  | {
      readonly kind: "native-wire-http";
      readonly status: number;
      /**
       * Reviewed response fields after hop-by-hop and sensitive headers are
       * removed. Ordering is retained for the agent's native HTTP client.
       */
      readonly sanitizedHeaders: readonly {
        readonly name: string;
        readonly value: string;
      }[];
      readonly body: AsyncIterable<Uint8Array>;
      readonly usage: Promise<ProviderUsageObservation>;
      cancel(reason: string): Promise<void>;
    };

/**
 * One reviewed, version-pinned bridge implementation. A Pi bridge delegates to
 * Pi's own ModelRuntime/provider stack; a wire bridge reuses the agent's
 * serializer/parser; a Hitch codec is only the final fallback.
 */
export interface BrokeredInferenceTransportBridge {
  readonly id: InferenceTransportBridgeId;
  readonly modes: readonly [
    Exclude<InferenceExecutionMode, "agent-native">,
    ...Exclude<InferenceExecutionMode, "agent-native">[],
  ];
  validateRequest(
    connection: BrokeredProviderConnectionSpec,
    inbound: InferenceBridgeInboundRequest,
    authorization: ProviderRequestAuthorizationContext,
  ): ProviderRequestValidationResult;
  /**
   * Accepts only the trusted aggregate bound before the forwarding transition.
   * Atomically compare-and-swaps its exact forwarding attempt from
   * `ready-for-one-send` to `send-started`, then resolves the connection's
   * credential through its trusted resolver and starts at most one native
   * invocation. A failed compare-and-swap performs no upstream I/O. Raw
   * authentication material never crosses this interface.
   */
  invoke(
    invocation: BoundProviderInvocation,
  ): Promise<BrokeredInferenceStream>;
}

/**
 * Best-effort usage emitted by a credential-trusted native agent. It is useful
 * for audit and soft limits but is not broker reservation evidence.
 */
export interface AgentNativeInferenceObservation {
  readonly connectionId: ProviderConnectionId;
  readonly turnId: TurnId;
  readonly model: ModelRef;
  readonly usage?: InferenceTokenUsage;
  readonly observedAt: IsoTimestamp;
  readonly source: "agent-native";
}

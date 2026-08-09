import type {
  AuthenticatedConnectorContext,
  BackgroundServiceAuthorizationComponent,
  LocalConnectorAuthenticationPort,
  RemoteConnectorAuthenticationPort,
  ServiceAuthorizationContextPort,
  TrustedServiceAuthorizationContext,
} from "../model/application.js";
import type { ClientCertificateVerificationPort } from "../connectors/remote/certificate-verification.js";
import { createClientCertificateTrust } from "../connectors/remote/certificate-verification.js";
import {
  createLocalConnectorAuthentication,
  type LocalConnectorAuthenticationOptions,
  type LocalConnectorConnectionIssuer,
} from "./local-authentication.js";
import {
  createRemoteConnectorAuthentication,
  type RemoteConnectorAuthenticationBundle,
} from "./remote-authentication.js";

const BACKGROUND_COMPONENTS = Object.freeze({
  "turn-coordinator": true,
  supervisor: true,
  broker: true,
  delivery: true,
  recovery: true,
} as const satisfies Readonly<
  Record<BackgroundServiceAuthorizationComponent, true>
>);

export type VerifiedAuthorizationContext =
  | {
      readonly kind: "connector";
      readonly context: AuthenticatedConnectorContext;
    }
  | {
      readonly kind: "service";
      readonly component: BackgroundServiceAuthorizationComponent;
      readonly context: TrustedServiceAuthorizationContext<
        BackgroundServiceAuthorizationComponent
      >;
    };

/**
 * Runtime verifier used at application boundaries. It accepts unknown so a
 * cast, clone, or value from another composition cannot bypass its identity
 * check.
 */
export interface TrustedAuthorizationContextVerifier {
  classify(context: unknown): VerifiedAuthorizationContext | undefined;
}

export interface FirstSliceAuthorizationTrust {
  /** Passed only to the verified local Unix-socket listener. */
  readonly localConnectionIssuer: LocalConnectorConnectionIssuer;
  /** Passed only to the local connector authentication adapter. */
  readonly localAuthentication: LocalConnectorAuthenticationPort;
  /** Retained by trusted composition; application services receive values. */
  readonly serviceContextIssuer: ServiceAuthorizationContextPort;
  /** Passed to application/repository boundaries that consume authority. */
  readonly contextVerifier: TrustedAuthorizationContextVerifier;
}

export interface MultiUserAuthorizationTrust
  extends FirstSliceAuthorizationTrust {
  /** Passed only to the mTLS listener after its OpenSSL handshake. */
  readonly remoteCertificateVerifier: ClientCertificateVerificationPort;
  /** Passed only to the bounded remote connector. */
  readonly remoteAuthentication: RemoteConnectorAuthenticationPort;
}

export class ServiceAuthorizationTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAuthorizationTrustError";
  }
}

function isBackgroundComponent(
  input: unknown,
): input is BackgroundServiceAuthorizationComponent {
  return (
    typeof input === "string" &&
    Object.hasOwn(BACKGROUND_COMPONENTS, input)
  );
}

/**
 * Creates one process-local authority domain. Composition distributes the
 * returned narrow capabilities; callers cannot recreate trusted contexts from
 * persisted actors, component strings, structural casts, or cloned values.
 */
function createAuthorizationTrust(
  options: LocalConnectorAuthenticationOptions,
  remote?: {
    readonly certificateVerifier: ClientCertificateVerificationPort;
    readonly authentication: RemoteConnectorAuthenticationBundle;
  },
): FirstSliceAuthorizationTrust | MultiUserAuthorizationTrust {
  const local = createLocalConnectorAuthentication(options);
  const serviceContexts =
    new WeakMap<object, BackgroundServiceAuthorizationComponent>();

  const serviceContextIssuer: ServiceAuthorizationContextPort =
    Object.freeze({
      async forComponent<
        Component extends BackgroundServiceAuthorizationComponent,
      >(
        component: Component,
      ): Promise<TrustedServiceAuthorizationContext<Component>> {
        if (!isBackgroundComponent(component)) {
          throw new ServiceAuthorizationTrustError(
            "component cannot receive first-slice service authority",
          );
        }
        const context = Object.freeze({
          actor: Object.freeze({
            kind: "system" as const,
            component,
          }),
        }) as TrustedServiceAuthorizationContext<Component>;
        serviceContexts.set(context, component);
        return context;
      },
    });

  const contextVerifier: TrustedAuthorizationContextVerifier =
    Object.freeze({
      classify(context: unknown): VerifiedAuthorizationContext | undefined {
        if (typeof context !== "object" || context === null) {
          return undefined;
        }
        if (
          local.contextVerifier.isAuthentic(
            context as AuthenticatedConnectorContext,
          ) ||
          remote?.authentication.contextVerifier.isAuthentic(
            context as AuthenticatedConnectorContext,
          ) === true
        ) {
          return Object.freeze({
            kind: "connector" as const,
            context: context as AuthenticatedConnectorContext,
          });
        }
        const component = serviceContexts.get(context);
        if (component === undefined) return undefined;
        return Object.freeze({
          kind: "service" as const,
          component,
          context:
            context as TrustedServiceAuthorizationContext<
              BackgroundServiceAuthorizationComponent
            >,
        });
      },
    });

  const base = {
    localConnectionIssuer: local.connectionIssuer,
    localAuthentication: local.authentication,
    serviceContextIssuer,
    contextVerifier,
  };
  return Object.freeze(
    remote === undefined
      ? base
      : {
          ...base,
          remoteCertificateVerifier: remote.certificateVerifier,
          remoteAuthentication: remote.authentication.authentication,
        },
  );
}

export function createFirstSliceAuthorizationTrust(
  options: LocalConnectorAuthenticationOptions,
): FirstSliceAuthorizationTrust {
  return createAuthorizationTrust(options) as FirstSliceAuthorizationTrust;
}

/** Creates one authority domain spanning the elevated local and mTLS paths. */
export function createMultiUserAuthorizationTrust(
  options: LocalConnectorAuthenticationOptions & {
    readonly clientCertificateTrustRootId: string;
  },
): MultiUserAuthorizationTrust {
  const certificate = createClientCertificateTrust({
    trustRootId: options.clientCertificateTrustRootId,
    clock: options.clock,
  });
  const remote = createRemoteConnectorAuthentication({
    database: options.database,
    clock: options.clock,
    ids: options.ids,
    evidenceConsumer: certificate.evidenceConsumer,
  });
  return createAuthorizationTrust(options, {
    certificateVerifier: certificate.verifier,
    authentication: remote,
  }) as MultiUserAuthorizationTrust;
}

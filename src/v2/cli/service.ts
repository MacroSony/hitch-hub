import {
  createFirstSliceAuthorizationTrust,
  createMultiUserAuthorizationTrust,
} from "../application/authorization-contexts.js";
import {
  SQLiteDevelopmentNoOpCoordinator,
  SQLiteWalkingSkeletonTurnResultQuery,
  WalkingSkeletonConnectorApplication,
} from "../application/walking-skeleton.js";
import { FIRST_SLICE_CONFIGURATION_V1 } from "../bootstrap/fixture-v1.js";
import { projectBootstrapPublication } from "../bootstrap/publication-projection.js";
import { createLocalProtocolApplicationDispatch } from "../connectors/local/application-dispatch.js";
import {
  listenLocalProtocolSocket,
  type LocalProtocolSocketServer,
} from "../connectors/local/socket.js";
import {
  LocalPrivateAttachmentStore,
  createLocalImageIntakeVault,
} from "../persistence/attachment-store.js";
import { SQLiteBootstrapPublicationUnitOfWork } from "../persistence/bootstrap-publication.js";
import type { V2Database } from "../persistence/database.js";
import { openCanonicalHitchV2Database } from "../persistence/initialize.js";
import { HITCH_V2_SCHEMA_DIGEST } from "../persistence/schema.js";
import { SQLiteSessionCreationUnitOfWork } from "../persistence/session-creation.js";
import { SQLiteLocalAdministration } from "../persistence/local-administration.js";
import {
  SQLiteTurnAdmissionUnitOfWork,
  SQLiteTurnCancellationUnitOfWork,
} from "../persistence/turn-admission.js";
import { CryptographicIdSource, SystemClock } from "../runtime/system.js";
import type { WalkingSkeletonStartupConfiguration } from "./configuration.js";

export interface WalkingSkeletonService {
  readonly socketPath: string;
  readonly isClosed: boolean;
  close(): Promise<void>;
}

export interface StartWalkingSkeletonServiceOptions {
  readonly configuration: WalkingSkeletonStartupConfiguration;
  readonly onConnectionError?: (error: unknown) => void;
}

function projectDevelopmentBootstrap(
  configuration: WalkingSkeletonStartupConfiguration,
) {
  return projectBootstrapPublication({
    configuration: FIRST_SLICE_CONFIGURATION_V1,
    resolved: {
      timestamp: configuration.bootstrapPublishedAt,
      auditActor: { kind: "bootstrap" },
      serviceSchemaDigest: HITCH_V2_SCHEMA_DIGEST,
      sourceReferences: {
        installationRef: "hitch-v2-first-slice",
        principalRef: "bootstrap-owner-v1",
        localHostRef: "local-host-v1",
        identityBindingRef: "bootstrap-owner-local-peer-v1",
        subjectRef: "service-owner-local-peer-v1",
        subjectResolution: "service-owner-effective-uid",
        endpointRef: "local-endpoint-v1",
        workspaceBindingRef: "workspace-binding-v1",
      },
      ids: {
        installationId: "installation-v1",
        ownerId: "owner-v1",
        identityBindingId: "owner-binding-v1",
        endpointId: "endpoint-v1",
        installationRoleGrantId: "role-grant-v1",
        localHostId: "local-host-v1",
        authenticationSubjectId: "local-owner-subject-v1",
        localEndpointId: "local-endpoint-v1",
        workspaceId: "workspace-v1",
        workspaceRevisionId: "workspace-revision-v1",
        profileId: "pi-profile-v1",
        profileRevisionId: "pi-profile-revision-v1",
        executionPolicyId: "execution-policy-v1",
        executionPolicySnapshotId: "execution-policy-snapshot-v1",
        turnPolicyId: "turn-policy-v1",
        turnPolicySnapshotId: "turn-policy-snapshot-v1",
        providerConnectionId: "pi-native-openai-codex-v1",
        credentialBindingId: "openai-codex-pi-auth-v1",
        configurationUseGrantIds: {
          workspace: "grant-workspace-v1",
          profile: "grant-profile-v1",
          executionPolicy: "grant-execution-v1",
          turnPolicy: "grant-turn-v1",
          credentialBinding: "grant-credential-v1",
        },
        extensionUseGrantIds: [],
      },
      trustedWorkspaceBinding: {
        bindingRef: "workspace-binding-v1",
        workspaceReference: "workspace-v1",
        revision: 1,
        root: {
          id: "workspace-root-v1",
          canonicalHostPath: configuration.workspaceRoot,
          sandboxPath: "/workspace",
          maximumAccess: "read-write",
        },
        mounts: [],
      },
    },
  }).records;
}

class RunningWalkingSkeletonService implements WalkingSkeletonService {
  readonly socketPath: string;
  readonly #socket: LocalProtocolSocketServer;
  readonly #database: V2Database;
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(socket: LocalProtocolSocketServer, database: V2Database) {
    this.socketPath = socket.socketPath;
    this.#socket = socket;
    this.#database = database;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      try {
        await this.#socket.close();
      } finally {
        this.#database.close();
        this.#closed = true;
      }
    })();
    return this.#closePromise;
  }
}

/** Starts only the explicitly development-scoped V2-014A composition. */
export async function startWalkingSkeletonService(
  options: StartWalkingSkeletonServiceOptions,
): Promise<WalkingSkeletonService> {
  const clock = new SystemClock();
  const ids = new CryptographicIdSource();
  const database = openCanonicalHitchV2Database({
    dataRoot: options.configuration.dataRoot,
  });
  let socket: LocalProtocolSocketServer | undefined;
  try {
    await new SQLiteBootstrapPublicationUnitOfWork({
      database,
      clock,
      ids,
    }).publishBootstrap(projectDevelopmentBootstrap(options.configuration));
    const trust = options.configuration.clientCertificateTrustRootId === undefined
      ? createFirstSliceAuthorizationTrust({ database, clock, ids })
      : createMultiUserAuthorizationTrust({
          database,
          clock,
          ids,
          clientCertificateTrustRootId:
            options.configuration.clientCertificateTrustRootId,
        });
    const administration =
      options.configuration.clientCertificateTrustRootId === undefined
        ? undefined
        : new SQLiteLocalAdministration({
            database,
            clock,
            ids,
            contextVerifier: trust.contextVerifier,
            clientCertificateTrustRootId:
              options.configuration.clientCertificateTrustRootId,
          });
    const intake = createLocalImageIntakeVault();
    const attachmentStorage = new LocalPrivateAttachmentStore({
      database,
      clock,
      ids,
      intake,
    });
    const cancellation = new SQLiteTurnCancellationUnitOfWork({
      database,
      clock,
      ids,
      contextVerifier: trust.contextVerifier,
    });
    const application = new WalkingSkeletonConnectorApplication({
      sessionCreation: new SQLiteSessionCreationUnitOfWork({
        database,
        clock,
        ids,
        contextVerifier: trust.contextVerifier,
      }),
      turnAdmission: new SQLiteTurnAdmissionUnitOfWork({
        database,
        clock,
        ids,
        contextVerifier: trust.contextVerifier,
      }),
      attachmentStorage,
      turnResultQuery: new SQLiteWalkingSkeletonTurnResultQuery({
        database,
        contextVerifier: trust.contextVerifier,
      }),
      queuedCancellation: cancellation,
      activeCancellation: cancellation,
      coordinator: new SQLiteDevelopmentNoOpCoordinator({
        database,
        clock,
        ids,
        contextVerifier: trust.contextVerifier,
      }),
    });
    socket = await listenLocalProtocolSocket({
      root: database.root,
      connectionIssuer: trust.localConnectionIssuer,
      authentication: trust.localAuthentication,
      handle: createLocalProtocolApplicationDispatch({
        application,
        imageIntake: intake,
        ...(administration === undefined ? {} : { administration }),
      }),
      ...(options.onConnectionError === undefined
        ? {}
        : { onConnectionError: options.onConnectionError }),
    });
    return new RunningWalkingSkeletonService(socket, database);
  } catch (error) {
    if (socket !== undefined) await socket.close().catch(() => undefined);
    database.close();
    throw error;
  }
}

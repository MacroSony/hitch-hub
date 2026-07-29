import { FIRST_SLICE_CONFIGURATION_V1 } from "../bootstrap/fixture-v1.js";
import { projectBootstrapPublication } from "../bootstrap/publication-projection.js";
import type { BootstrapPublicationRecords } from "../model/application.js";
import { HITCH_V2_SCHEMA_DIGEST } from "../persistence/schema.js";

/** Complete multi-resource publication fixture for persistence/application tests. */
export function createBootstrapPublicationRecords(): BootstrapPublicationRecords {
  const configuration = structuredClone(FIRST_SLICE_CONFIGURATION_V1);
  const resources = configuration.resources as Record<string, unknown>;
  const skills = resources.skills as Record<string, unknown>;
  (skills.snapshots as unknown[]).push(
    {
      kind: "skill",
      snapshotId: "profile-skill-v1",
      displayName: "Profile skill",
      artifactRef: "profile-skill-bundle-v1",
      integrityDigest: `sha256:${"a".repeat(64)}`,
    },
    {
      kind: "skill",
      snapshotId: "profile-skill-v2",
      displayName: "Second profile skill",
      artifactRef: "profile-skill-bundle-v2",
      integrityDigest: `sha256:${"d".repeat(64)}`,
    },
  );
  const extensions = resources.extensions as Record<string, unknown>;
  (extensions.grants as unknown[]).push(
    {
      extensionId: "profile-extension-v1",
      extensionRef: "profile-extension-v1",
      extensionRevisionId: "profile-extension-revision-v1",
      revision: 1,
      displayName: "Profile extension",
      configurationSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      revisionArtifactRef: "profile-extension-bundle-v1",
      revisionIntegrityDigest: `sha256:${"b".repeat(64)}`,
      grantSnapshotId: "profile-extension-grant-v1",
      grantIntegrityDigest: `sha256:${"c".repeat(64)}`,
      ownerUseGrant: "required",
      capabilityIds: [
        "extension-capability-v1",
        "shared-extension-capability-v1",
      ],
      promptLifecycle: "agent-loop-preserving",
      configuration: {},
    },
    {
      extensionId: "profile-extension-v2",
      extensionRef: "profile-extension-v2",
      extensionRevisionId: "profile-extension-revision-v2",
      revision: 1,
      displayName: "Second profile extension",
      configurationSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      revisionArtifactRef: "profile-extension-bundle-v2",
      revisionIntegrityDigest: `sha256:${"d".repeat(64)}`,
      grantSnapshotId: "profile-extension-grant-v2",
      grantIntegrityDigest: `sha256:${"e".repeat(64)}`,
      ownerUseGrant: "required",
      capabilityIds: [
        "extension-capability-v2",
        "shared-extension-capability-v1",
      ],
      promptLifecycle: "agent-loop-preserving",
      configuration: {},
    },
  );
  return projectBootstrapPublication({
    configuration,
    resolved: {
      timestamp: "2026-07-29T12:00:00.000Z",
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
        extensionUseGrantIds: [
          {
            extensionId: "profile-extension-v1",
            grantId: "grant-extension-v1",
          },
          {
            extensionId: "profile-extension-v2",
            grantId: "grant-extension-v2",
          },
        ],
      },
      trustedWorkspaceBinding: {
        bindingRef: "workspace-binding-v1",
        workspaceReference: "workspace-v1",
        revision: 1,
        root: {
          id: "workspace-root-v1",
          canonicalHostPath: "/srv/hitch-workspace",
          sandboxPath: "/workspace",
          maximumAccess: "read-write",
        },
        mounts: [],
      },
    },
  }).records;
}

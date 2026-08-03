import {
  installSidecarFetchGuard,
  requireInstalledSidecarFetchGuard,
  type InstalledSidecarFetchGuard,
} from "../../runtime/sidecar-egress/fetch-guard.js";
import {
  decodePiNativeSidecarManifest,
  type PiNativeSidecarManifest,
} from "./manifest.js";

const installedPiBoundaryBrand: unique symbol = Symbol(
  "installed-pi-native-sidecar-fetch-boundary",
);

export interface InstalledPiNativeSidecarFetchBoundary {
  readonly [installedPiBoundaryBrand]: true;
  readonly manifest: PiNativeSidecarManifest;
  readonly fetchGuardProof: InstalledSidecarFetchGuard;
}

const installedPiBoundaries = new WeakSet<object>();

/**
 * The production sidecar calls this before dynamically importing either Pi
 * package. V2-006B consumes the returned proof when it loads verified files.
 */
export function installPiNativeSidecarFetchBoundary(
  input: unknown,
): InstalledPiNativeSidecarFetchBoundary {
  const manifest = decodePiNativeSidecarManifest(input);
  const fetchGuardProof = installSidecarFetchGuard(
    manifest.connection.allowedOrigins,
  );
  const boundary = Object.freeze({
    [installedPiBoundaryBrand]: true as const,
    manifest,
    fetchGuardProof,
  });
  installedPiBoundaries.add(boundary);
  return boundary;
}

export function requireInstalledPiNativeSidecarFetchBoundary(
  boundary: InstalledPiNativeSidecarFetchBoundary,
): PiNativeSidecarManifest {
  if (!installedPiBoundaries.has(boundary)) {
    throw new Error("forged Pi native sidecar fetch boundary");
  }
  requireInstalledSidecarFetchGuard(boundary.fetchGuardProof);
  return boundary.manifest;
}

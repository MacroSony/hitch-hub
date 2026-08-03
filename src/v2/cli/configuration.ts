import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import { parseDocument } from "yaml";

import { decodeIsoTimestamp } from "../codecs/primitives.js";
import type { IsoTimestamp } from "../model/primitives.js";

const MAXIMUM_STARTUP_CONFIGURATION_BYTES = 64 * 1024;

export interface WalkingSkeletonStartupConfiguration {
  readonly version: 1;
  readonly mode: "development-walking-skeleton";
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly bootstrapPublishedAt: IsoTimestamp;
}

export class WalkingSkeletonConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WalkingSkeletonConfigurationError";
  }
}

function requireTrustedFile(path: string): string {
  const absolute = resolve(path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new WalkingSkeletonConfigurationError(
      "unable to inspect the v2 startup configuration",
      { cause: error },
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration must be a regular file, never a symlink",
    );
  }
  if (
    process.platform !== "win32" &&
    stat.uid !== process.getuid?.()
  ) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration must be owned by the service account",
    );
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration must not be group- or world-writable",
    );
  }
  if (
    stat.size < 1 ||
    stat.size > MAXIMUM_STARTUP_CONFIGURATION_BYTES
  ) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration has an invalid byte length",
    );
  }
  if (realpathSync(absolute) !== absolute) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration path must be canonical",
    );
  }
  return absolute;
}

function exactObject(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration must contain one plain object",
    );
  }
  const object = input as Record<string, unknown>;
  const expected = [
    "version",
    "mode",
    "dataRoot",
    "workspaceRoot",
    "bootstrapPublishedAt",
  ];
  const actual = Object.keys(object).sort();
  if (
    actual.length !== expected.length ||
    expected.some((field) => !Object.hasOwn(object, field))
  ) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration fields do not match the walking-skeleton contract",
    );
  }
  return object;
}

function absoluteNormalizedPath(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    input.length > 4_096 ||
    normalize(input) !== input
  ) {
    throw new WalkingSkeletonConfigurationError(
      `${label} must be a normalized absolute path`,
    );
  }
  return input;
}

function requireCanonicalWorkspace(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new WalkingSkeletonConfigurationError(
      "unable to inspect the configured workspace root",
      { cause: error },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WalkingSkeletonConfigurationError(
      "configured workspace root must be a real directory",
    );
  }
  if (realpathSync(path) !== path) {
    throw new WalkingSkeletonConfigurationError(
      "configured workspace root must have a canonical path",
    );
  }
  return path;
}

export function loadWalkingSkeletonStartupConfiguration(
  path: string,
): WalkingSkeletonStartupConfiguration {
  const trustedPath = requireTrustedFile(path);
  let document;
  try {
    document = parseDocument(readFileSync(trustedPath, "utf8"), {
      uniqueKeys: true,
    });
  } catch (error) {
    throw new WalkingSkeletonConfigurationError(
      "unable to parse the v2 startup configuration",
      { cause: error },
    );
  }
  if (document.errors.length !== 0 || document.warnings.length !== 0) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration contains invalid or ambiguous YAML",
      { cause: document.errors[0] ?? document.warnings[0] },
    );
  }
  const object = exactObject(document.toJS({ maxAliasCount: 0 }));
  if (object.version !== 1) {
    throw new WalkingSkeletonConfigurationError(
      "v2 startup configuration version must be 1",
    );
  }
  if (object.mode !== "development-walking-skeleton") {
    throw new WalkingSkeletonConfigurationError(
      "production v2 startup remains disabled until V2-014B",
    );
  }
  const dataRoot = absoluteNormalizedPath(object.dataRoot, "v2 data root");
  const workspaceRoot = requireCanonicalWorkspace(
    absoluteNormalizedPath(object.workspaceRoot, "workspace root"),
  );
  let bootstrapPublishedAt: IsoTimestamp;
  try {
    bootstrapPublishedAt = decodeIsoTimestamp(object.bootstrapPublishedAt);
  } catch (error) {
    throw new WalkingSkeletonConfigurationError(
      "bootstrapPublishedAt must be a canonical RFC3339 UTC timestamp",
      { cause: error },
    );
  }
  return Object.freeze({
    version: 1 as const,
    mode: "development-walking-skeleton" as const,
    dataRoot,
    workspaceRoot,
    bootstrapPublishedAt,
  });
}

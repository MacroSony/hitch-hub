import { realpathSync, statSync } from "node:fs";
import path from "node:path";

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInsideAllowedRoots(candidate: string, allowedRoots: readonly string[]): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);

  return allowedRoots.some((root) => {
    const normalizedRoot = normalizeForCompare(root);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

export function canonicalizeExistingDirectory(value: string, label = "Directory"): string {
  const realPath = realpathSync(value);
  if (!statSync(realPath).isDirectory()) {
    throw new Error(`${label} is not a directory: ${value}`);
  }
  return realPath;
}

export function canonicalizeAllowedRoots(values: string[], label = "Allowed root"): string[] {
  return [...new Set(values.map((value) => canonicalizeExistingDirectory(value, label)))];
}

export function snapshotCanonicalAllowedRoots(values: string[], label = "Allowed root"): string[] {
  return [...new Set(values.map((value) => {
    const resolved = path.resolve(value);
    const canonical = canonicalizeExistingDirectory(resolved, label);
    if (normalizeForCompare(canonical) !== normalizeForCompare(resolved)) {
      throw new Error(`${label} is not a canonical runtime path: ${value}`);
    }
    return canonical;
  }))];
}

export function realDirectoryInsideAllowedRoots(
  candidate: string,
  allowedRoots: string[],
): string | undefined {
  try {
    const realCandidate = canonicalizeExistingDirectory(candidate, "Working directory");
    return isPathInsideAllowedRoots(realCandidate, allowedRoots) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

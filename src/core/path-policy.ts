import path from "node:path";

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInsideAllowedRoots(candidate: string, allowedRoots: string[]): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);

  return allowedRoots.some((root) => {
    const normalizedRoot = normalizeForCompare(root);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

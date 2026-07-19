import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type PiPathModule = {
  resolveToCwd?: (input: string, cwd: string) => string;
};

type CredentialGuardModule = {
  normalizePiBuiltinPath?: (input: string) => unknown;
};

export type PiPathCompatibilityReceipt = {
  version: string;
  executablePath: string;
  resolverPath: string;
};

const UNICODE_SPACES = ["\u00a0", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u202f", "\u205f", "\u3000"];
const compatibilityChecks = new Map<string, Promise<PiPathCompatibilityReceipt>>();

export async function assertInstalledPiPathCompatibility(
  command: string,
  credentialGuardPath: string,
): Promise<PiPathCompatibilityReceipt> {
  const executablePath = resolveExecutable(command);
  const packageRoot = findPiPackageRoot(executablePath);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string };
  if (packageJson.name !== "@earendil-works/pi-coding-agent" || !packageJson.version) {
    throw new Error("Credential-isolated Pi requires an identifiable @earendil-works/pi-coding-agent installation.");
  }
  const resolverPath = path.join(packageRoot, "dist", "core", "tools", "path-utils.js");
  if (!existsSync(resolverPath) || !statSync(resolverPath).isFile()) {
    throw new Error(`Credential-isolated Pi path resolver is unavailable: ${resolverPath}`);
  }
  const cacheKey = [
    executablePath,
    statSync(executablePath).mtimeMs,
    resolverPath,
    statSync(resolverPath).mtimeMs,
    credentialGuardPath,
    statSync(credentialGuardPath).mtimeMs,
  ].join(":");
  const existing = compatibilityChecks.get(cacheKey);
  if (existing) {
    return existing;
  }
  const pending = verifyInstalledResolvers(
    packageJson.version,
    executablePath,
    resolverPath,
    credentialGuardPath,
  );
  compatibilityChecks.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    compatibilityChecks.delete(cacheKey);
    throw error;
  }
}

export function assertPiPathResolversCompatible(
  piResolveToCwd: (input: string, cwd: string) => string,
  guardNormalize: (input: string) => unknown,
): void {
  const cwd = path.resolve(".hitch-pi-path-compatibility-workspace");
  const inputs = [
    "",
    ".",
    "inside.txt",
    "nested/inside.txt",
    "../outside.txt",
    "@inside.txt",
    "@../outside.txt",
    "~",
    "~/credential.txt",
    "file:///agent-config/auth.json",
    ...UNICODE_SPACES.map((space) => `unicode${space}escape.txt`),
    ...UNICODE_SPACES.map((space) => `@unicode${space}escape.txt`),
  ];
  for (const input of inputs) {
    const normalized = guardNormalize(input);
    if (typeof normalized !== "string") {
      throw new Error(`Hitch credential guard returned a non-string path for ${JSON.stringify(input)}.`);
    }
    const expected = path.resolve(cwd, normalized);
    const actual = piResolveToCwd(input, cwd);
    if (actual !== expected) {
      throw new Error(
        `Installed Pi path normalization is incompatible with Hitch's credential guard for ${JSON.stringify(input)}. Expected ${expected}; Pi resolved ${actual}.`,
      );
    }
  }
}

async function verifyInstalledResolvers(
  version: string,
  executablePath: string,
  resolverPath: string,
  credentialGuardPath: string,
): Promise<PiPathCompatibilityReceipt> {
  const cacheSuffix = `?hitch-mtime=${statSync(resolverPath).mtimeMs}`;
  const piModule = (await import(`${pathToFileURL(resolverPath).href}${cacheSuffix}`)) as PiPathModule;
  const guardModule = (await import(
    `${pathToFileURL(credentialGuardPath).href}?hitch-mtime=${statSync(credentialGuardPath).mtimeMs}`
  )) as CredentialGuardModule;
  if (typeof piModule.resolveToCwd !== "function") {
    throw new Error("Installed Pi does not expose the path resolver required for credential-isolation attestation.");
  }
  if (typeof guardModule.normalizePiBuiltinPath !== "function") {
    throw new Error("Hitch credential guard does not expose its path normalizer for startup attestation.");
  }
  assertPiPathResolversCompatible(piModule.resolveToCwd, guardModule.normalizePiBuiltinPath);
  return { version, executablePath, resolverPath };
}

function resolveExecutable(command: string): string {
  const candidate = command.includes(path.sep) ? path.resolve(command) : commandOnPath(command);
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`Credential-isolated Pi executable was not found: ${command}`);
  }
  const canonical = realpathSync.native(candidate);
  if (!statSync(canonical).isFile()) {
    throw new Error(`Credential-isolated Pi command is not a regular file: ${canonical}`);
  }
  return canonical;
}

function commandOnPath(command: string): string | undefined {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim().split(/\r?\n/, 1)[0];
}

function findPiPackageRoot(executablePath: string): string {
  let current = path.dirname(executablePath);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
        if (packageJson.name === "@earendil-works/pi-coding-agent") {
          return current;
        }
      } catch {
        // Keep walking. The fail-closed error below reports the unsupported layout.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    `Credential-isolated Pi could not locate @earendil-works/pi-coding-agent from ${executablePath}.`,
  );
}

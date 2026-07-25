import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_PI_VERSION = "0.82.0";

function executableCandidates(name) {
  if (name.includes("/")) {
    return [name];
  }
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, name));
}

export function findPiExecutable(command = process.env.HITCH_PI_COMMAND ?? "pi") {
  for (const candidate of executableCandidates(command)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Pi command is not available on PATH: ${command}`);
}

export function resolvePiPackage(command) {
  const executable = findPiExecutable(command);
  let current = dirname(realpathSync(executable));
  while (current !== dirname(current)) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageJson.name === "@earendil-works/pi-coding-agent") {
        if (packageJson.version !== REQUIRED_PI_VERSION) {
          throw new Error(
            `The spike requires Pi ${REQUIRED_PI_VERSION}; found ${packageJson.version}.`,
          );
        }
        const piAiRoot = join(
          current,
          "node_modules",
          "@earendil-works",
          "pi-ai",
        );
        const piAiPackage = JSON.parse(
          readFileSync(join(piAiRoot, "package.json"), "utf8"),
        );
        if (piAiPackage.version !== REQUIRED_PI_VERSION) {
          throw new Error(
            `The spike requires pi-ai ${REQUIRED_PI_VERSION}; found ${piAiPackage.version}.`,
          );
        }
        return {
          executable,
          packageRoot: current,
          piAiRoot,
          runtimeRoot:
            basename(dirname(resolve(executable))) === "bin"
              ? dirname(dirname(resolve(executable)))
              : dirname(dirname(realpathSync(executable))),
          version: packageJson.version,
        };
      }
    }
    current = dirname(current);
  }
  throw new Error(`Could not resolve the Pi package from ${executable}.`);
}

function walkFiles(root, current = root) {
  const output = [];
  for (const name of readdirSync(current).sort()) {
    const path = join(current, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      output.push(...walkFiles(root, path));
    } else if (stat.isFile() && !name.endsWith(".map")) {
      output.push(path);
    }
  }
  return output;
}

export function nativeStackDigest(piPackage) {
  const hash = createHash("sha256");
  const roots = [
    join(piPackage.packageRoot, "package.json"),
    join(piPackage.packageRoot, "dist", "core"),
    join(piPackage.piAiRoot, "package.json"),
    join(piPackage.piAiRoot, "dist"),
  ];
  for (const root of roots) {
    const files = statSync(root).isDirectory() ? walkFiles(root) : [root];
    for (const file of files) {
      const owner =
        file.startsWith(piPackage.piAiRoot)
          ? piPackage.piAiRoot
          : piPackage.packageRoot;
      hash.update(relative(owner, file));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestJson(value) {
  return `sha256:${createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")}`;
}

export function publicModelManifest(model) {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export async function loadPiModules(piPackage) {
  const [codingAgent, piAi] = await Promise.all([
    import(pathToFileURL(join(piPackage.packageRoot, "dist", "index.js"))),
    import(pathToFileURL(join(piPackage.piAiRoot, "dist", "index.js"))),
  ]);
  return { codingAgent, piAi };
}

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { configSchema, type HubConfig, type HubConfigInput } from "./schema.js";

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function resolvePath(value: string, baseDir: string): string {
  return path.resolve(baseDir, expandHome(value));
}

export function loadConfig(configPath: string): HubConfig {
  const resolvedConfigPath = path.resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Config file not found: ${resolvedConfigPath}`);
  }

  const raw = readFileSync(resolvedConfigPath, "utf8");
  const parsed = YAML.parse(raw) as HubConfigInput;
  const config = configSchema.parse(parsed);
  const configDir = path.dirname(resolvedConfigPath);
  const dataDir = resolvePath(config.data_dir, configDir);

  const allowedRoots = Object.values(config.users).flatMap((user) =>
    user.allowed_roots.map((root) => resolvePath(root, configDir)),
  );
  const defaultCwd = config.default_cwd ? resolvePath(config.default_cwd, configDir) : allowedRoots[0];

  return {
    ...config,
    dataDir,
    ...(defaultCwd ? { defaultCwd } : {}),
    allowedRoots,
  };
}

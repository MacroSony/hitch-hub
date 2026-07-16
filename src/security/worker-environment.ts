const BASE_WORKER_ENVIRONMENT = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);

const FORBIDDEN_WORKER_ENVIRONMENT = new Set([
  "_JAVA_OPTIONS",
  "BASH_ENV",
  "BUN_OPTIONS",
  "CLASSPATH",
  "CONTAINER_HOST",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOTNET_STARTUP_HOOKS",
  "ENV",
  "GCONV_PATH",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GPG_AGENT_INFO",
  "GLIBC_TUNABLES",
  "HOSTALIASES",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "KUBECONFIG",
  "LOCPATH",
  "MALLOC_TRACE",
  "NLSPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "PERL5LIB",
  "PERL5OPT",
  "PERL_LOCAL_LIB_ROOT",
  "PODMAN_HOST",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYLIB",
  "RUBYOPT",
  "BASHOPTS",
  "CDPATH",
  "FPATH",
  "PHPRC",
  "PROMPT_COMMAND",
  "PS4",
  "PSMODULEPATH",
  "SHELLOPTS",
  "SSH_ASKPASS",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "SUDO_ASKPASS",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "ZDOTDIR",
]);

const RESERVED_PREFIXES = [
  "BASH_",
  "CARGO_",
  "COMPLUS_",
  "COREHOST_",
  "DOTNET_",
  "DYLD_",
  "GIT_",
  "HITCH_",
  "JAVA_",
  "JDK_",
  "LD_",
  "LUA_",
  "NODE_",
  "NPM_",
  "PERL",
  "PHP_",
  "PNPM_",
  "PYTHON",
  "RUBY",
  "RUST",
  "YARN_",
];

export const WORKER_ENVIRONMENT_OVERRIDE_NAMES = [
  "HOME",
  "HITCH_SESSION_ID",
  "HITCH_TOOL_OUTBOX",
  "HITCH_TOOL_RESULT_DIR",
  "HITCH_TOOL_TIMEOUT_MS",
  "HITCH_TOOL_TOKEN",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
] as const;

const WORKER_ENVIRONMENT_OVERRIDES = new Set<string>(WORKER_ENVIRONMENT_OVERRIDE_NAMES);

export type WorkerEnvironmentOptions = {
  source?: NodeJS.ProcessEnv;
  allowlist?: readonly string[];
  blockedNames?: readonly string[];
  overrides?: Readonly<Record<string, string>>;
};

function normalizedName(name: string): string {
  return name.toUpperCase();
}

function assertEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid worker environment variable name: ${name}`);
  }
}

function isReservedEnvironmentName(name: string): boolean {
  const normalized = normalizedName(name);
  return (
    FORBIDDEN_WORKER_ENVIRONMENT.has(normalized) ||
    RESERVED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function assertWorkerEnvironmentAllowlist(
  allowlist: readonly string[],
  blockedNames: readonly string[] = [],
): void {
  const blocked = new Set(blockedNames.map(normalizedName));
  for (const name of allowlist) {
    assertEnvironmentName(name);
    const normalized = normalizedName(name);
    if (blocked.has(normalized)) {
      throw new Error(`Worker environment cannot inherit channel credential: ${name}`);
    }
    if (isReservedEnvironmentName(normalized)) {
      throw new Error(`Worker environment variable is reserved or unsafe: ${name}`);
    }
  }
}

export function assertWorkerEnvironmentCredentialNames(blockedNames: readonly string[]): void {
  const internalNames = new Set(WORKER_ENVIRONMENT_OVERRIDE_NAMES.map(normalizedName));
  for (const name of blockedNames) {
    assertEnvironmentName(name);
    if (internalNames.has(normalizedName(name))) {
      throw new Error(`Channel credential environment variable conflicts with a Hitch worker variable: ${name}`);
    }
  }
}

function isBaseEnvironmentName(name: string): boolean {
  const normalized = normalizedName(name);
  return BASE_WORKER_ENVIRONMENT.has(normalized) || /^LC_[A-Z0-9_]+$/.test(normalized);
}

export function buildWorkerEnvironment(options: WorkerEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  const allowlist = options.allowlist ?? [];
  const blockedNames = options.blockedNames ?? [];
  assertWorkerEnvironmentAllowlist(allowlist, blockedNames);

  const explicit = new Set(allowlist.map(normalizedName));
  const blocked = new Set(blockedNames.map(normalizedName));
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = normalizedName(name);
    if (
      value !== undefined &&
      !blocked.has(normalized) &&
      !isReservedEnvironmentName(normalized) &&
      (isBaseEnvironmentName(normalized) || explicit.has(normalized))
    ) {
      result[name] = value;
    }
  }

  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    assertEnvironmentName(name);
    const normalized = normalizedName(name);
    if (!WORKER_ENVIRONMENT_OVERRIDES.has(normalized)) {
      throw new Error(`Worker environment override is not a recognized Hitch variable: ${name}`);
    }
    if (blocked.has(normalized)) {
      throw new Error(`Worker environment override conflicts with a channel credential: ${name}`);
    }
    result[name] = value;
  }
  return result;
}

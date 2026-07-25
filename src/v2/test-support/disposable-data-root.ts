import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const ROOT_PREFIX = "hitch-v2-test-";
const OWNERSHIP_MARKER = ".hitch-v2-disposable-root";

export class UnsafeDisposableDataRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDisposableDataRootError";
  }
}

export type DisposableDataRootCleanupResult = "removed" | "already-removed";

/**
 * Test-only disposable root. Cleanup verifies a direct canonical tmp child and
 * an exact ownership marker before recursively removing anything.
 */
export class DisposableDataRoot {
  readonly path: string;
  readonly #canonicalTmpRoot: string;
  #removed = false;

  private constructor(path: string, canonicalTmpRoot: string) {
    this.path = path;
    this.#canonicalTmpRoot = canonicalTmpRoot;
  }

  static async create(): Promise<DisposableDataRoot> {
    const canonicalTmpRoot = await realpath(tmpdir());
    const path = await mkdtemp(join(canonicalTmpRoot, ROOT_PREFIX));
    try {
      await writeFile(join(path, OWNERSHIP_MARKER), path, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await rm(path, { recursive: true, force: false });
      throw error;
    }
    return new DisposableDataRoot(path, canonicalTmpRoot);
  }

  resolve(...segments: readonly string[]): string {
    if (this.#removed) {
      throw new UnsafeDisposableDataRootError(
        "disposed data roots cannot be reused",
      );
    }
    for (const segment of segments) {
      if (
        segment.length === 0 ||
        isAbsolute(segment) ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\")
      ) {
        throw new UnsafeDisposableDataRootError(
          "data-root path segments must be non-empty child names",
        );
      }
    }

    const candidate = resolve(this.path, ...segments);
    const withinRoot = relative(this.path, candidate);
    if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
      throw new UnsafeDisposableDataRootError(
        "resolved path escapes the disposable data root",
      );
    }
    return candidate;
  }

  async mkdir(...segments: readonly string[]): Promise<string> {
    const path = this.resolve(...segments);
    await mkdir(path, { recursive: true });
    return path;
  }

  async cleanup(): Promise<DisposableDataRootCleanupResult> {
    if (this.#removed) {
      return "already-removed";
    }

    let rootStat;
    try {
      rootStat = await lstat(this.path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.#removed = true;
        return "already-removed";
      }
      throw error;
    }

    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      dirname(this.path) !== this.#canonicalTmpRoot ||
      !basename(this.path).startsWith(ROOT_PREFIX) ||
      (await realpath(this.path)) !== this.path
    ) {
      throw new UnsafeDisposableDataRootError(
        "refusing to remove an unrecognized disposable data root",
      );
    }

    let marker: string;
    try {
      marker = await readFile(join(this.path, OWNERSHIP_MARKER), "utf8");
    } catch {
      throw new UnsafeDisposableDataRootError(
        "refusing to remove a data root without its ownership marker",
      );
    }
    if (marker !== this.path) {
      throw new UnsafeDisposableDataRootError(
        "refusing to remove a data root with a mismatched ownership marker",
      );
    }

    await rm(this.path, { recursive: true, force: false });
    this.#removed = true;
    return "removed";
  }
}

export async function withDisposableDataRoot<Result>(
  work: (root: DisposableDataRoot) => Promise<Result> | Result,
): Promise<Result> {
  const root = await DisposableDataRoot.create();
  let result: Result | undefined;
  let workFailed = false;
  let workError: unknown;
  try {
    result = await work(root);
  } catch (error) {
    workFailed = true;
    workError = error;
  }

  try {
    await root.cleanup();
  } catch (cleanupError) {
    if (workFailed) {
      throw new AggregateError(
        [workError, cleanupError],
        "disposable data-root work and cleanup both failed",
      );
    }
    throw cleanupError;
  }

  if (workFailed) {
    throw workError;
  }
  return result as Result;
}

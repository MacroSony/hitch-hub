import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  DeterministicClock,
  DeterministicIdSource,
} from "./deterministic.js";
import {
  DisposableDataRoot,
  UnsafeDisposableDataRootError,
  withDisposableDataRoot,
} from "./disposable-data-root.js";
import {
  createUnimplementedTestPort,
  UnimplementedTestPortError,
} from "./fake-port.js";

test("deterministic clock implements repeatable production time", () => {
  const clock = new DeterministicClock("2025-01-02T03:04:05.000Z");

  assert.equal(clock.now(), "2025-01-02T03:04:05.000Z");
  assert.equal(clock.now(), "2025-01-02T03:04:05.000Z");
  assert.equal(clock.advance(1_500), "2025-01-02T03:04:06.500Z");
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => new DeterministicClock("2025-01-02"), TypeError);
});

test("deterministic ID source uses stable independent sequences", () => {
  const ids = new DeterministicIdSource("fixture");

  assert.equal(ids.next("Turn"), "fixture:Turn:0001");
  assert.equal(ids.next("Session"), "fixture:Session:0001");
  assert.equal(ids.next("Turn"), "fixture:Turn:0002");
  assert.equal(
    ids.nextTurnIdempotencyKey(),
    "fixture:turn-idempotency:0001",
  );
  assert.equal(ids.nextOriginMessageId(), "fixture:origin-message:0001");
});

test("disposable data root removes only its owned canonical tmp child", async () => {
  const root = await DisposableDataRoot.create();
  const sibling = await mkdtemp(
    join(dirname(root.path), "hitch-v2-test-sibling-"),
  );

  try {
    await root.mkdir("sqlite");
    assert.equal((await stat(root.resolve("sqlite"))).isDirectory(), true);
    assert.throws(
      () => root.resolve(".."),
      UnsafeDisposableDataRootError,
    );
    assert.throws(
      () => root.resolve("."),
      UnsafeDisposableDataRootError,
    );

    assert.equal(await root.cleanup(), "removed");
    await assert.rejects(stat(root.path), { code: "ENOENT" });
    assert.equal((await stat(sibling)).isDirectory(), true);
    assert.equal(await root.cleanup(), "already-removed");
    assert.throws(
      () => root.resolve("recreated"),
      UnsafeDisposableDataRootError,
    );
    await assert.rejects(
      root.mkdir("recreated"),
      UnsafeDisposableDataRootError,
    );
    await assert.rejects(stat(root.path), { code: "ENOENT" });
  } finally {
    await rm(sibling, { recursive: true, force: true });
  }
});

test("disposable data root is cleaned when test work throws", async () => {
  let allocatedPath: string | undefined;

  await assert.rejects(
    withDisposableDataRoot((root) => {
      allocatedPath = root.path;
      throw new Error("fixture failure");
    }),
    /fixture failure/u,
  );

  assert.ok(allocatedPath);
  await assert.rejects(stat(allocatedPath), { code: "ENOENT" });
});

test("disposable root cleanup fails closed for missing and mismatched markers", async () => {
  const root = await DisposableDataRoot.create();
  const marker = join(root.path, ".hitch-v2-disposable-root");

  try {
    await rm(marker);
    await assert.rejects(
      root.cleanup(),
      /without its ownership marker/u,
    );

    await writeFile(marker, "not-the-owned-root", "utf8");
    await assert.rejects(
      root.cleanup(),
      /mismatched ownership marker/u,
    );
  } finally {
    await rm(root.path, { recursive: true, force: true });
  }
});

test("work and cleanup failures are both preserved", async () => {
  let allocatedPath: string | undefined;

  try {
    await assert.rejects(
      withDisposableDataRoot(async (root) => {
        allocatedPath = root.path;
        await rm(join(root.path, ".hitch-v2-disposable-root"));
        throw new Error("work failed");
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /work failed/u);
        assert.ok(error.errors[1] instanceof UnsafeDisposableDataRootError);
        return true;
      },
    );
  } finally {
    if (allocatedPath !== undefined) {
      await rm(allocatedPath, { recursive: true, force: true });
    }
  }
});

test("empty fake ports fail explicitly instead of returning defaults", () => {
  interface ExamplePort {
    perform(): Promise<string>;
  }

  const port = createUnimplementedTestPort<ExamplePort>("ExamplePort");
  assert.throws(
    () => port.perform(),
    (error: unknown) => {
      assert.ok(error instanceof UnimplementedTestPortError);
      assert.equal(error.portName, "ExamplePort");
      assert.equal(error.memberName, "perform");
      return true;
    },
  );
});

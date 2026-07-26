import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { scenarioCase } from "../acceptance/runner.js";
import { withDisposableDataRoot } from "../test-support/disposable-data-root.js";
import { V2Database, type V2RepositoryTransaction } from "./database.js";
import {
  NestedTransactionError,
  ActiveTransactionCloseError,
  AsyncTransactionWorkError,
  TransactionConnectionPoisonedError,
  TransactionBoundaryFaultError,
  TransactionRollbackFailedError,
  UnsafeSqlStatementError,
  V2DataRootError,
  V2InstallationMarkerError,
  V2UnknownDataRootContentsError,
} from "./errors.js";
import {
  V2_DATABASE_FILENAME,
  V2_INSTALLATION_MARKER_FILENAME,
  V2_OWNED_DIRECTORY_NAMES,
  prepareV2DataRoot,
} from "./root.js";
import { DeterministicTransactionFaults, ExplicitTransactionRunner } from "./transaction.js";

function scalar(database: V2Database, sql: string): unknown {
  const row = database.transaction((transaction) => transaction.get(sql));
  return row === undefined ? undefined : Object.values(row)[0];
}

function initializeTestSchema(database: V2Database, ...statements: readonly string[]): void {
  database.initializePristineSchema((schema) => {
    for (const statement of statements) schema.executeSchemaStatement(statement);
    schema.stampSchemaIdentity(24680, 1);
  });
}

function createCrashedUnknownWalDatabase(databasePath: string): {
  readonly walPath: string;
  readonly shmPath: string;
} {
  writeFileSync(databasePath, Buffer.alloc(0), { mode: 0o600 });
  const child = spawnSync(process.execPath, ["--eval", `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(process.argv[1]);
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("CREATE TABLE legacy_value (value INTEGER NOT NULL)");
    database.exec("BEGIN IMMEDIATE");
    database.exec("INSERT INTO legacy_value VALUES (1)");
    process.abort();
  `, databasePath], { encoding: "utf8" });
  assert.notEqual(child.status, 0);
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  assert.equal(existsSync(walPath), true);
  assert.equal(existsSync(shmPath), true);
  for (const path of [databasePath, walPath, shmPath]) chmodSync(path, 0o600);
  return { walPath, shmPath };
}

test("v2 database creates exactly its marker and hitch.sqlite at a configured root", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const database = V2Database.open({ dataRoot });
    try {
      assert.equal(database.root.path, dataRoot);
      assert.equal(database.root.databasePath, join(dataRoot, V2_DATABASE_FILENAME));
      assert.equal(scalar(database, "PRAGMA foreign_keys"), 1);
      assert.equal(scalar(database, "PRAGMA busy_timeout"), 5000);
      assert.equal(scalar(database, "PRAGMA journal_mode"), "wal");
      assert.equal(scalar(database, "PRAGMA application_id"), 0);
      assert.equal(scalar(database, "PRAGMA user_version"), 0);
      assert.equal(scalar(database, "SELECT name FROM sqlite_master WHERE type = 'table'"), undefined);
      assert.equal(lstatSync(join(dataRoot, V2_INSTALLATION_MARKER_FILENAME)).mode & 0o077, 0);
      assert.equal(lstatSync(join(dataRoot, V2_DATABASE_FILENAME)).mode & 0o077, 0);
    } finally {
      database.close();
      database.close();
    }
  });
});

test("v2 database reopens only the same marked root", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    V2Database.open({ dataRoot }).close();
    const reopened = V2Database.open({ dataRoot });
    assert.equal(reopened.root.newlyCreated, false);
    reopened.close();
  });
});

test("v2 database permits only explicitly owned future root directories", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    V2Database.open({ dataRoot }).close();
    for (const name of V2_OWNED_DIRECTORY_NAMES) {
      mkdirSync(join(dataRoot, name), { mode: 0o700 });
    }
    const reopened = V2Database.open({ dataRoot });
    reopened.close();
  });
});

test("v2 database refuses missing, mismatched, and unknown root state without opening it", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const missingMarkerRoot = disposable.resolve("missing-marker");
    mkdirSync(missingMarkerRoot, { mode: 0o700 });
    assert.throws(() => V2Database.open({ dataRoot: missingMarkerRoot }), V2InstallationMarkerError);

    const mismatchRoot = disposable.resolve("mismatch-marker");
    mkdirSync(mismatchRoot, { mode: 0o700 });
    writeFileSync(join(mismatchRoot, V2_INSTALLATION_MARKER_FILENAME), "wrong\n", { mode: 0o600 });
    assert.throws(() => V2Database.open({ dataRoot: mismatchRoot }), V2InstallationMarkerError);

    const oversizedMarkerRoot = disposable.resolve("oversized-marker");
    mkdirSync(oversizedMarkerRoot, { mode: 0o700 });
    writeFileSync(join(oversizedMarkerRoot, V2_INSTALLATION_MARKER_FILENAME), "x".repeat(65_536), { mode: 0o600 });
    assert.throws(() => V2Database.open({ dataRoot: oversizedMarkerRoot }), V2InstallationMarkerError);

    const unknownRoot = disposable.resolve("unknown-content");
    const database = V2Database.open({ dataRoot: unknownRoot });
    database.close();
    writeFileSync(join(unknownRoot, "unrecognized"), "no", { mode: 0o600 });
    assert.throws(() => V2Database.open({ dataRoot: unknownRoot }), V2UnknownDataRootContentsError);
  });
});

test("orphan SQLite auxiliary state prevents database creation without mutation", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const prepared = prepareV2DataRoot(dataRoot);
    const journalPath = `${prepared.databasePath}-journal`;
    writeFileSync(journalPath, "orphan", { mode: 0o600 });
    const before = readFileSync(journalPath);
    assert.throws(() => V2Database.open({ dataRoot }), V2UnknownDataRootContentsError);
    assert.equal(existsSync(prepared.databasePath), false);
    assert.deepEqual(readFileSync(journalPath), before);
  });
});

test("v2 database refuses root and direct-child symlinks", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const target = disposable.resolve("target");
    V2Database.open({ dataRoot: target }).close();
    const rootLink = disposable.resolve("root-link");
    symlinkSync(target, rootLink);
    assert.equal(readlinkSync(rootLink), target);
    assert.throws(() => V2Database.open({ dataRoot: rootLink }), V2DataRootError);

    const childLinkRoot = disposable.resolve("child-link");
    mkdirSync(childLinkRoot, { mode: 0o700 });
    symlinkSync(join(target, V2_INSTALLATION_MARKER_FILENAME), join(childLinkRoot, V2_INSTALLATION_MARKER_FILENAME));
    assert.throws(() => V2Database.open({ dataRoot: childLinkRoot }), V2DataRootError);
  });
});

test("v2 database refuses a noncanonical or group-writable configured parent", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const parent = disposable.resolve("parent");
    mkdirSync(parent, { mode: 0o700 });
    const parentLink = disposable.resolve("parent-link");
    symlinkSync(parent, parentLink);
    assert.throws(() => V2Database.open({ dataRoot: join(parentLink, "state") }), V2DataRootError);
    chmodSync(parent, 0o720);
    assert.throws(() => V2Database.open({ dataRoot: join(parent, "state") }), V2DataRootError);
  });
});

test("v2 database refuses publicly accessible root state", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const database = V2Database.open({ dataRoot });
    database.close();
    chmodSync(dataRoot, 0o755);
    assert.throws(() => V2Database.open({ dataRoot }), V2DataRootError);
  });
});

test("a live database fails closed when its configured root is replaced", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const replacement = disposable.resolve("replacement");
    const database = V2Database.open({ dataRoot });
    V2Database.open({ dataRoot: replacement }).close();
    try {
      renameSync(dataRoot, disposable.resolve("state-before-replacement"));
      renameSync(replacement, dataRoot);
      assert.throws(() => database.transaction((transaction) => transaction.get("SELECT 1")), V2DataRootError);
    } finally {
      database.close();
    }
  });
});

test("live-root revalidation never recreates a missing configured path", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const database = V2Database.open({ dataRoot });
    try {
      renameSync(dataRoot, disposable.resolve("state-removed"));
      assert.throws(() => database.transaction((transaction) => transaction.get("SELECT 1")), V2DataRootError);
      assert.equal(existsSync(dataRoot), false);
    } finally {
      database.close();
    }
  });
});

test("live database revalidation rejects a replaced SQLite file", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const database = V2Database.open({ dataRoot });
    const databasePath = join(dataRoot, V2_DATABASE_FILENAME);
    try {
      const replacementSource = disposable.resolve("hitch.sqlite-original");
      renameSync(databasePath, replacementSource);
      writeFileSync(databasePath, readFileSync(replacementSource), { mode: 0o600 });
      assert.throws(() => database.transaction((transaction) => transaction.get("SELECT 1")), V2DataRootError);
    } finally {
      database.close();
    }
  });
});

test("explicit transactions commit, roll back, and reject nesting", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const database = V2Database.open({ dataRoot: disposable.resolve("state") });
    try {
      initializeTestSchema(database, "CREATE TABLE test_value (value INTEGER NOT NULL)");
      database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [1]));
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 1);
      assert.throws(
        () => database.transaction((transaction) => {
          transaction.run("INSERT INTO test_value VALUES (?)", [2]);
          database.transaction(() => undefined);
        }),
        NestedTransactionError,
      );
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 1);
      if (false) {
        // @ts-expect-error synchronous SQLite transaction callbacks reject Promise results
        database.transaction(async () => undefined);
      }
      assert.throws(
        () => database.transaction((() => Promise.resolve(undefined)) as unknown as () => never),
        AsyncTransactionWorkError,
      );
      const callableThenable = Object.assign(() => undefined, { then: () => undefined });
      assert.throws(
        () => database.transaction((() => callableThenable) as unknown as () => never),
        AsyncTransactionWorkError,
      );
      assert.throws(
        () => database.transaction(() => database.close()),
        ActiveTransactionCloseError,
      );
      assert.equal(database.isClosed, false);
      database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [3]));
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 2);
    } finally {
      database.close();
    }
  });
});

test("repository SQL capabilities cannot alter schema, transaction control, or required pragmas", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const database = V2Database.open({ dataRoot: disposable.resolve("state") });
    try {
      assert.equal("execute" in database, false);
      assert.equal("queryValue" in database, false);
      database.transaction((transaction) => {
        assert.throws(() => transaction.run("PRAGMA foreign_keys = OFF"), UnsafeSqlStatementError);
        assert.throws(() => transaction.run("BEGIN"), UnsafeSqlStatementError);
        assert.throws(() => transaction.run("CREATE TABLE forbidden (value INTEGER)"), UnsafeSqlStatementError);
        assert.throws(() => transaction.get("PRAGMA foreign_keys = OFF"), UnsafeSqlStatementError);
        assert.throws(
          () => transaction.get("WITH changed AS (DELETE FROM sqlite_master RETURNING name) SELECT * FROM changed"),
          UnsafeSqlStatementError,
        );
        assert.throws(() => transaction.get("SELECT 1; SELECT 2"), UnsafeSqlStatementError);
      });
      assert.equal(scalar(database, "PRAGMA foreign_keys"), 1);
    } finally {
      database.close();
    }
  });
});

test("trusted SQL permits keywords in quoted values and comments without permitting boundary bypass", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const database = V2Database.open({ dataRoot: disposable.resolve("state") });
    try {
      initializeTestSchema(
        database,
        "CREATE TABLE note (value TEXT NOT NULL CHECK(value <> 'BEGIN PRAGMA ROLLBACK')) /* ATTACH */",
      );
      database.transaction((transaction) => {
        assert.deepEqual(transaction.run("INSERT INTO note VALUES (?)", ["a -- COMMIT"]), {
          changes: 1,
          lastInsertRowid: 1,
        });
      });
      assert.equal(scalar(database, "/* DETACH */ SELECT value FROM note WHERE value = 'a -- COMMIT'"), "a -- COMMIT");
      assert.equal(scalar(database, "PRAGMA /* harmless comment */ foreign_keys"), 1);
      database.transaction((transaction) => {
        assert.throws(() => transaction.run("/* harmless */ PRAGMA foreign_keys = OFF"), UnsafeSqlStatementError);
        assert.throws(() => transaction.get("PRAGMA foreign_keys(0)"), UnsafeSqlStatementError);
        assert.throws(() => transaction.run("INSERT INTO note VALUES ('first'); DELETE FROM note"), UnsafeSqlStatementError);
        assert.throws(() => transaction.run("VACUUM"), UnsafeSqlStatementError);
        assert.throws(() => transaction.run("EXPLAIN PRAGMA foreign_keys = OFF"), UnsafeSqlStatementError);
        assert.throws(
          () => transaction.run("EXPLAIN QUERY PLAN ATTACH DATABASE 'outside.sqlite' AS outside"),
          UnsafeSqlStatementError,
        );
      });
    } finally {
      database.close();
    }
  });
});

test("bound repository capability scopes reads and writes to one explicit transaction", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const database = V2Database.open({ dataRoot: disposable.resolve("state") });
    try {
      initializeTestSchema(database, "CREATE TABLE repository_value (value INTEGER NOT NULL)");
      let retained: V2RepositoryTransaction | undefined;
      database.transaction((transaction) => {
        retained = transaction;
        assert.deepEqual(transaction.run("INSERT INTO repository_value VALUES (?)", [3]), {
          changes: 1,
          lastInsertRowid: 1,
        });
        assert.deepEqual(transaction.get("SELECT value FROM repository_value WHERE value = ?", [3]), { value: 3 });
        assert.deepEqual(transaction.all("SELECT value FROM repository_value WHERE value >= ?", [0]), [{ value: 3 }]);
        assert.throws(() => transaction.run("CREATE TABLE forbidden (value INTEGER NOT NULL)"), UnsafeSqlStatementError);
      });
      const captured = retained;
      if (captured === undefined) throw new Error("expected repository transaction capability");
      assert.throws(() => captured.run("INSERT INTO repository_value VALUES (?)", [4]), V2DataRootError);
      assert.equal(scalar(database, "SELECT count(*) FROM repository_value"), 1);
    } finally {
      database.close();
    }
  });
});

test("schema initialization is narrow, atomic, and limited to a pristine database", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const database = V2Database.open({ dataRoot: disposable.resolve("state") });
    try {
      assert.throws(
        () => database.initializePristineSchema((schema) => {
          schema.executeSchemaStatement("PRAGMA application_id = 123");
        }),
        UnsafeSqlStatementError,
      );
      let failedInitializer: { executeSchemaStatement(sql: string): void } | undefined;
      assert.throws(
        () => database.initializePristineSchema((schema) => {
          failedInitializer = schema;
          schema.executeSchemaStatement("CREATE TABLE should_rollback (value INTEGER NOT NULL)");
        }),
        V2DataRootError,
      );
      assert.equal(scalar(database, "SELECT name FROM sqlite_master WHERE name = 'should_rollback'"), undefined);
      const capturedFailedInitializer = failedInitializer;
      if (capturedFailedInitializer === undefined) throw new Error("expected a failed schema initializer");
      assert.throws(
        () => capturedFailedInitializer.executeSchemaStatement("CREATE TABLE escaped_initializer (value INTEGER NOT NULL)"),
        V2DataRootError,
      );
      assert.throws(
        () => database.initializePristineSchema((schema) => {
          schema.stampSchemaIdentity(24680, 1);
        }),
        V2DataRootError,
      );
      assert.equal(scalar(database, "PRAGMA application_id"), 0);
      assert.throws(
        () => database.initializePristineSchema((schema) => {
          schema.executeSchemaStatement("CREATE TABLE stamped_then_rolled_back (value INTEGER NOT NULL)");
          schema.stampSchemaIdentity(24680, 1);
          throw new Error("force rollback after stamp");
        }),
      );
      assert.equal(scalar(database, "PRAGMA application_id"), 0);
      assert.equal(scalar(database, "SELECT name FROM sqlite_master WHERE name = 'stamped_then_rolled_back'"), undefined);
      let retained: { queryRows(sql: string): readonly Readonly<Record<string, unknown>>[] } | undefined;
      database.initializePristineSchema((schema) => {
        retained = schema;
        assert.throws(() => database.transaction(() => undefined), V2DataRootError);
        assert.throws(() => database.close(), V2DataRootError);
        schema.executeSchemaStatement("CREATE TABLE schema_owned (value INTEGER NOT NULL)");
        schema.executeSchemaStatement("INSERT INTO schema_owned VALUES (7)");
        assert.deepEqual(schema.queryRows("SELECT value FROM schema_owned"), [{ value: 7 }]);
        schema.stampSchemaIdentity(24680, 1);
        assert.throws(() => schema.executeSchemaStatement("INSERT INTO schema_owned VALUES (8)"), V2DataRootError);
      });
      assert.equal(scalar(database, "PRAGMA application_id"), 24680);
      assert.equal(scalar(database, "PRAGMA user_version"), 1);
      const capturedInitializer = retained;
      if (capturedInitializer === undefined) throw new Error("expected a schema initializer");
      assert.throws(() => capturedInitializer.queryRows("SELECT value FROM schema_owned"), V2DataRootError);
      assert.throws(
        () => database.initializePristineSchema(() => undefined),
        V2DataRootError,
      );
    } finally {
      database.close();
    }
  });
});

test("existing unknown SQLite state is rejected before WAL configuration mutates it", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const prepared = prepareV2DataRoot(dataRoot);
    const raw = new DatabaseSync(prepared.databasePath);
    raw.exec("CREATE TABLE legacy_state (value INTEGER NOT NULL)");
    raw.close();
    chmodSync(prepared.databasePath, 0o600);
    const before = readFileSync(prepared.databasePath);
    assert.equal(existsSync(`${prepared.databasePath}-wal`), false);
    assert.equal(existsSync(`${prepared.databasePath}-shm`), false);
    assert.throws(() => V2Database.open({ dataRoot }), V2DataRootError);
    assert.deepEqual(readFileSync(prepared.databasePath), before);
    assert.equal(existsSync(`${prepared.databasePath}-wal`), false);
    assert.equal(existsSync(`${prepared.databasePath}-shm`), false);
  });
});

test("a hot rollback journal is rejected through isolated inspection without mutation", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const prepared = prepareV2DataRoot(dataRoot);
    writeFileSync(prepared.databasePath, Buffer.alloc(0), { mode: 0o600 });
    const child = spawnSync(process.execPath, ["--eval", `
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(process.argv[1]);
      database.exec("PRAGMA journal_mode = DELETE");
      database.exec("CREATE TABLE legacy_value (value INTEGER NOT NULL)");
      database.exec("BEGIN IMMEDIATE");
      database.exec("INSERT INTO legacy_value VALUES (1)");
      process.abort();
    `, prepared.databasePath], { encoding: "utf8" });
    assert.notEqual(child.status, 0);
    const journalPath = `${prepared.databasePath}-journal`;
    assert.equal(existsSync(journalPath), true);
    chmodSync(journalPath, 0o600);
    const databaseBefore = readFileSync(prepared.databasePath);
    const journalBefore = readFileSync(journalPath);
    assert.ok(journalBefore.byteLength > 0);
    assert.throws(() => V2Database.open({ dataRoot }), V2DataRootError);
    assert.deepEqual(readFileSync(prepared.databasePath), databaseBefore);
    assert.deepEqual(readFileSync(journalPath), journalBefore);
  });
});

test("unknown WAL state cannot create missing shared memory during validation", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const prepared = prepareV2DataRoot(dataRoot);
    const { walPath, shmPath } = createCrashedUnknownWalDatabase(
      prepared.databasePath,
    );
    unlinkSync(shmPath);
    const databaseBefore = readFileSync(prepared.databasePath);
    const walBefore = readFileSync(walPath);
    assert.throws(() => V2Database.open({ dataRoot }), V2DataRootError);
    assert.deepEqual(readFileSync(prepared.databasePath), databaseBefore);
    assert.deepEqual(readFileSync(walPath), walBefore);
    assert.equal(existsSync(shmPath), false);
    assert.deepEqual(
      readdirSync(dataRoot).filter((entry) =>
        entry.startsWith(".hitch-v2-database-inspection-"),
      ),
      [],
    );
  });
});

test("unknown WAL validation cannot rewrite existing shared memory", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const prepared = prepareV2DataRoot(dataRoot);
    const { walPath, shmPath } = createCrashedUnknownWalDatabase(
      prepared.databasePath,
    );
    const databaseBefore = readFileSync(prepared.databasePath);
    const walBefore = readFileSync(walPath);
    const shmBefore = readFileSync(shmPath);
    assert.throws(() => V2Database.open({ dataRoot }), V2DataRootError);
    assert.deepEqual(readFileSync(prepared.databasePath), databaseBefore);
    assert.deepEqual(readFileSync(walPath), walBefore);
    assert.deepEqual(readFileSync(shmPath), shmBefore);
    assert.deepEqual(
      readdirSync(dataRoot).filter((entry) =>
        entry.startsWith(".hitch-v2-database-inspection-"),
      ),
      [],
    );
  });
});

test("startup recovers an exactly marked inspection abandoned by process death", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const first = V2Database.open({ dataRoot });
    initializeTestSchema(
      first,
      "CREATE TABLE retained_value (value TEXT NOT NULL)",
    );
    first.transaction((transaction) => {
      transaction.run("INSERT INTO retained_value VALUES (?)", [
        "sensitive retained content",
      ]);
    });
    first.close();

    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import { V2Database } from "./src/v2/persistence/database.ts";
        V2Database.open({
          dataRoot: process.argv[1],
          validateExistingDatabase: () => process.abort(),
        });
      `,
      dataRoot,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(child.status, 0);
    const abandoned = readdirSync(dataRoot).filter((entry) =>
      entry.startsWith(".hitch-v2-database-inspection-"),
    );
    assert.equal(abandoned.length, 1);
    const abandonedPath = join(dataRoot, abandoned[0]!);
    assert.equal(lstatSync(abandonedPath).mode & 0o077, 0);
    assert.equal(
      lstatSync(join(abandonedPath, V2_DATABASE_FILENAME)).mode & 0o077,
      0,
    );

    const recovered = V2Database.open({
      dataRoot,
      validateExistingDatabase: (inspection) => {
        assert.equal(inspection.applicationId, 24680);
        assert.equal(inspection.userVersion, 1);
      },
    });
    recovered.close();
    assert.deepEqual(
      readdirSync(dataRoot).filter((entry) =>
        entry.startsWith(".hitch-v2-database-inspection-"),
      ),
      [],
    );
  });
});

test("live-root revalidation runs after the final callback statement and before COMMIT", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const movedRoot = disposable.resolve("state-before-commit");
    const database = V2Database.open({ dataRoot });
    try {
      initializeTestSchema(database, "CREATE TABLE commit_fence (value INTEGER NOT NULL)");
      assert.throws(() => database.transaction((transaction) => {
        transaction.run("INSERT INTO commit_fence VALUES (?)", [1]);
        renameSync(dataRoot, movedRoot);
      }), V2DataRootError);
    } finally {
      database.close();
    }
    renameSync(movedRoot, dataRoot);
    const raw = new DatabaseSync(join(dataRoot, V2_DATABASE_FILENAME));
    try {
      const row = raw.prepare("SELECT count(*) AS count FROM commit_fence").get();
      assert.equal((row as { count: number } | undefined)?.count, 0);
    } finally {
      raw.close();
    }
  });
});

test("a schema owner can explicitly validate accepted existing state before configuration", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const dataRoot = disposable.resolve("state");
    const first = V2Database.open({ dataRoot });
    first.initializePristineSchema((schema) => {
      schema.executeSchemaStatement("CREATE TABLE schema_owned (value INTEGER NOT NULL)");
      schema.stampSchemaIdentity(24680, 1);
    });
    first.close();
    let retainedValidation: { queryRows(sql: string): readonly Readonly<Record<string, unknown>>[] } | undefined;
    const reopened = V2Database.open({
      dataRoot,
      validateExistingDatabase: (inspection) => {
        assert.equal(inspection.applicationId, 24680);
        assert.equal(inspection.userVersion, 1);
        assert.deepEqual(inspection.schemaObjects, [{
          type: "table",
          name: "schema_owned",
          tableName: "schema_owned",
          sql: "CREATE TABLE schema_owned (value INTEGER NOT NULL)",
        }]);
        assert.deepEqual(inspection.queryRows("SELECT count(*) AS count FROM schema_owned"), [{ count: 0 }]);
        retainedValidation = inspection;
      },
    });
    reopened.close();
    const capturedValidation = retainedValidation;
    if (capturedValidation === undefined) throw new Error("expected existing-schema validator");
    assert.throws(() => capturedValidation.queryRows("SELECT 1"), V2DataRootError);
    assert.throws(
      () =>
        V2Database.open({
          dataRoot,
          validateExistingDatabase: (() =>
            Promise.resolve()) as unknown as () => void,
        }),
      V2DataRootError,
    );
  });
});

test("an actual rollback failure poisons the runner while hook observations do not", () => {
  const rollbackFailure = new Error("simulated rollback I/O failure");
  const executed: string[] = [];
  const failingDatabase = {
    exec(sql: string): void {
      executed.push(sql);
      if (sql === "ROLLBACK") throw rollbackFailure;
    },
  };
  const runner = new ExplicitTransactionRunner(failingDatabase as never);
  assert.throws(
    () => runner.run(() => { throw new Error("work failed"); }),
    (error: unknown) => error instanceof TransactionRollbackFailedError && error.cause instanceof AggregateError,
  );
  assert.deepEqual(executed, ["BEGIN IMMEDIATE", "ROLLBACK"]);
  assert.equal(runner.isPoisoned, true);
  assert.throws(() => runner.run(() => undefined), TransactionConnectionPoisonedError);

  const faults = new DeterministicTransactionFaults();
  const usableDatabase = { exec(): void {} };
  const observedRunner = new ExplicitTransactionRunner(usableDatabase as never, faults);
  faults.failNext("before-rollback");
  assert.throws(() => observedRunner.run(() => { throw new Error("work failed"); }), AggregateError);
  assert.equal(observedRunner.isPoisoned, false);
  observedRunner.run(() => undefined);
});

test("deterministic transaction faults preserve the correct boundary outcome", async () => {
  await withDisposableDataRoot(async (disposable) => {
    const faults = new DeterministicTransactionFaults();
    const database = V2Database.open({ dataRoot: disposable.resolve("state"), transactionFaults: faults });
    try {
      initializeTestSchema(database, "CREATE TABLE test_value (value INTEGER NOT NULL)");
      faults.failNext("before-begin");
      assert.throws(
        () => database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [0])),
        (error: unknown) => error instanceof TransactionBoundaryFaultError && error.boundary === "before-begin",
      );
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 0);
      faults.failNext("before-commit");
      assert.throws(
        () => database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [1])),
        (error: unknown) => error instanceof TransactionBoundaryFaultError && error.boundary === "before-commit",
      );
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 0);
      faults.failNext("after-commit");
      assert.throws(
        () => database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [2])),
        (error: unknown) => error instanceof TransactionBoundaryFaultError && error.boundary === "after-commit",
      );
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 1);
      faults.failNext("after-begin");
      assert.throws(
        () => database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [3])),
        (error: unknown) => error instanceof TransactionBoundaryFaultError && error.boundary === "after-begin",
      );
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 1);
      faults.failNext("before-rollback");
      assert.throws(
        () => database.transaction(() => {
          throw new Error("force rollback");
        }),
        AggregateError,
      );
      database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [4]));
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 2);
      faults.failNext("after-rollback");
      assert.throws(
        () => database.transaction(() => {
          throw new Error("force rollback after boundary");
        }),
        AggregateError,
      );
      database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [5]));
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 3);
    } finally {
      database.close();
    }
  });
});

scenarioCase({
  scenarioId: "V2-S01",
  caseId: "database-root-creation",
  title: "database root creates one marked empty SQLite installation",
  run: async () => withDisposableDataRoot(async (disposable) => {
    const database = V2Database.open({ dataRoot: disposable.resolve("state") });
    try {
      assert.equal(scalar(database, "PRAGMA application_id"), 0);
    } finally {
      database.close();
    }
  }),
});

scenarioCase({
  scenarioId: "V2-S18",
  caseId: "transaction-boundary-recovery",
  title: "committed and rolled-back transaction boundaries remain distinguishable",
  run: async () => withDisposableDataRoot(async (disposable) => {
    const faults = new DeterministicTransactionFaults();
    const database = V2Database.open({ dataRoot: disposable.resolve("state"), transactionFaults: faults });
    try {
      initializeTestSchema(database, "CREATE TABLE test_value (value INTEGER NOT NULL)");
      faults.failNext("before-commit");
      assert.throws(() =>
        database.transaction((transaction) => transaction.run("INSERT INTO test_value VALUES (?)", [1])),
      );
      assert.equal(scalar(database, "SELECT count(*) FROM test_value"), 0);
    } finally {
      database.close();
    }
  }),
});

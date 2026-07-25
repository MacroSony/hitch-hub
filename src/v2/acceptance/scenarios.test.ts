import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

import { DeterministicTestAccounting } from "./test-accounting.js";
import {
  ScenarioCaseRegistry,
  V2_ACCEPTANCE_SCENARIOS,
} from "./scenarios.js";

test("canonical v2 scenario registry is complete, unique, and ordered", () => {
  assert.equal(V2_ACCEPTANCE_SCENARIOS.length, 21);
  assert.deepEqual(
    V2_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.number),
    Array.from({ length: 21 }, (_unused, index) => index + 1),
  );
  assert.deepEqual(
    V2_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id),
    Array.from(
      { length: 21 },
      (_unused, index) => `V2-S${(index + 1).toString().padStart(2, "0")}`,
    ),
  );
  assert.equal(
    new Set(V2_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id)).size,
    21,
  );
  for (const scenario of V2_ACCEPTANCE_SCENARIOS) {
    assert.ok(scenario.description.length > 20);
  }
});

test("new scenario registry reports honest unimplemented coverage", () => {
  const registry = new ScenarioCaseRegistry();

  assert.deepEqual(
    registry.coverage().map((coverage) => coverage.status),
    Array.from({ length: 21 }, () => "unimplemented"),
  );
  assert.deepEqual(registry.registrations(), []);
});

test("incremental scenario cases become in-progress and reject duplicates", () => {
  const registry = new ScenarioCaseRegistry();
  const registration = {
    scenarioId: "V2-S01" as const,
    caseId: "bootstrap-idempotency",
    title: "bootstrap publication is idempotent",
    run: () => {},
  };

  registry.register(registration);
  assert.equal(registry.coverage()[0]?.status, "in-progress");
  assert.deepEqual(registry.coverage()[0]?.registeredCaseIds, [
    "bootstrap-idempotency",
  ]);
  assert.throws(() => registry.register(registration), /duplicate/u);
});

test("isolated TAP accounting rejects duplicate and non-executed cases", () => {
  const accounting = new DeterministicTestAccounting();
  accounting.observeTapLine(
    "    # Subtest: [V2-S01/bootstrap-idempotency] first",
  );
  accounting.observeTapLine(
    "    # Subtest: [V2-S01/bootstrap-idempotency] duplicate",
  );
  accounting.observeTapLine("# skipped 1");

  assert.throws(
    () => accounting.assertAcceptable(),
    /duplicate scenario cases.*forbidden non-executed outcomes/u,
  );
});

test("TAP accounting ignores TODO and SKIP text in ordinary titles", () => {
  const accounting = new DeterministicTestAccounting();
  accounting.observeTapLine("# Subtest: explains # TODO without skipping");
  accounting.observeTapLine("# Subtest: explains # SKIP without skipping");
  accounting.observeTapLine("# cancelled 0");
  accounting.observeTapLine("# skipped 0");
  accounting.observeTapLine("# todo 0");

  assert.doesNotThrow(() => accounting.assertAcceptable());
});

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test-support" || entry.name === "acceptance") {
          return [];
        }
        return sourceFiles(path);
      }
      if (entry.name.endsWith(".test.ts")) {
        return [];
      }
      return extname(entry.name) === ".ts" ? [path] : [];
    }),
  );
  return nested.flat();
}

function importsTestSupport(source: string, filename: string): boolean {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;

  function inspect(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("test-support")
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [specifier] = node.arguments;
      if (
        specifier !== undefined &&
        ts.isStringLiteralLike(specifier) &&
        specifier.text.includes("test-support")
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, inspect);
  }

  inspect(sourceFile);
  return found;
}

test("production v2 sources never import test support", async () => {
  const v2Root = fileURLToPath(new URL("../", import.meta.url));
  const files = await sourceFiles(v2Root);

  for (const forbiddenSource of [
    'import "../test-support/index.js";',
    'import("../test-support/index.js");',
    'export { DeterministicClock } from "../test-support/index.js";',
  ]) {
    assert.equal(importsTestSupport(forbiddenSource, "forbidden.ts"), true);
  }

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.equal(
      importsTestSupport(contents, file),
      false,
      `${file} imports v2 test support`,
    );
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MvpScenarioCaseRegistry,
  V2_MVP_ACCEPTANCE_SCENARIOS,
} from "./mvp-scenarios.js";

test("focused multi-user MVP registry is complete, unique, and ordered", () => {
  assert.equal(V2_MVP_ACCEPTANCE_SCENARIOS.length, 10);
  assert.deepEqual(
    V2_MVP_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.number),
    Array.from({ length: 10 }, (_unused, index) => index + 1),
  );
  assert.deepEqual(
    V2_MVP_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id),
    Array.from(
      { length: 10 },
      (_unused, index) =>
        `V2-MVP-S${(index + 1).toString().padStart(2, "0")}`,
    ),
  );
  assert.equal(
    new Set(
      V2_MVP_ACCEPTANCE_SCENARIOS.map((scenario) => scenario.id),
    ).size,
    10,
  );
  for (const scenario of V2_MVP_ACCEPTANCE_SCENARIOS) {
    assert.ok(scenario.description.length > 20);
  }
});

test("focused MVP registry reports honest incremental coverage", () => {
  const registry = new MvpScenarioCaseRegistry();
  assert.deepEqual(
    registry.coverage().map((coverage) => coverage.status),
    Array.from({ length: 10 }, () => "unimplemented"),
  );

  const registration = {
    scenarioId: "V2-MVP-S01" as const,
    caseId: "certificate-binding",
    title: "certificate identity is immutable",
    run: () => {},
  };
  registry.register(registration);
  assert.equal(registry.coverage()[0]?.status, "in-progress");
  assert.deepEqual(registry.coverage()[0]?.registeredCaseIds, [
    "certificate-binding",
  ]);
  assert.throws(() => registry.register(registration), /duplicate/u);
});

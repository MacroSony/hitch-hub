import { test } from "node:test";

import {
  ScenarioCaseRegistry,
  type ScenarioCaseRegistration,
} from "./scenarios.js";

const v2ScenarioCases = new ScenarioCaseRegistry();

/**
 * Later tasks use this wrapper from their discovered `*.test.ts` module. It
 * records incremental coverage and delegates execution to Node's test runner.
 */
export function scenarioCase(registration: ScenarioCaseRegistration): void {
  v2ScenarioCases.register(registration);
  test(
    `[${registration.scenarioId}/${registration.caseId}] ${registration.title}`,
    registration.run,
  );
}

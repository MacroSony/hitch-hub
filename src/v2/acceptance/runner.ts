import { test } from "node:test";

import {
  ScenarioCaseRegistry,
  type ScenarioCaseRegistration,
} from "./scenarios.js";
import {
  MvpScenarioCaseRegistry,
  type MvpScenarioCaseRegistration,
} from "./mvp-scenarios.js";

const v2ScenarioCases = new ScenarioCaseRegistry();
const v2MvpScenarioCases = new MvpScenarioCaseRegistry();

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

/** Registers focused evidence against the current multi-user MVP gate. */
export function mvpScenarioCase(
  registration: MvpScenarioCaseRegistration,
): void {
  v2MvpScenarioCases.register(registration);
  test(
    `[${registration.scenarioId}/${registration.caseId}] ${registration.title}`,
    registration.run,
  );
}

const SCENARIO_SUBTEST =
  /^\s*# Subtest: \[(V2-(?:S(?:0[1-9]|1[0-9]|2[01])|MVP-S(?:0[1-9]|10)))\/([a-z0-9][a-z0-9-]*)\]/u;
const FORBIDDEN_SUMMARY = /^\s*# (cancelled|skipped|todo) ([0-9]+)\s*$/u;

/**
 * Parent-process accounting for isolated Node test files. TAP observation
 * preserves process isolation while still enforcing globally unique scenario
 * case keys and rejecting non-executed outcomes.
 */
export class DeterministicTestAccounting {
  readonly #scenarioCases = new Set<string>();
  readonly #duplicateScenarioCases = new Set<string>();
  readonly #forbiddenOutcomes = new Set<string>();

  observeTapLine(line: string): void {
    const scenarioMatch = SCENARIO_SUBTEST.exec(line);
    if (scenarioMatch !== null) {
      const key = `${scenarioMatch[1]}/${scenarioMatch[2]}`;
      if (this.#scenarioCases.has(key)) {
        this.#duplicateScenarioCases.add(key);
      }
      this.#scenarioCases.add(key);
    }

    const summaryMatch = FORBIDDEN_SUMMARY.exec(line);
    if (summaryMatch !== null && Number(summaryMatch[2]) > 0) {
      this.#forbiddenOutcomes.add(summaryMatch[1] ?? "unknown");
    }
  }

  assertAcceptable(): void {
    const issues: string[] = [];
    if (this.#duplicateScenarioCases.size > 0) {
      issues.push(
        `duplicate scenario cases: ${[...this.#duplicateScenarioCases].sort().join(", ")}`,
      );
    }
    if (this.#forbiddenOutcomes.size > 0) {
      issues.push(
        `forbidden non-executed outcomes: ${[...this.#forbiddenOutcomes].sort().join(", ")}`,
      );
    }
    if (issues.length > 0) {
      throw new Error(`v2 deterministic test accounting failed: ${issues.join("; ")}`);
    }
  }
}

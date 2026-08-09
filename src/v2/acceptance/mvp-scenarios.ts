export const V2_MVP_ACCEPTANCE_SCENARIOS = [
  {
    id: "V2-MVP-S01",
    number: 1,
    description:
      "A verified client certificate resolves only its immutable principal binding and protocol data cannot select another identity.",
  },
  {
    id: "V2-MVP-S02",
    number: 2,
    description:
      "Principal A cannot enumerate, create under, prompt, read, cancel, or receive sessions or Turns owned by principal B.",
  },
  {
    id: "V2-MVP-S03",
    number: 3,
    description:
      "Administrator containment of another principal reveals no prompt, result, workspace content, or other owner-private data.",
  },
  {
    id: "V2-MVP-S04",
    number: 4,
    description:
      "Revoked bindings and disabled principals deny admission, dispatch, and result access at every required live boundary.",
  },
  {
    id: "V2-MVP-S05",
    number: 5,
    description:
      "A worker cannot mount, read, or mutate another principal's workspace, data root, configuration, or runtime state.",
  },
  {
    id: "V2-MVP-S06",
    number: 6,
    description:
      "Model tools remain inside the exact workspace without shell, network, process, credential, database, mount, or extension authority.",
  },
  {
    id: "V2-MVP-S07",
    number: 7,
    description:
      "Per-principal and installation-wide concurrency, queue, token, process, memory, storage, time, and output ceilings fail closed.",
  },
  {
    id: "V2-MVP-S08",
    number: 8,
    description:
      "One broker authorization cannot invoke the provider twice and uncertain submission is never replayed automatically after restart.",
  },
  {
    id: "V2-MVP-S09",
    number: 9,
    description:
      "Cancellation and completion remove the complete worker process tree and revoke every associated sidecar authority.",
  },
  {
    id: "V2-MVP-S10",
    number: 10,
    description:
      "A two-principal end-to-end run returns one real sandboxed terminal Turn only to its owner and exposes no owner artifact to the other principal.",
  },
] as const;

export type V2MvpAcceptanceScenario =
  (typeof V2_MVP_ACCEPTANCE_SCENARIOS)[number];
export type V2MvpScenarioId = V2MvpAcceptanceScenario["id"];

export interface MvpScenarioCaseRegistration {
  readonly scenarioId: V2MvpScenarioId;
  /** Stable task-owned case key, unique within the scenario. */
  readonly caseId: string;
  readonly title: string;
  readonly run: () => Promise<void> | void;
}

export interface MvpScenarioCoverage {
  readonly scenario: V2MvpAcceptanceScenario;
  readonly status: "unimplemented" | "in-progress";
  readonly registeredCaseIds: readonly string[];
}

/**
 * Focused private-alpha registry. Cases record incremental evidence only;
 * completion remains the V2-M07 two-principal production gate.
 */
export class MvpScenarioCaseRegistry {
  readonly #registrations = new Map<
    V2MvpScenarioId,
    Map<string, MvpScenarioCaseRegistration>
  >();

  register(registration: MvpScenarioCaseRegistration): void {
    if (
      !V2_MVP_ACCEPTANCE_SCENARIOS.some(
        (scenario) => scenario.id === registration.scenarioId,
      )
    ) {
      throw new TypeError(
        `unknown v2 MVP scenario: ${registration.scenarioId}`,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(registration.caseId)) {
      throw new TypeError(
        "MVP scenario case ID must be lowercase alphanumeric with hyphens",
      );
    }
    if (registration.title.trim().length === 0) {
      throw new TypeError("MVP scenario case title must not be empty");
    }

    const cases =
      this.#registrations.get(registration.scenarioId) ??
      new Map<string, MvpScenarioCaseRegistration>();
    if (cases.has(registration.caseId)) {
      throw new Error(
        `duplicate v2 MVP scenario case: ${registration.scenarioId}/${registration.caseId}`,
      );
    }
    cases.set(registration.caseId, registration);
    this.#registrations.set(registration.scenarioId, cases);
  }

  registrations(): readonly MvpScenarioCaseRegistration[] {
    return V2_MVP_ACCEPTANCE_SCENARIOS.flatMap((scenario) => [
      ...(this.#registrations.get(scenario.id)?.values() ?? []),
    ]);
  }

  coverage(): readonly MvpScenarioCoverage[] {
    return V2_MVP_ACCEPTANCE_SCENARIOS.map((scenario) => {
      const registeredCaseIds = [
        ...(this.#registrations.get(scenario.id)?.keys() ?? []),
      ];
      return {
        scenario,
        status:
          registeredCaseIds.length === 0 ? "unimplemented" : "in-progress",
        registeredCaseIds,
      };
    });
  }
}

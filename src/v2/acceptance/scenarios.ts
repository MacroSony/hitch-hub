export const V2_ACCEPTANCE_SCENARIOS = [
  {
    id: "V2-S01",
    number: 1,
    description:
      "Bootstrap creates one owner and deterministic configuration resources without duplicating unchanged revisions.",
  },
  {
    id: "V2-S02",
    number: 2,
    description:
      "A caller cannot select or forge a principal, endpoint owner, grant, SessionSpec, Turn origin, or authorization result.",
  },
  {
    id: "V2-S03",
    number: 3,
    description:
      "Session creation pins exact revisions and rejects a missing/revoked use grant.",
  },
  {
    id: "V2-S04",
    number: 4,
    description:
      "Duplicate prompt submission returns the original Turn receipt and queue position.",
  },
  {
    id: "V2-S05",
    number: 5,
    description:
      "One active Turn and three pending Turns are accepted; a fourth pending Turn is rejected without reaching the driver.",
  },
  {
    id: "V2-S06",
    number: 6,
    description:
      "Requester cancellation wins only while the named queued Turn remains pending, and active cancellation follows the bounded cleanup path.",
  },
  {
    id: "V2-S07",
    number: 7,
    description:
      "Queue dispatch reauthorizes the requester, origin binding, configuration grants, provider connection/credential custody binding, and installation ceilings.",
  },
  {
    id: "V2-S08",
    number: 8,
    description:
      "Submission arming, protocol prompt submission, acceptance evidence, worker loss, exact reconciliation, and unknown recovery follow the accepted state machine using the same durable dispatch-attempt ID and without heuristic replay.",
  },
  {
    id: "V2-S09",
    number: 9,
    description:
      "Invalid, uncorrelated, stale-fence, secret-bearing, or oversized driver events are rejected or sanitized before becoming Hitch events.",
  },
  {
    id: "V2-S10",
    number: 10,
    description:
      "Event visibility and durability are derived by trusted Hitch code, not selected by the driver.",
  },
  {
    id: "V2-S11",
    number: 11,
    description:
      "A safe allow-once/deny-once interaction works; persistent or ambiguous agent options cannot be selected.",
  },
  {
    id: "V2-S12",
    number: 12,
    description:
      "The image attachment is copied into private storage, size/MIME validated, hash recorded, checked against the exact model MIME/per-request byte/count limits and the one-new-image-per-Turn limit, and supplied to Pi without exposing the source host path. Accumulated image history over the manifest limit fails before native sidecar invocation until pruning/compaction semantics exist.",
  },
  {
    id: "V2-S13",
    number: 13,
    description:
      "The secure Pi sandbox exposes the intended workspace, pinned resources, and tools while blocking host, Hitch-state, symlink-swap, protected-destination, shell, resource-discovery, and ungranted-extension escape attempts.",
  },
  {
    id: "V2-S14",
    number: 14,
    description:
      "The upstream credential and real Pi auth store are absent from the sandbox, a valid broker capability is restricted to the active worker, connection, and Turn, and stale, idle, queued, waiting, cancelling, and terminal requests fail.",
  },
  {
    id: "V2-S15",
    number: 15,
    description:
      "Concurrent inference reservations cannot exceed request/token ceilings; missing usage is conservatively charged, a forward authorization cannot be replayed into a second native invocation/upstream send, the sidecar cannot egress outside registered origins, and old-Turn requests drain or abort before handoff.",
  },
  {
    id: "V2-S16",
    number: 16,
    description:
      "A finalized result remains queryable when the originating CLI disconnects or delivery fails.",
  },
  {
    id: "V2-S17",
    number: 17,
    description:
      "Delivery rechecks the private endpoint binding and current recipient authority without rewriting the terminal Turn result.",
  },
  {
    id: "V2-S18",
    number: 18,
    description:
      "Restart and forced worker-loss tests leave one explainable durable state, never two workers or a silently replayed Turn.",
  },
  {
    id: "V2-S19",
    number: 19,
    description:
      "Audit records contain actor, session, Turn, lease, interaction, reservation, and delivery correlation without raw secrets, prompt bodies in operational envelopes, raw reasoning, or raw tool input/output.",
  },
  {
    id: "V2-S20",
    number: 20,
    description:
      "The version-pinned Pi bridge represents streaming, reasoning, tools, images where supported, usage, errors, cancellation, and OAuth refresh; mismatched native-stack/catalog revisions fail closed.",
  },
  {
    id: "V2-S21",
    number: 21,
    description:
      "Opt-in DeepSeek and OpenAI Codex smoke calls pass through the same native sidecar and sandbox boundary after deterministic provider-stub tests pass.",
  },
] as const;

export type V2AcceptanceScenario = (typeof V2_ACCEPTANCE_SCENARIOS)[number];
export type V2ScenarioId = V2AcceptanceScenario["id"];
export type V2ScenarioNumber = V2AcceptanceScenario["number"];

export interface ScenarioCaseRegistration {
  readonly scenarioId: V2ScenarioId;
  /** Stable task-owned case key, unique within the scenario. */
  readonly caseId: string;
  readonly title: string;
  readonly run: () => Promise<void> | void;
}

export interface ScenarioCoverage {
  readonly scenario: V2AcceptanceScenario;
  readonly status: "unimplemented" | "in-progress";
  readonly registeredCaseIds: readonly string[];
}

/**
 * Incremental case registry. Registering a case marks a scenario in-progress,
 * never complete; the canonical acceptance claim remains a V2-015 decision.
 */
export class ScenarioCaseRegistry {
  readonly #registrations = new Map<
    V2ScenarioId,
    Map<string, ScenarioCaseRegistration>
  >();

  register(registration: ScenarioCaseRegistration): void {
    if (
      !V2_ACCEPTANCE_SCENARIOS.some(
        (scenario) => scenario.id === registration.scenarioId,
      )
    ) {
      throw new TypeError(`unknown v2 scenario: ${registration.scenarioId}`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(registration.caseId)) {
      throw new TypeError(
        "scenario case ID must be lowercase alphanumeric with hyphens",
      );
    }
    if (registration.title.trim().length === 0) {
      throw new TypeError("scenario case title must not be empty");
    }

    const cases =
      this.#registrations.get(registration.scenarioId) ??
      new Map<string, ScenarioCaseRegistration>();
    if (cases.has(registration.caseId)) {
      throw new Error(
        `duplicate v2 scenario case: ${registration.scenarioId}/${registration.caseId}`,
      );
    }
    cases.set(registration.caseId, registration);
    this.#registrations.set(registration.scenarioId, cases);
  }

  registrations(): readonly ScenarioCaseRegistration[] {
    return V2_ACCEPTANCE_SCENARIOS.flatMap((scenario) => [
      ...(this.#registrations.get(scenario.id)?.values() ?? []),
    ]);
  }

  coverage(): readonly ScenarioCoverage[] {
    return V2_ACCEPTANCE_SCENARIOS.map((scenario) => {
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

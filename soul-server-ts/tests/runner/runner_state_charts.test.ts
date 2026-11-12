import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  RUNNER_DECISION_LABELS,
  RUNNER_DISPOSITION_LABELS,
  RUNNER_PRECEDENCE_LABELS,
  RUNNER_STEP_LABELS,
  generateRunnerStateDocument,
  runnerLifecycleDecisionTable,
  runnerRecoveryDecisionTable,
} from "../../src/runner/state/runner_charts.js";
import {
  RUNNER_LIFECYCLE_STATES,
  RUNNER_LIFECYCLE_STEPS,
} from "../../src/runner/state/runner_lifecycle_machine.js";
import {
  RUNNER_RECOVERY_DISPOSITIONS,
  type RunnerRecoveryFacts,
} from "../../src/runner/state/runner_recovery_machine.js";
import { decideRunnerRecovery } from "../../src/runner/state/runner_recovery_decision.js";

function recovery(facts: Partial<RunnerRecoveryFacts>): string {
  return decideRunnerRecovery({
    retired: false,
    lifecycle: "none",
    pidAlive: false,
    bootstrapLeaseElapsed: false,
    ...facts,
  });
}

describe("runner state charts", () => {
  it("decides every lifecycle state, step, and command match combination", () => {
    const rows = runnerLifecycleDecisionTable();

    expect(rows).toHaveLength(
      RUNNER_LIFECYCLE_STATES.length * RUNNER_LIFECYCLE_STEPS.length * 2,
    );
    expect(new Set(rows.map(
      (row) => `${row.state}/${row.step}/${row.commandMatches}`,
    )).size).toBe(rows.length);
    for (const row of rows) {
      expect(
        Object.keys(RUNNER_DECISION_LABELS),
        `${row.state}/${row.step}/${row.commandMatches}`,
      ).toContain(row.decision);
    }
    expect(rows.map((row) => row.decision)).not.toContain(undefined);
  });

  it("keeps begin universal and every other step gated on running with a matching command", () => {
    for (const row of runnerLifecycleDecisionTable()) {
      if (row.step === "begin") {
        expect(row.decision).toBe("apply");
        continue;
      }
      if (row.state === "none") {
        expect(row.decision).toBe("reject");
        continue;
      }
      if (row.state !== "running") {
        const lateFinish = (row.state === "closed" || row.state === "reaped")
          && row.step.startsWith("finish_");
        expect(row.decision).toBe(lateFinish && row.commandMatches ? "ignore" : "reject");
        continue;
      }
      expect(row.decision).toBe(row.commandMatches ? "apply" : "reject");
    }
  });

  it("decides every recovery input combination", () => {
    const rows = runnerRecoveryDecisionTable();

    expect(rows).toHaveLength(
      2 * RUNNER_LIFECYCLE_STATES.length * 2 * 2,
    );
    expect(new Set(rows.map(
      (row) => `${row.retired}/${row.lifecycle}/${row.pidAlive}/${row.bootstrapLeaseElapsed}`,
    )).size).toBe(rows.length);
    for (const row of rows) {
      expect(
        Object.keys(RUNNER_DISPOSITION_LABELS),
        `${row.retired}/${row.lifecycle}/${row.pidAlive}/${row.bootstrapLeaseElapsed}`,
      ).toContain(row.disposition);
    }
  });

  it("keeps the recovery decision order from retired to running", () => {
    expect(recovery({ retired: true, lifecycle: "running", pidAlive: true }))
      .toBe("retired_terminal");
    expect(recovery({ lifecycle: "reaped", pidAlive: true })).toBe("already_reaped");
    expect(recovery({ lifecycle: "closed", pidAlive: true })).toBe("closed");
    expect(recovery({ pidAlive: true })).toBe("adopt_prebootstrap");
    expect(recovery({ pidAlive: true, bootstrapLeaseElapsed: true }))
      .toBe("adopt_prebootstrap");
    expect(recovery({ bootstrapLeaseElapsed: true })).toBe("reap_dead");
    expect(recovery({})).toBe("wait_for_bootstrap");
    for (const lifecycle of ["completed", "failed"] as const) {
      expect(recovery({ lifecycle, pidAlive: true })).toBe("replay_terminal");
      expect(recovery({ lifecycle, pidAlive: false })).toBe("replay_terminal_dead");
    }
    expect(recovery({ lifecycle: "running", pidAlive: true })).toBe("adopt_running");
    expect(recovery({ lifecycle: "running", pidAlive: false })).toBe("reap_dead");
    expect([...RUNNER_RECOVERY_DISPOSITIONS].sort()).toEqual(
      [...new Set(runnerRecoveryDecisionTable().map((row) => row.disposition))].sort(),
    );
  });

  it("uses plain labels for every table row", () => {
    for (const state of RUNNER_LIFECYCLE_STATES) {
      expect(RUNNER_PRECEDENCE_LABELS[state]).toBeTruthy();
    }
    for (const step of RUNNER_LIFECYCLE_STEPS) {
      expect(RUNNER_STEP_LABELS[step]).toBeTruthy();
    }
  });

  it("regenerates the committed document and charts without a diff", async () => {
    const result = generateRunnerStateDocument();

    expect(result.markdown).toBe(await readFile(
      new URL("../../../docs/runners/runner-state.md", import.meta.url),
      "utf8",
    ));
    for (const chart of result.charts) {
      expect(chart.warnings).toEqual([]);
      expect(`${chart.mermaid}\n`).toBe(await readFile(
        new URL(`../../../docs/runners/generated/${chart.id}.mmd`, import.meta.url),
        "utf8",
      ));
    }
    expect(result.markdown).toContain("수명 기록 결정표");
    expect(result.markdown).toContain("복구 가름 결정표");
    expect(result.markdown).toContain(
      "corepack pnpm@10.32.1 --dir soul-server-ts exec tsx scripts/runner-state-charts.ts",
    );
  }, 300_000);
});

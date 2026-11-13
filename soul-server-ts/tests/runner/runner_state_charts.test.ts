import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  RUNNER_ADOPT_RESPONSE_LABELS,
  RUNNER_CENTRAL_DECISION_LABELS,
  RUNNER_CENTRAL_LOOKUP_LABELS,
  RUNNER_DECISION_LABELS,
  RUNNER_DISPOSITION_LABELS,
  RUNNER_HANDLE_ACTION_LABELS,
  RUNNER_PRECEDENCE_LABELS,
  RUNNER_STEP_LABELS,
  generateRunnerStateDocument,
  runnerCentralCheckDecisionTable,
  runnerHandleActionOrder,
  runnerHandleDecisionTable,
  runnerLifecycleDecisionTable,
  runnerRecoveryDecisionTable,
} from "../../src/runner/state/runner_charts.js";
import {
  RUNNER_ADOPT_RESPONSES,
  RUNNER_CENTRAL_CHECK_DECISIONS,
  RUNNER_CENTRAL_LOOKUPS,
  type RunnerCentralCheckDecision,
  type RunnerCentralCheckFacts,
} from "../../src/runner/state/runner_central_check_machine.js";
import { decideRunnerCentralCheck } from "../../src/runner/state/runner_central_check_decision.js";
import {
  RUNNER_HANDLE_ACTIONS,
  RUNNER_HANDLE_ATTACHED_TERMINAL_STATES,
  RUNNER_HANDLE_BACKGROUND_STATES,
  RUNNER_HANDLE_RETENTION_STATES,
} from "../../src/runner/state/runner_handle_machine.js";
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

  it("decides every central check input combination", () => {
    const rows = runnerCentralCheckDecisionTable();

    expect(rows).toHaveLength(
      RUNNER_CENTRAL_LOOKUPS.length * 2 * 2 * RUNNER_ADOPT_RESPONSES.length,
    );
    expect(new Set(rows.map(
      (row) =>
        `${row.lookup}/${row.terminalRetained}/${row.registrationAppliedAndTurnRunning}/${row.adoptResponse}`,
    )).size).toBe(rows.length);
    for (const row of rows) {
      expect(
        Object.keys(RUNNER_CENTRAL_DECISION_LABELS),
        `${row.lookup}/${row.terminalRetained}/${row.registrationAppliedAndTurnRunning}/${row.adoptResponse}`,
      ).toContain(row.decision);
    }
    for (const lookup of RUNNER_CENTRAL_LOOKUPS) {
      expect(RUNNER_CENTRAL_LOOKUP_LABELS[lookup]).toBeTruthy();
    }
    for (const response of RUNNER_ADOPT_RESPONSES) {
      expect(RUNNER_ADOPT_RESPONSE_LABELS[response]).toBeTruthy();
    }
    expect([...RUNNER_CENTRAL_CHECK_DECISIONS].sort()).toEqual(
      [...new Set(rows.map((row) => row.decision))].sort(),
    );
  });

  it("keeps the central check decision order from terminal rejection to inactive", () => {
    const check = (
      facts: Partial<RunnerCentralCheckFacts>,
    ): RunnerCentralCheckDecision => decideRunnerCentralCheck({
      lookup: "inactive",
      terminalRetained: false,
      registrationAppliedAndTurnRunning: false,
      adoptResponse: "none",
      ...facts,
    });

    expect(check({ adoptResponse: "terminal_rejection", lookup: "active" }))
      .toBe("reap");
    expect(check({ lookup: "missing", terminalRetained: true })).toBe("reap");
    expect(check({ lookup: "owner_node_changed", terminalRetained: true }))
      .toBe("reap");
    expect(check({ lookup: "lookup_error", adoptResponse: "retryable_rejection" }))
      .toBe("keep");
    expect(check({ lookup: "active", adoptResponse: "retryable_rejection" }))
      .toBe("keep");
    expect(check({ adoptResponse: "retryable_rejection" })).toBe("keep_retry");
    expect(check({ terminalRetained: true, registrationAppliedAndTurnRunning: true }))
      .toBe("keep");
    expect(check({ registrationAppliedAndTurnRunning: true })).toBe("adopt");
    expect(check({ adoptResponse: "applied", registrationAppliedAndTurnRunning: true }))
      .toBe("adopt");
    expect(check({})).toBe("keep");
  });

  it("decides every recovery handle input combination", () => {
    const rows = runnerHandleDecisionTable();

    expect(rows).toHaveLength(
      RUNNER_RECOVERY_DISPOSITIONS.length * 2 * 2 * 2
      * RUNNER_HANDLE_BACKGROUND_STATES.length
      * RUNNER_HANDLE_RETENTION_STATES.length
      * RUNNER_HANDLE_ATTACHED_TERMINAL_STATES.length
      * 2 * 2 * 2,
    );
    expect(rows).toHaveLength(15_552);
    expect(new Set(rows.map((row) =>
      [
        row.disposition,
        row.hasTask,
        row.recordedTerminal,
        row.closedEngineTerminal,
        row.detachedBackground,
        row.retention,
        row.attachedTerminal,
        row.deadBackgroundTerminalized,
        row.hasRunner,
        row.hasExecutionPromise,
      ].join("/"),
    )).size).toBe(rows.length);
    for (const row of rows) {
      expect(
        Object.keys(RUNNER_HANDLE_ACTION_LABELS),
        `${row.disposition}/${row.hasTask}/${row.recordedTerminal}`,
      ).toContain(row.action);
    }
    expect([...RUNNER_HANDLE_ACTIONS].sort()).toEqual(
      [...new Set(rows.map((row) => row.action))].sort(),
    );
    expect(runnerHandleActionOrder()).toEqual([...RUNNER_HANDLE_ACTIONS]);
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
    expect(result.markdown).toContain("중앙 확인 결정표");
    expect(result.markdown).toContain("복구 처리 조치 순서");
    expect(result.markdown).toContain(
      "corepack pnpm@10.32.1 --dir soul-server-ts exec tsx scripts/runner-state-charts.ts",
    );
  }, 300_000);
});

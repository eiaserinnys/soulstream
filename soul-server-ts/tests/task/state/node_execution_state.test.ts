import { describe, expect, it } from "vitest";

import {
  nodeExecutionFactsFromTask,
  nodeExecutionPhaseOfTask,
  projectNodeExecutionPhase,
  type NodeExecutionTaskFields,
} from "../../../src/task/state/node_execution_decision.js";
import {
  NODE_EXECUTION_PHASES,
  NODE_RETENTION_KINDS,
  NODE_RUNNER_TERMINAL_FACTS,
  type NodeExecutionFacts,
} from "../../../src/task/state/node_execution_machine.js";

const BASE: NodeExecutionFacts = {
  active: false,
  terminalRecorded: false,
  hasRunner: false,
  offlineReplay: false,
  hasStartBarrier: false,
  hasRegistration: false,
  runnerTerminalFact: "none",
  retention: "none",
  releasing: false,
  hydratedFromDb: false,
  stopRequested: false,
};

function phase(facts: Partial<NodeExecutionFacts>) {
  return projectNodeExecutionPhase({ ...BASE, ...facts });
}

const runner = {} as NonNullable<NodeExecutionTaskFields["runner"]>;

function task(fields: Partial<NodeExecutionTaskFields>): NodeExecutionTaskFields {
  return { status: "running", ...fields };
}

describe("node execution phase projection", () => {
  it("projects every fact combination to exactly one known phase", () => {
    let count = 0;
    const seen = new Set<string>();
    const bools = [false, true];
    for (const active of bools)
    for (const terminalRecorded of bools)
    for (const hasRunner of bools)
    for (const offlineReplay of bools)
    for (const hasStartBarrier of bools)
    for (const hasRegistration of bools)
    for (const runnerTerminalFact of NODE_RUNNER_TERMINAL_FACTS)
    for (const retention of NODE_RETENTION_KINDS)
    for (const releasing of bools)
    for (const hydratedFromDb of bools)
    for (const stopRequested of bools) {
      const result = projectNodeExecutionPhase({
        active,
        terminalRecorded,
        hasRunner,
        offlineReplay,
        hasStartBarrier,
        hasRegistration,
        runnerTerminalFact,
        retention,
        releasing,
        hydratedFromDb,
        stopRequested,
      });
      expect(NODE_EXECUTION_PHASES).toContain(result);
      seen.add(result);
      count += 1;
    }
    expect(count).toBe(2 ** 9 * 5 * 3);
    expect([...seen].sort()).toEqual([...NODE_EXECUTION_PHASES].sort());
  });

  it("keeps a runner-less active task loaded from the database as its own phase", () => {
    expect(phase({ active: true, hydratedFromDb: true })).toBe("hydrated_active");
    expect(phase({ active: true, hydratedFromDb: false })).toBe("starting");
    expect(phase({ active: true, hydratedFromDb: true, hasStartBarrier: true }))
      .toBe("starting");
    expect(phase({ active: true, hydratedFromDb: true, hasRunner: true, hasRegistration: true }))
      .toBe("running");
  });

  it("puts normal retention after termination into the phase", () => {
    const recorded = { terminalRecorded: true, hasRunner: true };
    expect(phase({ ...recorded, retention: "claude_background" }))
      .toBe("retained_claude_background");
    expect(phase({ ...recorded, retention: "codex_command" })).toBe("retained_codex_command");
    expect(phase({ ...recorded, retention: "claude_background", releasing: true }))
      .toBe("retained_releasing");
    expect(phase({ ...recorded })).toBe("terminating");
    expect(phase({ terminalRecorded: true, retention: "claude_background" })).toBe("idle");
  });

  it("separates the running turn, registration wait, replay and termination", () => {
    expect(phase({ active: true, hasRunner: true })).toBe("registering");
    expect(phase({ active: true, hasRunner: true, hasRegistration: true })).toBe("running");
    expect(phase({ active: true, hasRunner: true, hasRegistration: true, offlineReplay: true }))
      .toBe("replaying");
    expect(phase({
      active: true,
      hasRunner: true,
      hasRegistration: true,
      runnerTerminalFact: "completed",
    })).toBe("terminating");
    expect(phase({ active: true, hasRunner: true, hasRegistration: true, stopRequested: true }))
      .toBe("stopping");
    expect(phase({})).toBe("idle");
  });

  it("reads the Task fields without touching them", () => {
    expect(nodeExecutionPhaseOfTask(task({ status: "completed" }))).toBe("idle");
    expect(nodeExecutionPhaseOfTask(task({ status: "running", hydratedFromDb: true })))
      .toBe("hydrated_active");
    expect(nodeExecutionPhaseOfTask(task({
      status: "running",
      runner,
      executionRegistration: { registrationId: "r", executionCommandId: "c" },
    }))).toBe("running");
    const retained = task({
      status: "completed",
      terminationEventRecorded: true,
      runner,
      runnerRetainedForDetachedWork: true,
    });
    expect(nodeExecutionPhaseOfTask(retained)).toBe("retained_claude_background");
    expect(nodeExecutionPhaseOfTask(retained, { retentionKind: "codex_command" }))
      .toBe("retained_codex_command");
    expect(nodeExecutionFactsFromTask(task({ status: "completed", terminationEventRecorded: true }))
      .terminalRecorded).toBe(true);
    expect(nodeExecutionFactsFromTask(task({ status: "running", terminationEventRecorded: true }))
      .terminalRecorded).toBe(false);
    expect(nodeExecutionPhaseOfTask(task({ status: "running", hydratedFromDb: true }), {
      stopRequested: true,
    })).toBe("stopping");
  });
});

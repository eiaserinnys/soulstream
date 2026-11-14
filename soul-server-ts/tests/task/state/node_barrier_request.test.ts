import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decideNodeStopRequest,
  stepNodeBarrier,
} from "../../../src/task/state/node_barrier_decision.js";
import {
  NODE_BARRIER_EVENTS,
  NODE_BARRIER_STATES,
  NODE_STOP_DISPOSITIONS,
  type NodeBarrierState,
} from "../../../src/task/state/node_barrier_machine.js";
import { NODE_EXECUTION_PHASES } from "../../../src/task/state/node_execution_machine.js";
import { nodeGuessCells } from "../../../src/task/state/node_guess_cells.js";
import { decideNodeRequest } from "../../../src/task/state/node_request_decision.js";
import {
  NODE_REQUEST_BOUNDARY_TEST_FILES,
  NODE_REQUEST_KINDS,
  NODE_REQUEST_TABLE,
} from "../../../src/task/state/node_request_machine.js";

describe("node barrier serialization", () => {
  it("gives a stop request one of three dispositions for every preceding barrier", () => {
    for (const state of NODE_BARRIER_STATES) {
      expect(NODE_STOP_DISPOSITIONS).toContain(decideNodeStopRequest(state));
    }
    expect(decideNodeStopRequest("none")).toBe("stop_now");
    expect(decideNodeStopRequest("execution_start")).toBe("stop_now");
    expect(decideNodeStopRequest("intervention_handoff")).toBe("stop_after_handoff");
    expect(decideNodeStopRequest("stop")).toBe("already_stopping");
  });

  it("raises the stop barrier when the handoff it waited on is released", () => {
    const waiting = stepNodeBarrier("intervention_handoff", "STOP_REQUESTED");
    expect(waiting).toEqual({ state: "stop_waiting_handoff", stop: "stop_after_handoff" });
    const released = stepNodeBarrier(waiting.state, "HANDOFF_RELEASED");
    expect(released.state).toBe("stop");
    expect(stepNodeBarrier(released.state, "STOP_REQUESTED").stop).toBe("already_stopping");
    expect(stepNodeBarrier(released.state, "STOP_DONE").state).toBe("none");
  });

  it("has no transition that lets a waiting stop return to an idle barrier", () => {
    const leaves = new Set<NodeBarrierState>();
    for (const event of NODE_BARRIER_EVENTS) {
      leaves.add(stepNodeBarrier("stop_waiting_handoff", event).state);
    }
    expect([...leaves].sort()).toEqual(["stop", "stop_waiting_handoff"]);
  });
});

describe("node outside request cells", () => {
  it("gives every execution phase and request kind exactly one disposition", () => {
    let count = 0;
    for (const phase of NODE_EXECUTION_PHASES) {
      for (const request of NODE_REQUEST_KINDS) {
        expect(decideNodeRequest(phase, request)).toBe(
          NODE_REQUEST_TABLE[phase][request].disposition,
        );
        count += 1;
      }
    }
    expect(count).toBe(NODE_EXECUTION_PHASES.length * NODE_REQUEST_KINDS.length);
  });

  it("makes stop and delete of a runner-less active task write a termination record", () => {
    expect(decideNodeRequest("hydrated_active", "stop")).toBe("terminate_without_runner");
    expect(decideNodeRequest("hydrated_active", "delete"))
      .toBe("terminate_without_runner_then_delete");
    // 카드 #1266 U5b: 운영은 끝난 task의 멈춤을 이미 수렴한 멈춤으로 참을 돌려준다.
    expect(decideNodeRequest("idle", "stop")).toBe("already_converged");
    expect(decideNodeRequest("idle", "delete")).toBe("delete_row");
  });
});

/** 시험 파일의 소스에서 `it("...")`로 선언된 시험 이름을 모두 모은다. */
function declaredTestNames(source: string): string[] {
  return [...source.matchAll(/\bit\(\s*"([^"]+)"/g)].map((match) => match[1]!);
}

/** 표가 이름을 대는데 시험 파일에 정확히 한 번 선언되지 않은 이름을 돌려준다. */
function missingBoundaryTests(names: readonly string[], sources: readonly string[]): string[] {
  const declared = sources.flatMap(declaredTestNames);
  return names.filter((name) => declared.filter((item) => item === name).length !== 1);
}

function boundarySources(): string[] {
  return NODE_REQUEST_BOUNDARY_TEST_FILES.map((file) =>
    readFileSync(new URL(`../../../../${file}`, import.meta.url), "utf8"));
}

describe("node outside request cells have no empty cell (card #1266 U5b)", () => {
  it("gives every request cell a confirmed basis and closes every old guessed cell", () => {
    for (const phase of NODE_EXECUTION_PHASES) {
      for (const request of NODE_REQUEST_KINDS) {
        const cell = NODE_REQUEST_TABLE[phase][request];
        expect(["design", "current"], `${phase}/${request}`).toContain(cell.basis);
        expect(cell.test.length, `${phase}/${request}`).toBeGreaterThan(0);
      }
    }
    const guesses = nodeGuessCells();
    expect(guesses).toHaveLength(20);
    for (const guess of guesses) {
      expect(["request", "barrier", "order"], `guess ${guess.no}`).toContain(guess.closure.kind);
      expect(guess.tests.length, `guess ${guess.no}`).toBeGreaterThan(0);
      if (guess.closure.kind === "request") {
        expect(NODE_REQUEST_TABLE[guess.closure.phase][guess.closure.request].basis)
          .not.toBe("open");
      }
    }
  });

  it("finds every named boundary test exactly once in the boundary test files", () => {
    const names = [
      ...NODE_EXECUTION_PHASES.flatMap((phase) =>
        NODE_REQUEST_KINDS.map((request) => NODE_REQUEST_TABLE[phase][request].test)),
      ...nodeGuessCells().flatMap((guess) => guess.tests),
    ];
    expect(new Set(names.slice(0, NODE_EXECUTION_PHASES.length * NODE_REQUEST_KINDS.length)).size)
      .toBe(NODE_EXECUTION_PHASES.length * NODE_REQUEST_KINDS.length);
    expect(missingBoundaryTests(names, boundarySources())).toEqual([]);
  });

  it("reports a planted name that the boundary files do not declare as a test", () => {
    const sources = [
      'it("있는 시험", () => {});\n// "주석에만 있는 이름"\nit("두 번 있는 시험", () => {});\nit("두 번 있는 시험", () => {});',
    ];
    expect(missingBoundaryTests(
      ["있는 시험", "없는 시험", "주석에만 있는 이름", "두 번 있는 시험"],
      sources,
    )).toEqual(["없는 시험", "주석에만 있는 이름", "두 번 있는 시험"]);
  });
});

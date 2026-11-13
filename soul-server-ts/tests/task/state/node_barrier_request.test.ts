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
import { decideNodeRequest } from "../../../src/task/state/node_request_decision.js";
import {
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
    expect(decideNodeRequest("idle", "stop")).toBe("reject_not_running");
    expect(decideNodeRequest("idle", "delete")).toBe("delete_row");
  });
});

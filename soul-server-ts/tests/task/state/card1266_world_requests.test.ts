import { describe, expect, it } from "vitest";

import { PRODUCT } from "./combined_sweep/product_decisions.js";
import { createContext, newCounters } from "./combined_sweep/world_context.js";
import { nodeSteps, worldRequestDisposition } from "./combined_sweep/world_node_steps.js";
import { NODE_REQUEST_KINDS, NODE_REQUEST_TABLE } from "../../../src/task/state/node_request_machine.js";
import { INITIAL } from "./combined_sweep/world_state.js";

describe("card #1266 U5c world request dispositions", () => {
  it("reads every request table disposition and rejects dispositions of another request", () => {
    for (const row of Object.values(NODE_REQUEST_TABLE)) {
      for (const request of NODE_REQUEST_KINDS) {
        const disposition = row[request].disposition;
        expect(worldRequestDisposition(request, disposition)).toBe(disposition);
      }
    }
    expect(() => worldRequestDisposition("intervene", "start_on_retained_runner"))
      .toThrow(/unmapped.*disposition/);
  });

  it("throws instead of silently queuing an unknown instruction disposition", () => {
    const ctx = createContext({
      k: 2, k2: 1, codex: true, envOff: new Set(), settlePending: true, requeue: true,
      decisions: { ...PRODUCT, nodeRequest: () => "unknown_disposition" as never },
    }, newCounters());

    expect(() => nodeSteps(ctx).J01!(INITIAL)).toThrow(/unmapped.*disposition/);
  });
});

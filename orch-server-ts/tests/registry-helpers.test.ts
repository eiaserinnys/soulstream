import { describe, expect, it } from "vitest";

import { runnerInventoryCommandType } from "../src/node/registry_helpers.js";

describe("runner inventory rolling compatibility", () => {
  it("uses the lightweight command only for a capable new node", () => {
    expect(runnerInventoryCommandType({ runner_inventory_v1: true }))
      .toBe("list_runner_inventory");
  });

  it("keeps list_sessions for old or explicitly incapable nodes", () => {
    expect(runnerInventoryCommandType({})).toBe("list_sessions");
    expect(runnerInventoryCommandType({ runner_inventory_v1: false }))
      .toBe("list_sessions");
    expect(runnerInventoryCommandType(undefined)).toBe("list_sessions");
  });
});

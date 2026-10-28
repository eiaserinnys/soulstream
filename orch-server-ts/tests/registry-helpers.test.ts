import { describe, expect, it } from "vitest";

import {
  runnerInventoryCommandType,
  supportsClaudeAccountPool,
} from "../src/node/registry_helpers.js";

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

describe("Claude account pool capability", () => {
  it("recognizes only an explicit boolean capability", () => {
    expect(supportsClaudeAccountPool({ claude_account_pool_v1: true })).toBe(true);
    expect(supportsClaudeAccountPool({})).toBe(false);
    expect(supportsClaudeAccountPool({ claude_account_pool_v1: false })).toBe(false);
    expect(supportsClaudeAccountPool({ claude_account_pool_v1: "true" })).toBe(false);
    expect(supportsClaudeAccountPool(undefined)).toBe(false);
  });
});

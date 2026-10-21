import { describe, expect, it } from "vitest";
import { decideWorktreeSweep, SWEEP_IDLE_MS, SWEEP_RECENT_MS } from "../src/worktree/worktree_sweep_policy.js";

describe("worktree sweep policy", () => {
  const safe = {
    idleMs: SWEEP_RECENT_MS, missing: false, inUse: false, baseLinks: false,
    changes: false, pushed: true, merged: false, linkedCardsClosed: false,
  };
  it.each([
    ["recent", { idleMs: SWEEP_RECENT_MS - 1, missing: true }],
    ["removed", { missing: true, changes: true, pushed: false }],
    ["in_use", { inUse: true, merged: true }],
    ["base_links", { baseLinks: true, merged: true }],
    ["changes", { changes: true, merged: true }],
    ["unpushed", { pushed: false, linkedCardsClosed: true }],
    ["not_finished", {}],
    ["removed", { merged: true }],
    ["removed", { linkedCardsClosed: true }],
    ["removed", { idleMs: SWEEP_IDLE_MS }],
  ])("returns %s for %j", (expected, patch) => {
    expect(decideWorktreeSweep({ ...safe, ...patch })).toBe(expected);
  });
});

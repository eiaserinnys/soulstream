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
    // Closed linked cards sweep even when local commits were left unpushed; the worktree goes, its branch ref stays.
    ["removed", { pushed: false, linkedCardsClosed: true }],
    // An open linked card still protects its unpushed worktree.
    ["unpushed", { pushed: false, linkedCardsClosed: false }],
    ["not_finished", {}],
    ["removed", { merged: true }],
    ["removed", { linkedCardsClosed: true }],
    ["removed", { idleMs: SWEEP_IDLE_MS }],
    // HEAD == createdFromSha: the sweep supplies merged=false despite origin ancestry.
    ["not_finished", { idleMs: SWEEP_RECENT_MS + 1, merged: false, linkedCardsClosed: false }],
    ["removed", { idleMs: SWEEP_RECENT_MS + 1, merged: false, linkedCardsClosed: true }],
    // Closed linked cards do not override the earlier safety gates.
    ["recent", { idleMs: SWEEP_RECENT_MS - 1, pushed: false, linkedCardsClosed: true }],
    ["in_use", { inUse: true, pushed: false, linkedCardsClosed: true }],
    ["changes", { changes: true, pushed: false, linkedCardsClosed: true }],
  ])("returns %s for %j", (expected, patch) => {
    expect(decideWorktreeSweep({ ...safe, ...patch })).toBe(expected);
  });
});

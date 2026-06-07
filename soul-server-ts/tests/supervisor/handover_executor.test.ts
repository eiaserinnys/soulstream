import { describe, expect, it, vi } from "vitest";

import { SupervisorHandoverExecutor } from "../../src/supervisor/handover_executor.js";
import type { SupervisorRegistryRow } from "../../src/db/session_db.js";

function registry(): SupervisorRegistryRow {
  return {
    role: "ariela_codex",
    activeSessionId: "sess-a",
    epoch: 4,
    cursorOffset: 99,
    handoverState: "handover_running",
    cumulativeTokens: 1_500_000,
    compactionCount: 2,
    lastSeenAt: new Date("2026-06-07T00:00:00.000Z"),
    createdAt: new Date("2026-06-07T00:00:00.000Z"),
    updatedAt: new Date("2026-06-07T00:00:00.000Z"),
  };
}

describe("SupervisorHandoverExecutor", () => {
  it("boots B, injects snapshot, drains, activates epoch, then kills A", async () => {
    const calls: string[] = [];
    const deps = {
      bootReplacement: vi.fn(async () => {
        calls.push("boot");
        return { sessionId: "sess-b" };
      }),
      injectSnapshot: vi.fn(async () => {
        calls.push("snapshot");
      }),
      drainReplacement: vi.fn(async () => {
        calls.push("drain");
        return { cursorOffset: 120 };
      }),
      activateReplacement: vi.fn(async () => {
        calls.push("activate");
      }),
      killPrevious: vi.fn(async () => {
        calls.push("kill");
      }),
    };

    const result = await new SupervisorHandoverExecutor(deps).run(registry());

    expect(calls).toEqual(["boot", "snapshot", "drain", "activate", "kill"]);
    expect(deps.injectSnapshot).toHaveBeenCalledWith({
      role: "ariela_codex",
      previousSessionId: "sess-a",
      replacementSessionId: "sess-b",
      asOfOffset: 99,
    });
    expect(deps.activateReplacement).toHaveBeenCalledWith({
      role: "ariela_codex",
      activeSessionId: "sess-b",
      epoch: 5,
      cursorOffset: 120,
      handoverState: "idle",
      cumulativeTokens: 0,
      compactionCount: 2,
      lastSeenAt: new Date("2026-06-07T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      previousSessionId: "sess-a",
      activeSessionId: "sess-b",
      epoch: 5,
      cursorOffset: 120,
    });
  });

  it("does not kill previous session when replacement is not activated", async () => {
    const deps = {
      bootReplacement: vi.fn(async () => ({ sessionId: "sess-b" })),
      injectSnapshot: vi.fn(async () => undefined),
      drainReplacement: vi.fn(async () => ({ cursorOffset: 120 })),
      activateReplacement: vi.fn(async () => {
        throw new Error("registry write failed");
      }),
      killPrevious: vi.fn(async () => undefined),
    };

    await expect(new SupervisorHandoverExecutor(deps).run(registry())).rejects.toThrow(
      "registry write failed",
    );
    expect(deps.killPrevious).not.toHaveBeenCalled();
  });
});

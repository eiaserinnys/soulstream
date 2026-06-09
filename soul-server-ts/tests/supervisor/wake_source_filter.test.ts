import { describe, expect, it } from "vitest";

import {
  SUPERVISOR_WAKE_ALLOWED_CALLER_SOURCES,
  hasCriticalSupervisorSnapshotSignal,
  shouldDispatchSupervisorWakeCandidate,
} from "../../src/supervisor/wake_source_filter.js";

describe("Supervisor wake source filter", () => {
  it("allows only person or delegation caller sources for non-critical wake candidates", () => {
    for (const callerSource of ["browser", "slack", "soul-app", "agent"]) {
      expect(SUPERVISOR_WAKE_ALLOWED_CALLER_SOURCES.has(callerSource)).toBe(true);
      expect(shouldDispatchSupervisorWakeCandidate({
        supervisorId: "ariela_codex",
        sourceAgentId: "worker",
        callerSource,
        critical: false,
      })).toBe(true);
    }
  });

  it("keeps automatic caller sources silent unless the wake candidate is critical", () => {
    for (const callerSource of ["llm", "system", "channel_observer", "trello_watcher"]) {
      expect(shouldDispatchSupervisorWakeCandidate({
        supervisorId: "ariela_codex",
        sourceAgentId: "worker",
        callerSource,
        critical: false,
      })).toBe(false);
      expect(shouldDispatchSupervisorWakeCandidate({
        supervisorId: "ariela_codex",
        sourceAgentId: "worker",
        callerSource,
        critical: true,
      })).toBe(true);
    }
  });

  it("treats missing caller source as silent by default but keeps the critical safety net", () => {
    expect(shouldDispatchSupervisorWakeCandidate({
      supervisorId: "ariela_codex",
      sourceAgentId: "worker",
      callerSource: null,
      critical: false,
    })).toBe(false);
    expect(shouldDispatchSupervisorWakeCandidate({
      supervisorId: "ariela_codex",
      sourceAgentId: "worker",
      callerSource: undefined,
      critical: true,
    })).toBe(true);
  });

  it("keeps supervisor-owned sessions excluded even when their signal is critical", () => {
    expect(shouldDispatchSupervisorWakeCandidate({
      supervisorId: "ariela_codex",
      sourceAgentId: "ariela_codex",
      callerSource: "slack",
      critical: true,
    })).toBe(false);
  });

  it("uses error status as the snapshot critical safety signal", () => {
    expect(hasCriticalSupervisorSnapshotSignal({ status: "error" })).toBe(true);
    expect(hasCriticalSupervisorSnapshotSignal({ status: "completed" })).toBe(false);
    expect(hasCriticalSupervisorSnapshotSignal({ status: null })).toBe(false);
  });
});

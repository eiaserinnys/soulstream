import { describe, expect, it } from "vitest";

import { canDeleteClaudeRuntimeSchedule } from "./ClaudeRuntimeSchedulesPanel";

describe("canDeleteClaudeRuntimeSchedule", () => {
  it("allows direct deletion for orphaned schedules", () => {
    expect(canDeleteClaudeRuntimeSchedule("orphaned")).toBe(true);
  });

  it("keeps terminal completed/cancelled/failed schedules non-deletable", () => {
    expect(canDeleteClaudeRuntimeSchedule("completed")).toBe(false);
    expect(canDeleteClaudeRuntimeSchedule("cancelled")).toBe(false);
    expect(canDeleteClaudeRuntimeSchedule("failed")).toBe(false);
  });
});

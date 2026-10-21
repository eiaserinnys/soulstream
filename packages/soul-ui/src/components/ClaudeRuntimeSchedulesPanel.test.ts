import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { canDeleteClaudeRuntimeSchedule, ClaudeRuntimeSchedulesPanel } from "./ClaudeRuntimeSchedulesPanel";
import type { ClaudeRuntimeView } from "../stores/claude-runtime-state";

const nextRunAt = "2026-10-21T05:08:48.000Z";
const runtime: ClaudeRuntimeView = {
  updatedAt: 0,
  tasks: {},
  notifications: {},
  remoteTriggers: {},
  schedules: {
    "schedule-1": { scheduleId: "schedule-1", kind: "cron", status: "active", nextRunAt },
  },
};

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

describe("ClaudeRuntimeSchedulesPanel presentation", () => {
  const render = (variant: "default" | "caption") => renderToStaticMarkup(createElement(ClaudeRuntimeSchedulesPanel, {
    sessionId: "session-1",
    runtime,
    variant,
  }));

  it("uses the manuscript icon cap and short date only in the caption variant", () => {
    const caption = render("caption");
    const shortDate = new Date(nextRunAt).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(caption).toContain(`다음 ${shortDate}`);
    expect(caption).toContain('data-slot="dashboard-icon-cap"');
    expect(caption).toContain("dashboard-icon-cap--small");
    expect(caption).toContain('aria-label="새로고침"');

    const defaultMarkup = render("default");
    expect(defaultMarkup).toContain(`next ${new Date(nextRunAt).toLocaleString()}`);
    expect(defaultMarkup).toContain("Schedules");
    expect(defaultMarkup).not.toContain("dashboard-icon-cap--small");
  });
});

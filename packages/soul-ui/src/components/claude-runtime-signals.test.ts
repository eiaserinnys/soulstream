import { afterEach, describe, expect, it } from "vitest";

import {
  resetClaudeRuntimeSignalsFallbackForTest,
  resolveClaudeRuntimeSignals,
  resolveClaudeRuntimeSignalsForSessionForTest,
  setClaudeRuntimeSignalsFallbackForTest,
} from "./claude-runtime-signals";
import type { ClaudeRuntimeView } from "../stores/claude-runtime-state";

describe("resolveClaudeRuntimeSignals", () => {
  afterEach(() => {
    resetClaudeRuntimeSignalsFallbackForTest();
  });

  it("selects sorted compact notifications, remote triggers, and mirror errors", () => {
    const runtime: ClaudeRuntimeView = {
      updatedAt: 400,
      tasks: {},
      schedules: {},
      notifications: {
        old: { notificationId: "old", source: "hook", message: "old", updatedAt: 100 },
        new: { notificationId: "new", source: "system", message: "new", updatedAt: 300 },
      },
      remoteTriggers: {
        later: { triggerId: "later", source: "message_origin", updatedAt: 250 },
        earlier: { triggerId: "earlier", source: "tool_use", updatedAt: 150 },
      },
      transcriptMirror: {
        updatedAt: 350,
        errorCount: 2,
        lastError: "cannot extract elements from a scalar",
      },
    };

    const signals = resolveClaudeRuntimeSignals(runtime, {
      notificationLimit: 1,
      remoteTriggerLimit: 1,
    });

    expect(signals.notifications.map((item) => item.notificationId)).toEqual(["new"]);
    expect(signals.remoteTriggers.map((item) => item.triggerId)).toEqual(["later"]);
    expect(signals.hasError).toBe(true);
    expect(signals.errorCount).toBe(2);
    expect(signals.visibleCount).toBe(4);
  });

  it("uses one shared fetched fallback snapshot for strip and panel callers", () => {
    setClaudeRuntimeSignalsFallbackForTest("sess-1", {
      notifications: [
        {
          notificationId: "fallback-notification",
          source: "system",
          message: "fallback notification",
          updatedAt: 100,
        },
      ],
      remoteTriggers: [
        { triggerId: "fallback-trigger", source: "tool_use", updatedAt: 90 },
      ],
      mirror: {
        updatedAt: 80,
        errorCount: 1,
        lastError: "fallback mirror error",
      },
    });

    const stripSignals = resolveClaudeRuntimeSignalsForSessionForTest("sess-1", null);
    const panelSignals = resolveClaudeRuntimeSignalsForSessionForTest("sess-1", null);

    expect(stripSignals).toEqual(panelSignals);
    expect(stripSignals.hasSignals).toBe(true);
    expect(stripSignals.mirror?.lastError).toBe("fallback mirror error");
  });
});

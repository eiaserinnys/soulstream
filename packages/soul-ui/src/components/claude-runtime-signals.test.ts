/** @vitest-environment jsdom */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/claude-runtime-actions", () => ({
  listClaudeBackgroundTasks: vi.fn().mockResolvedValue({
    notifications: [],
    remoteTriggers: [],
    transcriptMirror: null,
  }),
}));

import {
  resetClaudeRuntimeSignalsFallbackForTest,
  resolveClaudeRuntimeSignals,
  resolveClaudeRuntimeSignalsForSessionForTest,
  setClaudeRuntimeSignalsFallbackForTest,
  useClaudeRuntimeSignals,
} from "./claude-runtime-signals";
import type { ClaudeRuntimeView } from "../stores/claude-runtime-state";
import { ChatStoreScopeProvider } from "../stores/chat-store-scope";
import { createChatSessionStore, useDashboardStore } from "../stores/dashboard-store";

function RuntimeSignalsProbe({ sessionId }: { sessionId: string }) {
  const { signals } = useClaudeRuntimeSignals(sessionId);
  return createElement("output", null, JSON.stringify({
    notifications: signals.notifications.map((item) => item.notificationId),
    remoteTriggers: signals.remoteTriggers.map((item) => item.triggerId),
    mirrorSessionId: signals.mirror?.sessionId ?? null,
  }));
}

describe("resolveClaudeRuntimeSignals", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    resetClaudeRuntimeSignalsFallbackForTest();
    useDashboardStore.getState().reset();
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

  it("uses the scoped Claude runtime and keeps the unscoped global default", () => {
    useDashboardStore.getState().reset();
    const scope = createChatSessionStore("assigned-session");
    const runtimeFor = (sessionId: string): ClaudeRuntimeView => ({
      updatedAt: 1,
      tasks: {},
      schedules: {},
      notifications: {
        notification: {
          notificationId: `${sessionId}-notification`,
          source: "system",
          message: `${sessionId} notification`,
          updatedAt: 1,
        },
      },
      remoteTriggers: {
        trigger: {
          triggerId: `${sessionId}-trigger`,
          source: "tool_use",
          updatedAt: 1,
        },
      },
      transcriptMirror: {
        updatedAt: 1,
        errorCount: 0,
        sessionId,
      },
    });
    useDashboardStore.setState({ claudeRuntime: runtimeFor("pas-session") });
    scope.store.setState({ claudeRuntime: runtimeFor("assigned-session") });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(createElement(
      ChatStoreScopeProvider,
      { scope },
      createElement(RuntimeSignalsProbe, { sessionId: "assigned-session" }),
    )));
    const scopedText = container.textContent ?? "";
    expect(scopedText).toContain("assigned-session-notification");
    expect(scopedText).toContain("assigned-session-trigger");
    expect(scopedText).toContain("assigned-session");
    expect(scopedText).not.toContain("pas-session-notification");
    expect(scopedText).not.toContain("pas-session-trigger");

    flushSync(() => root?.render(
      createElement(RuntimeSignalsProbe, { sessionId: "assigned-session" }),
    ));
    const defaultText = container.textContent ?? "";
    expect(defaultText).toContain("pas-session-notification");
    expect(defaultText).toContain("pas-session-trigger");
    expect(defaultText).not.toContain("assigned-session-notification");
    expect(defaultText).not.toContain("assigned-session-trigger");
  });
});

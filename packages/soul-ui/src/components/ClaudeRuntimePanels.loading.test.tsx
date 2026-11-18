/**
 * @vitest-environment jsdom
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeRuntimeSchedulesPanel } from "./ClaudeRuntimeSchedulesPanel";
import { ClaudeRuntimeTasksPanel } from "./ClaudeRuntimeTasksPanel";
import type { ClaudeRuntimeView } from "../stores/claude-runtime-state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const schedule = {
  scheduleId: "schedule-1",
  kind: "cron" as const,
  status: "active" as const,
  nextRunAt: "2026-10-21T05:08:48.000Z",
};

const runtimeWithSchedule: ClaudeRuntimeView = {
  updatedAt: 0,
  tasks: {},
  notifications: {},
  remoteTriggers: {},
  schedules: { "schedule-1": schedule },
};

const runtimeWithTask: ClaudeRuntimeView = {
  updatedAt: 0,
  tasks: {
    "task-1": {
      taskId: "task-1",
      status: "running",
      updatedAt: 0,
      taskType: "bash",
    },
  },
  notifications: {},
  remoteTriggers: {},
  schedules: {},
};

function refreshButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[title="새로고침"]');
}

describe("runtime panels first loading", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits in the schedules body without spinning the header button", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeSchedulesPanel, { sessionId: "session-1", runtime: null }));
    });

    expect(container.querySelector('[data-slot="frame-loading"]')?.textContent).toBe("불러오는 중…");
    expect(refreshButton(container)?.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the header button spinning when schedules already exist", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeSchedulesPanel, { sessionId: "session-1", runtime: runtimeWithSchedule }));
    });

    expect(container.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(refreshButton(container)?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("waits in the tasks body without spinning the caption refresh button", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeTasksPanel, {
        sessionId: "session-1",
        runtime: null,
        variant: "caption",
      }));
    });

    expect(container.querySelector('[data-slot="frame-loading"]')?.textContent).toBe("불러오는 중…");
    expect(refreshButton(container)?.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the tasks header button spinning when tasks already exist", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(() => pending));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeTasksPanel, { sessionId: "session-1", runtime: runtimeWithTask }));
    });

    expect(container.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(refreshButton(container)?.querySelector(".animate-spin")).not.toBeNull();
  });
});

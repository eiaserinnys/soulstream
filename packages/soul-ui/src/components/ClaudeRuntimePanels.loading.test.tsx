/**
 * @vitest-environment jsdom
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeRuntimeSchedulesPanel } from "./ClaudeRuntimeSchedulesPanel";
import { ClaudeRuntimeTasksPanel } from "./ClaudeRuntimeTasksPanel";
import type { ClaudeRuntimeView } from "../lib/claude-runtime-projection";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

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

  it("draws nothing at all while the schedules first load is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeSchedulesPanel, { sessionId: "session-1", runtime: null, variant: "caption" }));
    });

    expect(container.innerHTML).toBe("");
    expect(container.textContent).not.toContain("예약 0");
    expect(refreshButton(container)).toBeNull();
  });

  it("shows the collapsed header only after schedules arrive", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeSchedulesPanel, { sessionId: "session-1", runtime: null, variant: "caption" }));
    });
    expect(container.innerHTML).toBe("");

    await act(async () => {
      pending.resolve(jsonResponse({ sessionId: "session-1", nextRunAt: null, schedules: [schedule] }));
      await pending.promise;
    });

    expect(container.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(container.textContent).toContain("예약 1");
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(refreshButton(container)?.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the header button spinning when schedules already exist", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeSchedulesPanel, { sessionId: "session-1", runtime: runtimeWithSchedule, variant: "caption" }));
    });

    expect(container.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(container.textContent).toContain("예약 1");
    expect(refreshButton(container)?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("draws nothing at all while the tasks first load is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeTasksPanel, {
        sessionId: "session-1",
        runtime: null,
        variant: "caption",
      }));
    });

    expect(container.innerHTML).toBe("");
    expect(container.textContent).not.toContain("백그라운드 작업 0");
    expect(refreshButton(container)).toBeNull();
  });

  it("shows the collapsed tasks header only after tasks arrive", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeTasksPanel, {
        sessionId: "session-1",
        runtime: null,
        variant: "caption",
      }));
    });
    expect(container.innerHTML).toBe("");

    await act(async () => {
      pending.resolve(jsonResponse({
        sessionId: "session-1",
        sessionState: "idle",
        runtimeSessionId: null,
        updatedAt: 0,
        tasks: [{
          taskId: "task-1",
          status: "running",
          updatedAt: 0,
          taskType: "bash",
        }],
      }));
      await pending.promise;
    });

    expect(container.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(container.textContent).toContain("백그라운드 작업 1");
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  it("keeps the tasks header button spinning when tasks already exist", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    await act(async () => {
      root.render(createElement(ClaudeRuntimeTasksPanel, { sessionId: "session-1", runtime: runtimeWithTask, variant: "caption" }));
    });

    expect(container.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(container.textContent).toContain("백그라운드 작업 1");
    expect(refreshButton(container)?.querySelector(".animate-spin")).not.toBeNull();
  });

  it.each([["keep", "유지"], ["remove", "제거"], ["custom", "custom"]])(
    "shows the worktree action %s in the expanded panel",
    async (action, expected) => {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
      const runtime = { ...runtimeWithTask, worktreeMode: { active: false, updatedAt: 0, worktreeAction: action } };
      await act(async () => root.render(createElement(ClaudeRuntimeTasksPanel, { sessionId: "session-1", runtime })));
      act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
      expect(container.textContent).toContain(`워크트리 모드 꺼짐 (${expected})`);
    },
  );
});

/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionPage } from "../hooks/session-stream-helpers";
import type { SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  type TaskOverviewPayload,
  useTaskStore,
} from "../stores/task-store";
import { TaskOverview } from "./TaskOverview";

const originalFetch = globalThis.fetch;

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sampleOverview(): TaskOverviewPayload {
  const myTurnItem = {
    task_id: "rb-1",
    task_title: "Deploy Task",
    board_item_id: "task:rb-1",
    folder_id: "f1",
    section_id: "sec-1",
    section_title: "Release",
    item_id: "item-1",
    item_title: "Operator approval",
    how_to: "Approve the deployment window.",
    status: "pending" as const,
    item_version: 1,
    task_created_session_id: "sess-task",
    section_created_session_id: "sess-section",
    section_updated_session_id: null,
    item_created_session_id: "sess-item",
    item_updated_session_id: null,
    effective_assignee_kind: "human" as const,
    effective_assignee_agent_id: null,
    effective_assignee_session_id: null,
    effective_assignee_user_id: "operator@example.com",
  };
  return {
    my_turn_items: [myTurnItem],
    tasks: [
      {
        task_id: "rb-1",
        task_title: "Deploy Task",
        board_item_id: "task:rb-1",
        folder_id: "f1",
        task_status: "open",
        completed_count: 1,
        total_count: 2,
        updated_at: "2026-06-16T00:00:00+00:00",
        items: [
          myTurnItem,
          {
            ...myTurnItem,
            item_id: "item-2",
            item_title: "Agent verification",
            status: "completed",
            effective_assignee_kind: "agent",
            effective_assignee_user_id: null,
          },
        ],
      },
    ],
  };
}

describe("TaskOverview", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useDashboardStore.getState().reset();
    useTaskStore.getState().reset();
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    useDashboardStore.getState().reset();
    useTaskStore.getState().reset();
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  function renderOverview() {
    root.render(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TaskOverview),
    ));
  }

  function seedSessions(sessions: SessionSummary[]) {
    queryClient.setQueryData<InfiniteData<SessionPage>>(["sessions", "all", "feed", null], {
      pages: [{ sessions, total: sessions.length }],
      pageParams: [0],
    });
  }

  it("renders compact running sessions, split panes, task rows, and selected items", () => {
    useTaskStore.setState({
      overview: {
        snapshot: sampleOverview(),
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    expect(container.querySelector('[data-testid="task-overview-dashboard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-overview-running-sessions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-overview-my-turn"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-overview-my-turn-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-overview-split-layout"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-overview-task-list-scroll"]')?.className).toContain("overflow-y-auto");
    expect(container.querySelector('[data-testid="task-overview-selected-items-scroll"]')?.className).toContain("overflow-y-auto");
    expect(container.querySelector("main")?.style.scrollbarGutter).toBe("stable");
    expect(container.querySelector("main")?.style.paddingInline).toBe("16px");
    const row = container.querySelector<HTMLElement>('[data-testid="task-overview-task-row"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("aria-selected")).toBe("true");
    expect(row!.className).toContain("glass");
    expect(container.querySelector('[data-testid="task-overview-task-attention"]')?.textContent).toBe("1");
    expect(container.textContent).toContain("Operator approval");
    expect(container.textContent).toContain("Deploy Task");
    expect(container.textContent).toContain("1/2");
    expect(container.textContent).toContain("실행 중인 세션 없음");
    expect(container.textContent).not.toContain("Approve the deployment window.");
    expect(container.textContent).not.toContain("PR-3b 대기");
    expect(container.textContent).toContain("Agent verification");
    expect(container.querySelector('[data-testid="task-overview-item-how-to"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="task-overview-item-how-to-trigger"]').length).toBeGreaterThanOrEqual(1);
    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("feed");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
  });

  it("marks only tasks with current attention and switches the lower item pane on row selection", () => {
    const payload = sampleOverview();
    payload.tasks.push({
      ...payload.tasks[0]!,
      task_id: "rb-2",
      task_title: "QA Task",
      board_item_id: "task:rb-2",
      completed_count: 0,
      total_count: 1,
      items: [{
        ...payload.tasks[0]!.items[0]!,
        task_id: "rb-2",
        item_id: "qa-item",
        item_title: "Smoke tests",
        status: "pending",
      }],
    });
    useTaskStore.setState({
      overview: {
        snapshot: payload,
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    expect(container.querySelectorAll('[data-testid="task-overview-task-attention"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="task-overview-selected-items"]')?.textContent).toContain("Operator approval");
    expect(container.querySelector('[data-testid="task-overview-selected-items"]')?.textContent).not.toContain("Smoke tests");

    const qaRow = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="task-overview-task-row"]'),
    ).find((row) => row.textContent?.includes("QA Task"));
    expect(qaRow).not.toBeUndefined();
    flushSync(() => {
      qaRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(qaRow!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="task-overview-selected-items"]')?.textContent).toContain("Smoke tests");
    expect(container.querySelector('[data-testid="task-overview-selected-items"]')?.textContent).not.toContain("Operator approval");
  });

  it("omits the how-to hover trigger when an item has no how_to", () => {
    const payload = sampleOverview();
    payload.my_turn_items[0] = {
      ...payload.my_turn_items[0]!,
      how_to: "",
    };
    payload.tasks[0] = {
      ...payload.tasks[0]!,
      items: [{
        ...payload.tasks[0]!.items[0]!,
        how_to: "",
      }],
    };
    useTaskStore.setState({
      overview: {
        snapshot: payload,
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    expect(container.querySelector('[data-testid="task-overview-item-how-to-trigger"]')).toBeNull();
    expect(container.textContent).not.toContain("상세 절차 없음");
  });

  it("posts a selected item checkbox status mutation and reloads the overview", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(okResponse(sampleOverview()));
    globalThis.fetch = fetchMock;
    useTaskStore.setState({
      overview: {
        snapshot: sampleOverview(),
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    const checkbox = container.querySelector<HTMLInputElement>(
      '[data-testid="task-overview-group-item"] input[type="checkbox"]',
    );
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/tasks/rb-1/items/item-1/status",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      status: "completed",
      expectedVersion: 1,
    });
    expect(body.idempotencyKey).toMatch(/^task:rb-1:item:item-1:status:completed:v1:/);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/tasks/my-turn",
      expect.any(Object),
    );
  });

  it("separates review items and lets people complete them regardless of assignee kind", async () => {
    const payload = sampleOverview();
    const reviewItem = {
      ...payload.my_turn_items[0]!,
      item_id: "item-review",
      item_title: "Director review",
      status: "review" as const,
      item_version: 5,
      effective_assignee_kind: "agent" as const,
      effective_assignee_agent_id: "roselin",
      effective_assignee_user_id: null,
    };
    payload.my_turn_items.push(reviewItem);
    payload.tasks[0] = {
      ...payload.tasks[0]!,
      items: [
        ...payload.tasks[0]!.items,
        reviewItem,
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(okResponse(payload));
    globalThis.fetch = fetchMock;
    useTaskStore.setState({
      overview: {
        snapshot: payload,
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    expect(container.textContent).toContain("Director review");
    expect(container.textContent).toContain("확인 대기");
    expect(container.querySelector('[data-testid="task-overview-task-attention"]')?.textContent).toBe("2");

    const reviewRow = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="task-overview-group-item"]'),
    ).find((row) => row.textContent?.includes("Director review"));
    expect(reviewRow).not.toBeUndefined();
    const checkbox = reviewRow!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(false);

    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      status: "completed",
      expectedVersion: 5,
    });
    expect(body.idempotencyKey).toMatch(/^task:rb-1:item:item-review:status:completed:v5:/);
  });

  it("opens the task board from a task row without changing selection", () => {
    useTaskStore.setState({
      overview: {
        snapshot: sampleOverview(),
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    const openBoard = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-overview-row-open-board"]',
    );
    expect(openBoard).not.toBeNull();
    const selectedBefore = container.querySelector<HTMLElement>(
      '[data-testid="task-overview-task-row"][aria-selected="true"]',
    )?.dataset.taskId;
    flushSync(() => {
      openBoard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().activeBoardContainer).toEqual({
      kind: "task",
      id: "rb-1",
    });
    expect(useDashboardStore.getState().selectedFolderId).toBe("f1");
    expect(useDashboardStore.getState().viewMode).toBe("folder");
    expect(useDashboardStore.getState().activeTab).toBe("folder");
    expect(container.querySelector<HTMLElement>(
      '[data-testid="task-overview-task-row"][aria-selected="true"]',
    )?.dataset.taskId).toBe(selectedBefore);
  });

  it("renders running sessions with SessionItem and selects the clicked session", () => {
    useDashboardStore.getState().setViewMode("tasks");
    seedSessions([
      {
        agentSessionId: "sess-running",
        status: "running",
        eventCount: 3,
        prompt: "Investigate deploy",
        agentName: "Roselin",
        createdAt: "2026-06-16T00:00:00+00:00",
      },
      {
        agentSessionId: "sess-done",
        status: "completed",
        eventCount: 1,
        prompt: "Finished",
        createdAt: "2026-06-15T00:00:00+00:00",
      },
    ]);
    useTaskStore.setState({
      overview: {
        snapshot: sampleOverview(),
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    expect(container.textContent).toContain("Investigate deploy");
    expect(container.textContent).not.toContain("Finished");
    expect(container.querySelector('[data-testid="task-overview-running-sessions-rail"]')?.className).toContain("overflow-x-auto");
    expect(container.querySelector('[data-testid="task-overview-running-sessions-rail"]')?.className).toContain("h-[7.75rem]");
    const sessionCard = container.querySelector<HTMLElement>('[data-session-id="sess-running"]');
    expect(sessionCard).not.toBeNull();
    useDashboardStore.getState().setActiveSession("sess-running");
    useDashboardStore.getState().setActiveBoardDocument("doc-a");
    flushSync(() => {
      sessionCard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().activeSessionKey).toBe("sess-running");
    expect(useDashboardStore.getState().activeSessionSummary?.agentSessionId).toBe("sess-running");
    expect(useDashboardStore.getState().activeBoardDocumentId).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("tasks");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
  });

  it("separates completed tasks by the orch task_status payload field", () => {
    const payload = sampleOverview();
    payload.tasks.push({
      ...payload.tasks[0]!,
      task_id: "rb-done",
      task_title: "Completed Task",
      task_status: "completed",
      task_version: 4,
      completed_count: 2,
      total_count: 2,
      items: [{
        ...payload.tasks[0]!.items[0]!,
        task_id: "rb-done",
        item_id: "done-item",
        item_title: "Done item",
        status: "completed",
      }],
    });
    useTaskStore.setState({
      overview: {
        snapshot: payload,
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      renderOverview();
    });

    expect(container.querySelector('[data-testid="task-overview-completed-groups"]')).not.toBeNull();
    expect(container.textContent).toContain("완료됨");
    expect(container.textContent).not.toContain("Completed Task");

    const completedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-overview-completed-groups"] button',
    );
    expect(completedToggle).not.toBeNull();
    flushSync(() => {
      completedToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Completed Task");
  });
});

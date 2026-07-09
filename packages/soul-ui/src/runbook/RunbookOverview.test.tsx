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
  type RunbookOverviewPayload,
  useRunbookStore,
} from "../stores/runbook-store";
import { RunbookOverview } from "./RunbookOverview";

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

function sampleOverview(): RunbookOverviewPayload {
  const myTurnItem = {
    runbook_id: "rb-1",
    runbook_title: "Deploy Runbook",
    board_item_id: "runbook:rb-1",
    folder_id: "f1",
    section_id: "sec-1",
    section_title: "Release",
    item_id: "item-1",
    item_title: "Operator approval",
    how_to: "Approve the deployment window.",
    status: "pending" as const,
    item_version: 1,
    runbook_created_session_id: "sess-runbook",
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
    runbooks: [
      {
        runbook_id: "rb-1",
        runbook_title: "Deploy Runbook",
        board_item_id: "runbook:rb-1",
        folder_id: "f1",
        runbook_status: "open",
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

describe("RunbookOverview", () => {
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
    useRunbookStore.getState().reset();
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    useDashboardStore.getState().reset();
    useRunbookStore.getState().reset();
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  function renderOverview() {
    root.render(createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RunbookOverview),
    ));
  }

  function seedSessions(sessions: SessionSummary[]) {
    queryClient.setQueryData<InfiniteData<SessionPage>>(["sessions", "all", "feed", null], {
      pages: [{ sessions, total: sessions.length }],
      pageParams: [0],
    });
  }

  it("renders compact running sessions, split panes, runbook rows, and selected items", () => {
    useRunbookStore.setState({
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

    expect(container.querySelector('[data-testid="runbook-overview-dashboard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="runbook-overview-running-sessions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="runbook-overview-my-turn"]')).toBeNull();
    expect(container.querySelector('[data-testid="runbook-overview-my-turn-rail"]')).toBeNull();
    expect(container.querySelector('[data-testid="runbook-overview-split-layout"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="runbook-overview-runbook-list-scroll"]')?.className).toContain("overflow-y-auto");
    expect(container.querySelector('[data-testid="runbook-overview-selected-items-scroll"]')?.className).toContain("overflow-y-auto");
    expect(container.querySelector("main")?.style.scrollbarGutter).toBe("stable");
    expect(container.querySelector("main")?.style.paddingInline).toBe("16px");
    const row = container.querySelector<HTMLElement>('[data-testid="runbook-overview-runbook-row"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute("aria-selected")).toBe("true");
    expect(row!.className).toContain("glass");
    expect(container.querySelector('[data-testid="runbook-overview-runbook-attention"]')?.textContent).toBe("1");
    expect(container.textContent).toContain("Operator approval");
    expect(container.textContent).toContain("Deploy Runbook");
    expect(container.textContent).toContain("1/2");
    expect(container.textContent).toContain("실행 중인 세션 없음");
    expect(container.textContent).not.toContain("Approve the deployment window.");
    expect(container.textContent).not.toContain("PR-3b 대기");
    expect(container.textContent).toContain("Agent verification");
    expect(container.querySelector('[data-testid="runbook-overview-item-how-to"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="runbook-overview-item-how-to-trigger"]').length).toBeGreaterThanOrEqual(1);
    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("feed");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
  });

  it("marks only runbooks with current attention and switches the lower item pane on row selection", () => {
    const payload = sampleOverview();
    payload.runbooks.push({
      ...payload.runbooks[0]!,
      runbook_id: "rb-2",
      runbook_title: "QA Runbook",
      board_item_id: "runbook:rb-2",
      completed_count: 0,
      total_count: 1,
      items: [{
        ...payload.runbooks[0]!.items[0]!,
        runbook_id: "rb-2",
        item_id: "qa-item",
        item_title: "Smoke tests",
        status: "pending",
      }],
    });
    useRunbookStore.setState({
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

    expect(container.querySelectorAll('[data-testid="runbook-overview-runbook-attention"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="runbook-overview-selected-items"]')?.textContent).toContain("Operator approval");
    expect(container.querySelector('[data-testid="runbook-overview-selected-items"]')?.textContent).not.toContain("Smoke tests");

    const qaRow = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="runbook-overview-runbook-row"]'),
    ).find((row) => row.textContent?.includes("QA Runbook"));
    expect(qaRow).not.toBeUndefined();
    flushSync(() => {
      qaRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(qaRow!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="runbook-overview-selected-items"]')?.textContent).toContain("Smoke tests");
    expect(container.querySelector('[data-testid="runbook-overview-selected-items"]')?.textContent).not.toContain("Operator approval");
  });

  it("omits the how-to hover trigger when an item has no how_to", () => {
    const payload = sampleOverview();
    payload.my_turn_items[0] = {
      ...payload.my_turn_items[0]!,
      how_to: "",
    };
    payload.runbooks[0] = {
      ...payload.runbooks[0]!,
      items: [{
        ...payload.runbooks[0]!.items[0]!,
        how_to: "",
      }],
    };
    useRunbookStore.setState({
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

    expect(container.querySelector('[data-testid="runbook-overview-item-how-to-trigger"]')).toBeNull();
    expect(container.textContent).not.toContain("상세 절차 없음");
  });

  it("posts a selected item checkbox status mutation and reloads the overview", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(okResponse(sampleOverview()));
    globalThis.fetch = fetchMock;
    useRunbookStore.setState({
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
      '[data-testid="runbook-overview-group-item"] input[type="checkbox"]',
    );
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runbooks/rb-1/items/item-1/status",
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
    expect(body.idempotencyKey).toMatch(/^runbook:rb-1:item:item-1:status:completed:v1:/);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runbooks/my-turn",
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
    payload.runbooks[0] = {
      ...payload.runbooks[0]!,
      items: [
        ...payload.runbooks[0]!.items,
        reviewItem,
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(okResponse(payload));
    globalThis.fetch = fetchMock;
    useRunbookStore.setState({
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
    expect(container.querySelector('[data-testid="runbook-overview-runbook-attention"]')?.textContent).toBe("2");

    const reviewRow = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="runbook-overview-group-item"]'),
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
    expect(body.idempotencyKey).toMatch(/^runbook:rb-1:item:item-review:status:completed:v5:/);
  });

  it("opens the runbook board from a runbook row without changing selection", () => {
    useRunbookStore.setState({
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
      '[data-testid="runbook-overview-row-open-board"]',
    );
    expect(openBoard).not.toBeNull();
    const selectedBefore = container.querySelector<HTMLElement>(
      '[data-testid="runbook-overview-runbook-row"][aria-selected="true"]',
    )?.dataset.runbookId;
    flushSync(() => {
      openBoard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().activeBoardContainer).toEqual({
      kind: "runbook",
      id: "rb-1",
    });
    expect(useDashboardStore.getState().selectedFolderId).toBe("f1");
    expect(useDashboardStore.getState().viewMode).toBe("folder");
    expect(useDashboardStore.getState().activeTab).toBe("folder");
    expect(container.querySelector<HTMLElement>(
      '[data-testid="runbook-overview-runbook-row"][aria-selected="true"]',
    )?.dataset.runbookId).toBe(selectedBefore);
  });

  it("renders running sessions with SessionItem and selects the clicked session", () => {
    useDashboardStore.getState().setViewMode("runbooks");
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
    useRunbookStore.setState({
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
    expect(container.querySelector('[data-testid="runbook-overview-running-sessions-rail"]')?.className).toContain("overflow-x-auto");
    expect(container.querySelector('[data-testid="runbook-overview-running-sessions-rail"]')?.className).toContain("h-[7.75rem]");
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
    expect(useDashboardStore.getState().viewMode).toBe("runbooks");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
  });

  it("separates completed runbooks by the orch runbook_status payload field", () => {
    const payload = sampleOverview();
    payload.runbooks.push({
      ...payload.runbooks[0]!,
      runbook_id: "rb-done",
      runbook_title: "Completed Runbook",
      runbook_status: "completed",
      runbook_version: 4,
      completed_count: 2,
      total_count: 2,
      items: [{
        ...payload.runbooks[0]!.items[0]!,
        runbook_id: "rb-done",
        item_id: "done-item",
        item_title: "Done item",
        status: "completed",
      }],
    });
    useRunbookStore.setState({
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

    expect(container.querySelector('[data-testid="runbook-overview-completed-groups"]')).not.toBeNull();
    expect(container.textContent).toContain("완료됨");
    expect(container.textContent).not.toContain("Completed Runbook");

    const completedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="runbook-overview-completed-groups"] button',
    );
    expect(completedToggle).not.toBeNull();
    flushSync(() => {
      completedToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Completed Runbook");
  });
});

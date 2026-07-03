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

  beforeEach(() => {
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

  it("renders the dashboard sections, compact my-turn cards, and collapsed runbook groups", () => {
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
    expect(container.querySelector('[data-testid="runbook-overview-my-turn"]')).not.toBeNull();
    expect(container.querySelector("main")?.style.scrollbarGutter).toBe("stable");
    expect(container.querySelector("main")?.style.paddingInline).toBe("16px");
    expect(container.querySelector('[data-testid="runbook-overview-group"]')?.className)
      .toContain("liquid-glass-card");
    expect(container.textContent).toContain("Operator approval");
    expect(container.textContent).toContain("Deploy Runbook");
    expect(container.textContent).toContain("1/2");
    expect(container.textContent).toContain("실행 중인 세션 없음");
    expect(container.textContent).not.toContain("Approve the deployment window.");
    expect(container.textContent).not.toContain("PR-3b 대기");
    expect(container.textContent).not.toContain("Agent verification");
    expect(container.querySelector('[data-testid="runbook-overview-item-how-to"]')).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="runbook-overview-group-toggle"]');
    expect(toggle).not.toBeNull();
    flushSync(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Agent verification");

    const myTurn = container.querySelector<HTMLElement>('[data-testid="runbook-overview-my-turn-item"]');
    expect(myTurn).not.toBeNull();
    expect(myTurn!.className).toContain("glass");
    expect(container.querySelectorAll('[data-testid="runbook-overview-item-how-to-trigger"]').length)
      .toBeGreaterThanOrEqual(3);
    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("feed");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
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

  it("posts a my-turn checkbox status mutation and reloads the overview", async () => {
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
      '[data-testid="runbook-overview-my-turn-item"] input[type="checkbox"]',
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

  it("opens the runbook board card without toggling item details", () => {
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
      '[data-testid="runbook-overview-open-board"]',
    );
    expect(openBoard).not.toBeNull();
    flushSync(() => {
      openBoard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().focusedBoardItem).toMatchObject({
      boardItemId: "runbook:rb-1",
      folderId: "f1",
    });
    expect(useDashboardStore.getState().viewMode).toBe("folder");
    expect(useDashboardStore.getState().activeTab).toBe("folder");
  });

  it("renders running sessions with SessionItem and selects the clicked session", () => {
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
    const sessionCard = container.querySelector<HTMLElement>('[data-session-id="sess-running"]');
    expect(sessionCard).not.toBeNull();
    flushSync(() => {
      sessionCard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().activeSessionKey).toBe("sess-running");
    expect(useDashboardStore.getState().activeSessionSummary?.agentSessionId).toBe("sess-running");
    expect(useDashboardStore.getState().activeTab).toBe("chat");
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

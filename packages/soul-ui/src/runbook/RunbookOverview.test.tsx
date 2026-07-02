/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useDashboardStore.getState().reset();
    useRunbookStore.getState().reset();
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    useDashboardStore.getState().reset();
    useRunbookStore.getState().reset();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the global my-turn list, collapsed runbook groups, and keeps item clicks in runbooks", () => {
    useRunbookStore.setState({
      overview: {
        snapshot: sampleOverview(),
        status: "ready",
        error: null,
        isRefreshing: false,
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookOverview));
    });

    expect(container.querySelector('[data-testid="runbook-overview-my-turn"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="runbook-overview-my-turn"]')?.className)
      .toContain("liquid-glass-card");
    expect(container.querySelector('[data-testid="runbook-overview-group"]')?.className)
      .toContain("liquid-glass-card");
    expect(container.textContent).toContain("Operator approval");
    expect(container.textContent).toContain("Deploy Runbook");
    expect(container.textContent).toContain("1/2");
    expect(container.textContent).not.toContain("PR-3b 대기");
    expect(container.textContent).not.toContain("Agent verification");

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="runbook-overview-group-toggle"]');
    expect(toggle).not.toBeNull();
    flushSync(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Agent verification");

    const myTurn = container.querySelector<HTMLElement>('[data-testid="runbook-overview-my-turn-item"]');
    expect(myTurn).not.toBeNull();
    expect(myTurn!.className).toContain("glass");
    const detailToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="runbook-overview-my-turn-item-detail-toggle"]',
    );
    expect(detailToggle).not.toBeNull();
    flushSync(() => {
      detailToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Approve the deployment window.");
    expect(container.querySelector('[data-testid="runbook-overview-item-detail"]')?.className)
      .toContain("glass");
    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("feed");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
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
      root.render(createElement(RunbookOverview));
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
      root.render(createElement(RunbookOverview));
    });

    const openBoard = container.querySelector<HTMLButtonElement>(
      '[data-testid="runbook-overview-open-board"]',
    );
    expect(openBoard).not.toBeNull();
    flushSync(() => {
      openBoard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).not.toContain("Approve the deployment window.");
    expect(useDashboardStore.getState().focusedBoardItem).toMatchObject({
      boardItemId: "runbook:rb-1",
      folderId: "f1",
    });
    expect(useDashboardStore.getState().viewMode).toBe("folder");
    expect(useDashboardStore.getState().activeTab).toBe("folder");
  });
});

/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import {
  type RunbookOverviewPayload,
  useRunbookStore,
} from "../stores/runbook-store";
import { RunbookOverview } from "./RunbookOverview";

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

    const myTurn = container.querySelector<HTMLButtonElement>('[data-testid="runbook-overview-my-turn-item"]');
    expect(myTurn).not.toBeNull();
    flushSync(() => {
      myTurn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Approve the deployment window.");
    expect(useDashboardStore.getState().focusedBoardItem).toBeNull();
    expect(useDashboardStore.getState().viewMode).toBe("feed");
    expect(useDashboardStore.getState().activeTab).toBe("feed");
  });
});

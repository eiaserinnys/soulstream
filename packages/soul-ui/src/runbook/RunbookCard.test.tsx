/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRunbookStore, type RunbookSnapshot } from "../stores/runbook-store";
import { RunbookCard } from "./RunbookCard";

const originalFetch = globalThis.fetch;

function sampleSnapshot(): RunbookSnapshot {
  return {
    runbook: {
      id: "rb-1",
      board_item_id: "runbook:rb-1",
      folder_id: "f1",
      title: "Deploy Runbook",
      archived: false,
      version: 2,
      created_session_id: "sess-actor",
      created_event_id: null,
      created_at: "2026-06-16T00:00:00+00:00",
      updated_at: "2026-06-16T00:00:00+00:00",
    },
    sections: [
      {
        id: "sec-1",
        runbook_id: "rb-1",
        position_key: "a",
        title: "Release",
        archived: false,
        version: 1,
        assignee_kind: "human",
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: "operator@example.com",
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
    ],
    items: [
      {
        id: "item-1",
        section_id: "sec-1",
        position_key: "a",
        title: "Run migration check",
        how_to: "Run `pnpm test` before handoff.",
        status: "pending",
        archived: false,
        version: 1,
        assignee_kind: null,
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
      {
        id: "item-2",
        section_id: "sec-1",
        position_key: "b",
        title: "Agent finished",
        how_to: "Done docs should stay folded.",
        status: "completed",
        archived: false,
        version: 1,
        assignee_kind: "agent",
        assignee_agent_id: "roselin",
        assignee_session_id: null,
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: "agent",
        completed_session_id: "sess-1",
        completed_event_id: 10,
        completed_user_id: null,
        completed_at: "2026-06-16T00:01:00+00:00",
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
      {
        id: "item-3",
        section_id: "sec-1",
        position_key: "c",
        title: "Cancelled path",
        how_to: "Cancelled docs should stay folded.",
        status: "cancelled",
        archived: false,
        version: 1,
        assignee_kind: "session",
        assignee_agent_id: null,
        assignee_session_id: "sess-2",
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
      {
        id: "item-4",
        section_id: "sec-1",
        position_key: "d",
        title: "Archived item",
        how_to: "",
        status: "pending",
        archived: true,
        version: 1,
        assignee_kind: null,
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: null,
        created_session_id: null,
        created_event_id: null,
        updated_session_id: null,
        updated_event_id: null,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: "2026-06-16T00:00:00+00:00",
        updated_at: "2026-06-16T00:00:00+00:00",
      },
    ],
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.includes(text));
}

async function waitForText(root: ParentNode, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (root.textContent?.includes(text)) return;
    await flushPromises();
  }
  expect(root.textContent).toContain(text);
}

describe("RunbookCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    useRunbookStore.getState().reset();
    globalThis.fetch = originalFetch;
  });

  it("renders progress, human turn highlight, active human write state, and folded terminal how_to", () => {
    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const html = container.innerHTML;
    const card = container.querySelector<HTMLElement>('[data-testid="runbook-card"]');

    expect(card?.className).toContain("liquid-glass-card");
    expect(html).toContain("Deploy Runbook");
    expect(html).toContain("1/2");
    expect(html).toContain("내 차례");
    expect(html).not.toContain("PR-3b 대기");
    expect(html).toContain("Run migration check");
    expect(html).toContain("Run <code");
    expect(html).toContain("Cancelled path");
    expect(html).toContain("line-through");
    expect(html).not.toContain("Done docs should stay folded");
    expect(html).not.toContain("Cancelled docs should stay folded");
    expect(html).not.toContain("Archived item");

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    const statusToggle = container.querySelector<HTMLElement>('[data-testid="runbook-status-toggle"]');
    const itemRow = container.querySelector<HTMLElement>('[data-testid="runbook-item-row"]');
    expect(checkbox).not.toBeNull();
    expect(statusToggle).not.toBeNull();
    expect(itemRow).not.toBeNull();
    expect(checkbox!.disabled).toBe(false);
    expect(checkbox!.className).toContain("h-5");
    expect(checkbox!.className).toContain("w-5");
    expect(statusToggle!.className).toContain("min-h-10");
    expect(statusToggle!.textContent).toContain("대기");
    expect(itemRow!.className).toContain("glass");
  });

  it("can open every item procedure by default for the task checklist surface", () => {
    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
        defaultItemDetailsOpen: true,
        textSize: "session",
      }));
    });

    expect(container.textContent).toContain("Run pnpm test before handoff.");
    expect(container.textContent).toContain("Done docs should stay folded.");
    expect(container.textContent).toContain("Cancelled docs should stay folded.");
    expect(container.querySelector<HTMLElement>('[data-testid="runbook-section-toggle"]')?.className)
      .toContain("text-sm");
    expect(container.querySelector<HTMLElement>('[data-testid="runbook-item-title"]')?.className)
      .toContain("text-[14.5px]");
    expect(container.querySelector<HTMLElement>('[data-testid="runbook-how-to"]')?.className)
      .toContain("text-sm");
  });

  it("renders a runbook board affordance that does not arm tile dragging", () => {
    const onOpenBoard = vi.fn();
    const onParentPointerDown = vi.fn();
    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(
        "div",
        { onPointerDown: onParentPointerDown },
        createElement(RunbookCard, {
          runbookId: "rb-1",
          fallbackTitle: "Fallback",
          onOpenBoard,
        }),
      ));
    });

    const openBoard = container.querySelector<HTMLButtonElement>('[data-testid="runbook-card-open-board"]');
    expect(openBoard).not.toBeNull();
    expect(openBoard!.className).toContain("dashboard-icon-cap");
    expect(openBoard!.title).toBe("Deploy Runbook 런북 보드 열기");

    openBoard!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    openBoard!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onOpenBoard).toHaveBeenCalledWith("rb-1");
  });

  it("shows the reason when a human checkbox has no session provenance", () => {
    const noSessionSnapshot = sampleSnapshot();
    noSessionSnapshot.runbook = {
      ...noSessionSnapshot.runbook,
      created_session_id: null,
    };
    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: noSessionSnapshot,
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    const statusToggle = container.querySelector<HTMLElement>('[data-testid="runbook-status-toggle"]');
    expect(checkbox).not.toBeNull();
    expect(statusToggle).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
    expect(checkbox!.title).toBe("세션 정보 없음");
    expect(statusToggle!.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector("[data-testid='runbook-checkbox-disabled-reason']")?.textContent)
      .toBe("세션 정보 없음");
  });

  it("posts authenticated human item status updates through the runbook store", async () => {
    const nextSnapshot = sampleSnapshot();
    nextSnapshot.items[0] = {
      ...nextSnapshot.items[0]!,
      status: "completed",
      version: 2,
      completed_kind: "user",
      completed_session_id: "sess-actor",
      completed_user_id: "operator@example.com",
      completed_at: "2026-06-16T00:02:00+00:00",
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      ok: true,
      snapshot: nextSnapshot,
    }));
    globalThis.fetch = fetchMock;

    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
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
    expect(useRunbookStore.getState().byId["rb-1"].snapshot?.items[0]?.completed_user_id).toBe(
      "operator@example.com",
    );
  });

  it("re-reads and retries a stale item version through the shared status toggle", async () => {
    const freshSnapshot = sampleSnapshot();
    freshSnapshot.items[0] = {
      ...freshSnapshot.items[0]!,
      version: 2,
    };
    const completedSnapshot = sampleSnapshot();
    completedSnapshot.items[0] = {
      ...completedSnapshot.items[0]!,
      status: "completed",
      version: 3,
      completed_kind: "user",
      completed_session_id: "sess-actor",
      completed_user_id: "operator@example.com",
      completed_at: "2026-06-16T00:02:00+00:00",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(409, {
        detail: {
          error: {
            code: "RUNBOOK_VERSION_CONFLICT",
            message: "항목 버전이 오래되었습니다.",
          },
        },
      }))
      .mockResolvedValueOnce(okResponse(freshSnapshot))
      .mockResolvedValueOnce(okResponse({ ok: true, snapshot: completedSnapshot }));
    globalThis.fetch = fetchMock;

    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    for (let attempt = 0; attempt < 20 && fetchMock.mock.calls.length < 3; attempt += 1) {
      await flushPromises();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runbooks/rb-1/items/item-1/status");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toMatchObject({
      status: "completed",
      expectedVersion: 1,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/runbooks/rb-1");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/runbooks/rb-1/items/item-1/status");
    const retryBody = JSON.parse(fetchMock.mock.calls[2]?.[1].body as string);
    expect(retryBody).toMatchObject({
      status: "completed",
      expectedVersion: 2,
    });
    expect(retryBody.idempotencyKey).toMatch(/^runbook:rb-1:item:item-1:status:completed:v2:/);
    expect(useRunbookStore.getState().byId["rb-1"].snapshot?.items[0]?.status).toBe("completed");
  });

  it("posts authenticated runbook completion updates from the card header", async () => {
    const nextSnapshot = sampleSnapshot();
    nextSnapshot.runbook = {
      ...nextSnapshot.runbook,
      status: "completed",
      version: 3,
      completed_kind: "user",
      completed_session_id: "sess-actor",
      completed_at: "2026-06-16T00:03:00+00:00",
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      ok: true,
      snapshot: nextSnapshot,
    }));
    globalThis.fetch = fetchMock;

    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const openDialog = container.querySelector<HTMLButtonElement>('button[aria-label="런북 완료"]');
    expect(openDialog).not.toBeUndefined();
    flushSync(() => {
      openDialog!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.includes("런북 완료"))
      .at(-1);
    expect(confirm).not.toBeUndefined();
    flushSync(() => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runbooks/rb-1/status",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      status: "completed",
      expectedVersion: 2,
    });
    expect(body.idempotencyKey).toMatch(/^runbook:rb-1:status:completed:v2:/);
    expect(useRunbookStore.getState().byId["rb-1"].snapshot?.runbook.status).toBe("completed");
  });

  it("shows the server error message when a status update fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(409, {
      detail: {
        error: {
          message: "항목 버전이 오래되었습니다. 새로고침 후 다시 시도하세요.",
        },
      },
    }));
    globalThis.fetch = fetchMock;

    useRunbookStore.setState({
      byId: {
        "rb-1": {
          snapshot: sampleSnapshot(),
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(RunbookCard, {
        runbookId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitForText(container, "항목 버전이 오래되었습니다. 새로고침 후 다시 시도하세요.");
  });
});

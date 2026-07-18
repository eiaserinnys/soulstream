/**
 * @vitest-environment jsdom
 */

import { createElement, StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskStore, type TaskSnapshot } from "../stores/task-store";
import { TaskCard } from "./TaskCard";

const originalFetch = globalThis.fetch;

function sampleSnapshot(): TaskSnapshot {
  return {
    task: {
      id: "rb-1",
      board_item_id: "task:rb-1",
      folder_id: "f1",
      title: "Deploy Task",
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
        task_id: "rb-1",
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

describe("TaskCard", () => {
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
    useTaskStore.getState().reset();
    globalThis.fetch = originalFetch;
  });

  it("treats an unseen projection as loading instead of a missing task", () => {
    const html = renderToStaticMarkup(createElement(TaskCard, {
      taskId: "rb-new",
      fallbackTitle: "새 업무",
    }));

    expect(html).toContain("불러오는 중");
    expect(html).not.toContain("업무를 찾을 수 없음");
  });

  it("keeps a shared projection retry alive across a StrictMode effect probe", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(404, { detail: "projection pending" }))
      .mockResolvedValueOnce(okResponse(sampleSnapshot()));
    globalThis.fetch = fetchMock;

    flushSync(() => {
      root.render(createElement(
        StrictMode,
        null,
        createElement(TaskCard, { taskId: "rb-1", fallbackTitle: "Fallback" }),
      ));
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await waitForText(container, "Deploy Task");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("업무를 찾을 수 없음");
  });

  it("renders progress, human turn highlight, active human write state, and folded item details", () => {
    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const html = container.innerHTML;
    const card = container.querySelector<HTMLElement>('[data-testid="task-card"]');

    expect(card?.className).toContain("liquid-glass-card");
    expect(html).toContain("Deploy Task");
    expect(html).toContain("1/2");
    expect(html).not.toContain("내 차례");
    expect(html).not.toContain("PR-3b 대기");
    expect(html).toContain("Run migration check");
    expect(html).not.toContain("Run <code");
    expect(html).toContain("Cancelled path");
    expect(html).toContain("line-through");
    expect(html).not.toContain("Done docs should stay folded");
    expect(html).not.toContain("Cancelled docs should stay folded");
    expect(html).not.toContain("Archived item");

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    const statusToggle = container.querySelector<HTMLElement>('[data-testid="task-status-toggle"]');
    const itemRow = container.querySelector<HTMLElement>('[data-testid="task-item-row"]');
    expect(checkbox).not.toBeNull();
    expect(statusToggle).not.toBeNull();
    expect(itemRow).not.toBeNull();
    expect(checkbox!.disabled).toBe(false);
    expect(checkbox!.className).toContain("h-4");
    expect(checkbox!.className).toContain("w-4");
    expect(statusToggle!.className).toContain("h-7");
    expect(statusToggle!.className).not.toContain("glass");
    expect(statusToggle!.className).not.toContain("border-glass-border");
    expect(statusToggle!.textContent).not.toContain("대기");
    expect(itemRow!.className).not.toContain("glass");
    expect(itemRow!.className).not.toContain("border-glass-border");
    expect(container.querySelector('[data-testid="task-how-to"]')).toBeNull();
    expect(container.textContent).not.toContain("항목 추가");
    expect(container.textContent).not.toContain("섹션 추가");
  });

  it("keeps human-assigned item details closed and groups one shared action primitive with the row menu", () => {
    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
        textSize: "session",
        editable: true,
      }));
    });

    const firstItem = container.querySelectorAll<HTMLElement>('[data-testid="task-item-row"]')[0];
    const actionGroup = firstItem?.querySelector<HTMLElement>('[data-testid="task-item-actions"]');
    const menu = firstItem?.querySelector<HTMLButtonElement>('[data-testid="task-row-menu"]');
    const detailsToggle = firstItem?.querySelector<HTMLButtonElement>('[data-testid="task-item-details-toggle"]');

    expect(firstItem).toBeDefined();
    expect(actionGroup).not.toBeNull();
    expect(menu).not.toBeNull();
    expect(detailsToggle).not.toBeNull();
    expect(menu!.parentElement).toBe(actionGroup);
    expect(detailsToggle!.parentElement).toBe(actionGroup);
    expect(menu!.nextElementSibling).toBe(detailsToggle);
    expect(menu!.getAttribute("data-task-row-action")).toBe("");
    expect(detailsToggle!.getAttribute("data-task-row-action")).toBe("");
    expect(detailsToggle!.textContent).toBe("");
    expect(detailsToggle!.getAttribute("aria-expanded")).toBe("false");
    expect(detailsToggle!.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(container.textContent).not.toContain("Run pnpm test before handoff.");
    expect(firstItem!.textContent).not.toContain("operator@example.com");
    expect(container.textContent).not.toContain("내 차례");
    expect(container.textContent).not.toContain("절차");

    flushSync(() => {
      detailsToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(detailsToggle!.getAttribute("aria-expanded")).toBe("true");
    expect(detailsToggle!.querySelector(".lucide-chevron-up")).not.toBeNull();
    expect(container.textContent).toContain("Run pnpm test before handoff.");
    expect(firstItem!.textContent).toContain("operator@example.com");
    expect(container.textContent).toContain("내 차례");
    expect(container.querySelector<HTMLElement>('[data-testid="task-section-toggle"]')?.className)
      .toContain("text-sm");
    expect(container.querySelector<HTMLElement>('[data-testid="task-item-title"]')?.className)
      .toContain("text-[14.5px]");
    expect(container.querySelector<HTMLElement>('[data-testid="task-how-to"]')?.className)
      .toContain("text-sm");
  });

  it("keeps an assignee-only detail hidden until the disclosure opens", () => {
    const snapshot = sampleSnapshot();
    snapshot.items[1]!.how_to = "";
    useTaskStore.setState({
      byId: {
        "rb-1": {
          snapshot,
          status: "ready",
          error: null,
          isRefreshing: false,
        },
      },
    });

    flushSync(() => {
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
        editable: true,
      }));
    });

    const secondItem = container.querySelectorAll<HTMLElement>('[data-testid="task-item-row"]')[1];
    const detailsToggle = secondItem?.querySelector<HTMLButtonElement>('[data-testid="task-item-details-toggle"]');
    expect(detailsToggle).not.toBeNull();
    expect(secondItem?.textContent).not.toContain("roselin");

    flushSync(() => {
      detailsToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(secondItem?.textContent).toContain("roselin");
    expect(secondItem?.querySelector('[data-testid="task-how-to"]')).not.toBeNull();
  });

  it("renders a task board affordance that does not arm tile dragging", () => {
    const onOpenBoard = vi.fn();
    const onParentPointerDown = vi.fn();
    useTaskStore.setState({
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
        createElement(TaskCard, {
          taskId: "rb-1",
          fallbackTitle: "Fallback",
          onOpenBoard,
        }),
      ));
    });

    const openBoard = container.querySelector<HTMLButtonElement>('[data-testid="task-card-open-board"]');
    expect(openBoard).not.toBeNull();
    expect(openBoard!.className).toContain("dashboard-icon-cap");
    expect(openBoard!.title).toBe("Deploy Task 업무 보드 열기");

    openBoard!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    openBoard!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onOpenBoard).toHaveBeenCalledWith("rb-1");
  });

  it("keeps editing quiet until the task-detail surface asks for it", async () => {
    const nextSnapshot = sampleSnapshot();
    nextSnapshot.sections = [
      ...nextSnapshot.sections,
      {
        ...nextSnapshot.sections[0]!,
        id: "sec-server",
        position_key: "b",
        title: "검수",
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      ok: true,
      snapshot: nextSnapshot,
    }));
    globalThis.fetch = fetchMock;
    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
        editable: true,
      }));
    });

    const addSection = findButtonByText(container, "섹션 추가");
    expect(addSection).not.toBeUndefined();
    flushSync(() => addSection!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="섹션 제목"]');
    expect(input).not.toBeNull();
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "검수");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const editor = container.querySelector('[data-testid="task-section-editor"]');
    const submit = findButtonByText(editor!, "추가");
    expect(submit).not.toBeUndefined();
    flushSync(() => submit!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/rb-1/sections",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ title: "검수", afterSectionId: "sec-1" });
    expect(body.sectionId).toEqual(expect.any(String));
    expect(container.textContent).toContain("검수");
  });

  it("shows the reason when a human checkbox has no session provenance", () => {
    const noSessionSnapshot = sampleSnapshot();
    noSessionSnapshot.task = {
      ...noSessionSnapshot.task,
      created_session_id: null,
    };
    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    const statusToggle = container.querySelector<HTMLElement>('[data-testid="task-status-toggle"]');
    expect(checkbox).not.toBeNull();
    expect(statusToggle).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
    expect(checkbox!.title).toBe("세션 정보 없음");
    expect(statusToggle!.getAttribute("aria-disabled")).toBe("true");
    expect(container.querySelector("[data-testid='task-checkbox-disabled-reason']")).toBeNull();
  });

  it("posts authenticated human item status updates through the task store", async () => {
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

    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
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
    expect(useTaskStore.getState().byId["rb-1"].snapshot?.items[0]?.completed_user_id).toBe(
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
            code: "TASK_VERSION_CONFLICT",
            message: "항목 버전이 오래되었습니다.",
          },
        },
      }))
      .mockResolvedValueOnce(okResponse(freshSnapshot))
      .mockResolvedValueOnce(okResponse({ ok: true, snapshot: completedSnapshot }));
    globalThis.fetch = fetchMock;

    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
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
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tasks/rb-1/items/item-1/status");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body as string)).toMatchObject({
      status: "completed",
      expectedVersion: 1,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/tasks/rb-1");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/tasks/rb-1/items/item-1/status");
    const retryBody = JSON.parse(fetchMock.mock.calls[2]?.[1].body as string);
    expect(retryBody).toMatchObject({
      status: "completed",
      expectedVersion: 2,
    });
    expect(retryBody.idempotencyKey).toMatch(/^task:rb-1:item:item-1:status:completed:v2:/);
    expect(useTaskStore.getState().byId["rb-1"].snapshot?.items[0]?.status).toBe("completed");
  });

  it("posts authenticated task completion updates from the card header", async () => {
    const nextSnapshot = sampleSnapshot();
    nextSnapshot.task = {
      ...nextSnapshot.task,
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

    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const openDialog = container.querySelector<HTMLButtonElement>('button[aria-label="업무 완료"]');
    expect(openDialog).not.toBeUndefined();
    flushSync(() => {
      openDialog!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .filter((button) => button.textContent?.includes("업무 완료"))
      .at(-1);
    expect(confirm).not.toBeUndefined();
    flushSync(() => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/rb-1/status",
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
    expect(body.idempotencyKey).toMatch(/^task:rb-1:status:completed:v2:/);
    expect(useTaskStore.getState().byId["rb-1"].snapshot?.task.status).toBe("completed");
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

    useTaskStore.setState({
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
      root.render(createElement(TaskCard, {
        taskId: "rb-1",
        fallbackTitle: "Fallback",
      }));
    });

    const checkbox = container.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    checkbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await waitForText(container, "항목 버전이 오래되었습니다. 새로고침 후 다시 시도하세요.");
  });
});

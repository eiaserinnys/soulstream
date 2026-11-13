/**
 * @vitest-environment jsdom
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { createProcessingContext } from "../../stores/processing-context";
import { ChatToolApproval } from "./ChatToolApproval";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message = {
  approvalId: "approval-1",
  treeNodeId: "node-1",
  toolName: "파일 읽기",
} as unknown as ChatMessage;

function renderApproval() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ChatToolApproval, { msg: message, sessionId: "session-1" }));
  });
  return { container, root };
}

async function pressButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ChatToolApproval 실패 표시", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("실패 응답이면 선택을 되돌리고 버튼 아래에 알린다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "" });
    ({ container, root } = renderApproval());

    await pressButton(container, "승인");

    await vi.waitFor(() => {
      expect(container?.querySelector('[role="alert"]')?.textContent)
        .toBe("연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.");
    });
    expect(container.querySelector("button")?.disabled).toBe(false);
  });

  it("이미 끝난 요청(409)은 그 사실을 알린다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, text: async () => "" });
    ({ container, root } = renderApproval());

    await pressButton(container, "거부");

    await vi.waitFor(() => {
      expect(container?.querySelector('[role="alert"]')?.textContent)
        .toBe("이미 끝난 요청이라 보내지 못했습니다.");
    });
  });

  it("이미 처리된 요청이면 보내지 않고 실패 문구도 남기지 않는다", async () => {
    const ctx = createProcessingContext();
    ctx.nodeMap.set("node-1", {
      id: "node-1",
      type: "tool_approval",
      approvalId: "approval-1",
      toolName: "파일 읽기",
      content: "",
      completed: true,
      resolved: true,
      children: [],
    } as never);
    useDashboardStore.setState({ processingCtx: ctx });
    ({ container, root } = renderApproval());

    await pressButton(container, "승인");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("성공하면 실패 문구를 남기지 않는다", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    ({ container, root } = renderApproval());

    await pressButton(container, "승인");

    await vi.waitFor(() => expect(container?.textContent).toContain("승인됨"));
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });
});

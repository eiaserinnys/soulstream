/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import type { EventTreeNode, InputRequestNodeDef, ToolApprovalNodeDef } from "../shared/types";
import { AskQuestionBanner } from "./AskQuestionBanner";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeRoot(child: EventTreeNode): EventTreeNode {
  return {
    id: "session-root",
    type: "session",
    sessionId: "session-1",
    content: "",
    completed: false,
    children: [child],
  };
}

function makeInputRequest(): InputRequestNodeDef {
  return {
    id: "input-request-1",
    type: "input_request",
    requestId: "request-1",
    content: "Question",
    completed: false,
    children: [],
    responded: false,
    expired: false,
    timeoutSec: 300,
    questions: [
      {
        header: "Layout",
        question: "설정 창처럼 긴 선택지를 읽을 수 있게 충분한 폭으로 보여줄까요?",
        options: [
          {
            label: "피드와 동일 / (평면 카드)",
            description: "긴 설명이 여러 줄로 과도하게 꺾이지 않도록 배너 폭을 넓힙니다.",
          },
        ],
      },
    ],
  };
}

function makeToolApproval(): ToolApprovalNodeDef {
  return {
    id: "tool-approval-1",
    type: "tool_approval",
    approvalId: "approval-1",
    toolName: "request_user_input",
    toolInput: { question: "계속 진행할까요?", options: ["진행", "중단"] },
    content: "Approval",
    completed: false,
    children: [],
    resolved: false,
  };
}

function renderBanner(node: EventTreeNode) {
  useDashboardStore.setState({
    activeSessionKey: "session-1",
    tree: makeRoot(node),
    treeVersion: 1,
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(AskQuestionBanner));
  });

  return { container, root };
}

describe("AskQuestionBanner", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses a wider viewport-bound layout for ask-user-question prompts", () => {
    ({ container, root } = renderBanner(makeInputRequest()));

    const banner = document.body.querySelector<HTMLElement>('[data-testid="ask-question-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.className).toContain("w-[min(720px,calc(100vw-2rem))]");
    expect(banner?.className).toContain("max-w-3xl");
    expect(banner?.className).not.toContain("max-w-[500px]");
    expect(banner?.className).not.toContain("min-w-80");
  });

  it("keeps option labels in a stable column before the description", () => {
    ({ container, root } = renderBanner(makeInputRequest()));

    const optionContent = document.body.querySelector<HTMLElement>(
      '[data-testid="input-request-option-content"]',
    );
    expect(optionContent).not.toBeNull();
    expect(optionContent?.className).toContain(
      "grid-cols-[minmax(11rem,0.85fr)_minmax(0,1.35fr)]",
    );
    expect(optionContent?.className).toContain("max-[560px]:grid-cols-1");

    const optionLabel = document.body.querySelector<HTMLElement>(
      '[data-testid="input-request-option-label"]',
    );
    expect(optionLabel).not.toBeNull();
    expect(optionLabel?.textContent).toBe("피드와 동일 / (평면 카드)");
    expect(optionLabel?.className).toContain("break-keep");
    expect(optionLabel?.className).toContain("[overflow-wrap:anywhere]");
  });

  it("uses the same wider layout for tool approval prompts", () => {
    ({ container, root } = renderBanner(makeToolApproval()));

    const banner = document.body.querySelector<HTMLElement>('[data-testid="tool-approval-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.className).toContain("w-[min(720px,calc(100vw-2rem))]");
    expect(banner?.className).toContain("max-w-3xl");
    expect(banner?.className).not.toContain("max-w-[520px]");
    expect(banner?.className).not.toContain("min-w-80");
  });

  it("shows a retryable error when AskUserQuestion submission fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    ({ container, root } = renderBanner(makeInputRequest()));

    const button = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.includes("피드와 동일"));
    expect(button).toBeTruthy();
    flushSync(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        "응답 전송에 실패했습니다",
      );
    });
    expect(consoleError).toHaveBeenCalled();
    expect(button?.disabled).toBe(false);
  });
});

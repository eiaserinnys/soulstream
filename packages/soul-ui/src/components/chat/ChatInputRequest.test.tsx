/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { useDashboardStore } from "../../stores/dashboard-store";
import { ChatInputRequest } from "./ChatInputRequest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "input-node-1",
    type: "input_request",
    treeNodeId: "root-input-node-1",
    requestId: "request-1",
    receivedAt: Date.now(),
    timeoutSec: 300,
    responded: false,
    expired: false,
    questions: [
      {
        question: "계속 진행할까요?",
        options: [
          { label: "진행", description: "작업을 계속합니다" },
          { label: "중단", description: "여기서 멈춥니다" },
        ],
      },
    ],
    ...overrides,
  } as ChatMessage;
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

describe("ChatInputRequest", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(message = makeMessage()) {
    flushSync(() => {
      root.render(createElement(ChatInputRequest, { msg: message, sessionId: "session-1" }));
    });
  }

  it("submits the selected option as an AskUserQuestion response", async () => {
    render();

    flushSync(() => {
      findButton(container, "진행").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "request-1",
        answers: { "계속 진행할까요?": "진행" },
      }),
    });
    expect(container.textContent).toContain("진행");
  });

  it("submits a direct typed answer through the AskUserQuestion form", async () => {
    render();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="직접 입력"]');
    expect(input).toBeTruthy();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(valueSetter).toBeTruthy();

    flushSync(() => {
      valueSetter!.call(input, "직접 답변");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    flushSync(() => {
      findButton(container, "전송").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "request-1",
        answers: { "계속 진행할까요?": "직접 답변" },
      }),
    });
  });

  it("aligns the direct input and submit button with the banner input-row contract", () => {
    render();

    const input = container.querySelector<HTMLInputElement>('input[placeholder="직접 입력"]');
    const submit = findButton(container, "전송");
    const form = input?.closest("form");

    expect(input).not.toBeNull();
    expect(form).not.toBeNull();
    expect(form?.contains(submit)).toBe(true);
    expect(form?.className).toContain("flex");
    expect(form?.className).toContain("gap-2");
    expect(input?.className).toContain("rounded-[13px]");
    expect(input?.className).toContain("px-3");
    expect(submit.className).toContain("h-auto");
    expect(submit.className).toContain("sm:h-auto");
    expect(submit.className).toContain("self-stretch");
    expect(submit.className).toContain("rounded-[13px]");
    expect(submit.className).toContain("px-3");
    expect(submit.className).not.toContain("sm:h-6");
    expect(submit.className).not.toContain("rounded-full");
  });

  it("shows a retryable error when AskUserQuestion submission fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    render();

    flushSync(() => {
      findButton(container, "진행").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "응답 전송에 실패했습니다",
      );
    });
    expect(consoleError).toHaveBeenCalled();
    expect(findButton(container, "진행").disabled).toBe(false);
  });

  it("keeps long, short, and absent descriptions inside the same auto-height rows as the banner", () => {
    render(makeMessage({
      questions: [
        {
          question: "글래스 최적화",
          options: [
            {
              label: "같이 고쳐서 한 번에 배포 (권장)",
              description:
                "프론트엔드와 백엔드 변경을 함께 검증하고 한 번에 배포합니다. 설명이 여러 줄이 되어도 선택지 행 안에서 끝까지 읽혀야 합니다.",
            },
            { label: "백엔드 먼저", description: "짧은 설명" },
            { label: "설명 없음" },
          ],
        },
      ],
    }));

    const optionContents = Array.from(container.querySelectorAll<HTMLElement>(
      '[data-testid="input-request-option-content"]',
    ));
    expect(optionContents).toHaveLength(3);
    expect(optionContents[0]?.className).toContain(
      "grid-cols-[minmax(11rem,0.85fr)_minmax(0,1.35fr)]",
    );
    expect(optionContents[0]?.className).toContain("max-[560px]:grid-cols-1");
    expect(optionContents[1]?.className).toContain(
      "grid-cols-[minmax(11rem,0.85fr)_minmax(0,1.35fr)]",
    );
    expect(optionContents[2]?.className).toContain("block");

    const optionLabels = Array.from(container.querySelectorAll<HTMLElement>(
      '[data-testid="input-request-option-label"]',
    ));
    expect(optionLabels.map((label) => label.textContent)).toEqual([
      "같이 고쳐서 한 번에 배포 (권장)",
      "백엔드 먼저",
      "설명 없음",
    ]);
    expect(optionLabels[0]?.className).toContain("break-keep");
    expect(optionLabels[0]?.className).toContain("[overflow-wrap:anywhere]");

    const descriptions = Array.from(container.querySelectorAll<HTMLElement>(
      '[data-testid="input-request-option-description"]',
    ));
    expect(descriptions).toHaveLength(2);
    expect(descriptions[0]?.textContent).toContain("설명이 여러 줄이 되어도");
    expect(descriptions[1]?.textContent).toBe("짧은 설명");

    const optionButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-slot="button"]'),
    ).filter((button) => button.textContent !== "전송");
    expect(optionButtons).toHaveLength(3);
    for (const button of optionButtons) {
      expect(button.className).toContain("h-auto");
      expect(button.className).toContain("sm:h-auto");
      expect(button.className).not.toContain("sm:h-8");
    }
  });
});

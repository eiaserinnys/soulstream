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
        requestId: "request-1",
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
        requestId: "request-1",
        answers: { "계속 진행할까요?": "직접 답변" },
      }),
    });
  });
});

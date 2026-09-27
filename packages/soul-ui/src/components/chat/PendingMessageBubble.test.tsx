/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingChatSend } from "../../stores/dashboard-store-types";
import { mergePendingTextIntoComposer } from "./pending-chat-send";
import { PendingMessageBubble } from "./PendingMessageBubble";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("PendingMessageBubble", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("shows the failure reason and routes retry/restore actions for its session cell", () => {
    const pending: PendingChatSend = {
      id: "pending-1",
      status: "failed",
      text: "실패 문장",
      messageText: "실패 문장\n\n[첨부 파일 로컬 경로: /tmp/a.png]",
      attachmentPaths: ["/tmp/a.png"],
      attachments: [],
      mode: "resume",
      reason: "전달을 확인하지 못했습니다",
    };
    const onRetry = vi.fn();
    const onRestore = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <PendingMessageBubble
        sessionId="session-7"
        pending={pending}
        onRetry={onRetry}
        onRestore={onRestore}
      />,
    ));

    expect(container.textContent).toContain("실패 문장");
    expect(container.textContent).toContain("전달을 확인하지 못했습니다");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["다시 보내기", "입력창으로"]);

    act(() => buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onRetry).toHaveBeenCalledWith("session-7", pending);
    expect(onRestore).toHaveBeenCalledWith("session-7", pending);
  });

  it("restores the failed sentence before any text typed during the wait", () => {
    expect(mergePendingTextIntoComposer("실패 문장", "새 입력")).toBe("실패 문장\n\n새 입력");
    expect(mergePendingTextIntoComposer("실패 문장", "")).toBe("실패 문장");
  });
});

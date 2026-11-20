/** @vitest-environment jsdom */

/**
 * 카드 #1524: 전달 장부에서 실패로 닫힌 사람 발신 말풍선의 표시와 두 단추.
 * 실패 목록은 input_id -> 사유이고, 그 키가 맞는 말풍선에만 붙는다.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { ChatMessageItem } from "./ChatMessageItem";
import { DeliveryFailureBlock } from "./DeliveryFailureBlock";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function makeMessage(
  role: ChatMessage["role"],
  id: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: "전달하지 못한 문장입니다.",
    treeNodeId: `root-${id}`,
    treeNodeType: role,
    ...extra,
  } as ChatMessage;
}

describe("delivery failure bubble", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function renderInteractive(element: ReturnType<typeof createElement>) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(element));
    return host;
  }

  it.each(["user", "intervention"] as const)(
    "shows the failure line and both actions on the failed %s bubble",
    (role) => {
      const msg = makeMessage(role, "failed", {
        inputId: "input-failed",
      });
      const onRetryDelivery = vi.fn();
      const onRestoreDelivery = vi.fn();
      const container = renderInteractive(createElement(ChatMessageItem, {
        msg,
        sessionId: "session-1",
        deliveryFailures: { "input-failed": "runner_receipt_unknown" },
        onRetryDelivery,
        onRestoreDelivery,
      }));

      expect(container.textContent).toContain("전달을 확인하지 못했습니다");
      expect(container.textContent).not.toContain("runner_receipt_unknown");
      const buttons = [...container.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent)).toEqual(["다시 보내기", "입력창으로"]);

      act(() => buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      act(() => buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));

      expect(onRetryDelivery).toHaveBeenCalledWith({
        text: "전달하지 못한 문장입니다.",
        attachmentPaths: [],
      });
      expect(onRestoreDelivery).toHaveBeenCalledWith("전달하지 못한 문장입니다.");
    },
  );

  it("leaves a delivered bubble untouched", () => {
    const msg = makeMessage("user", "delivered", { inputId: "input-ok" });
    const html = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg,
      sessionId: "session-1",
      deliveryFailures: { "input-failed": "runner_receipt_unknown" },
      onRetryDelivery: vi.fn(),
      onRestoreDelivery: vi.fn(),
    }));

    expect(html).not.toContain("전달을 확인하지 못했습니다");
    expect(html).not.toContain("다시 보내기");
  });

  it("keeps only restore when attachments exist but their paths are unknown", () => {
    const msg = makeMessage("user", "attached", {
      inputId: "input-attached",
      attachmentIds: ["asset-1"],
    });
    const html = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg,
      sessionId: "session-1",
      deliveryFailures: { "input-attached": "runner_receipt_unknown" },
      onRetryDelivery: vi.fn(),
      onRestoreDelivery: vi.fn(),
    }));

    expect(html).toContain("전달을 확인하지 못했습니다");
    expect(html).not.toContain("다시 보내기");
    expect(html).toContain("입력창으로");
  });

  it("keeps the exact existing failure classes on the default and manuscript surfaces", () => {
    const defaultHtml = renderToStaticMarkup(createElement(DeliveryFailureBlock, {
      onRetry: vi.fn(),
      onRestore: vi.fn(),
    }));
    const manuscriptHtml = renderToStaticMarkup(createElement(DeliveryFailureBlock, {
      manuscript: true,
      onRetry: vi.fn(),
      onRestore: vi.fn(),
    }));

    expect(defaultHtml).toContain("mt-1 text-right text-xs text-white/90");
    expect(defaultHtml).not.toContain("text-destructive");
    expect(manuscriptHtml).toContain("mt-1 text-right text-xs text-destructive");
    expect(defaultHtml).toContain("mt-2 flex justify-end gap-2");
    expect(defaultHtml).toContain("border-white/30 text-white hover:bg-white/15 hover:text-white");
  });
});

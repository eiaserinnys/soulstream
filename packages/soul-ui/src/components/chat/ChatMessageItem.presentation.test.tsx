/** @vitest-environment jsdom */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { ChatMessageItem } from "./ChatMessageItem";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function makeMessage(role: ChatMessage["role"], id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    content: "첫 문장입니다.\n둘째 문장입니다.",
    treeNodeId: `root-${id}`,
    treeNodeType: role,
    ...extra,
  } as ChatMessage;
}

describe("ChatMessageItem presentation", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("keeps the default bubbles and renders manuscript messages without avatars or bubbles", () => {
    const messages = [
      makeMessage("user", "user-1"),
      makeMessage("assistant", "assistant-1", { isStreaming: true }),
      makeMessage("intervention", "intervention-1"),
    ];

    const defaultHtml = messages.map((msg) => renderToStaticMarkup(
      createElement(ChatMessageItem, { msg }),
    )).join("");
    const manuscriptHtml = messages.map((msg) => renderToStaticMarkup(
      createElement(ChatMessageItem, { msg, presentation: "manuscript" }),
    )).join("");

    expect(defaultHtml).toContain("bg-gradient-to-b");
    expect(defaultHtml).toContain("w-8 h-8");
    expect(manuscriptHtml.match(/data-slot="chat-manuscript-message"/g)).toHaveLength(3);
    expect(manuscriptHtml).not.toContain("bg-gradient-to-b");
    expect(manuscriptHtml).not.toContain("w-8 h-8");
    expect(manuscriptHtml).toContain("text-right");
    expect(manuscriptHtml.match(/ms-12/g)).toHaveLength(2);
    const userHtml = renderToStaticMarkup(createElement(ChatMessageItem, { msg: messages[0]!, presentation: "manuscript" }));
    expect(userHtml).not.toContain("whitespace-pre-wrap");
    expect(manuscriptHtml).toContain("animate-caret-blink");
    expect(manuscriptHtml).toContain("text-muted-foreground");
  });

  it("renders manuscript complete usage as a collapsed caption with the full details inside", () => {
    const msg = makeMessage("system", "complete-18", {
      treeNodeType: "complete",
      turnUsageCaption: {
        title: "컨텍스트 약 63.0% · 정가 $1.40",
        contextText: "컨텍스트 약 6,300 / 10,000 (63.0%)",
        completeText: "입력 1,200 · 출력 340 · 정가 $1.40",
      },
    });

    const html = renderToStaticMarkup(
      createElement(ChatMessageItem, { msg, presentation: "manuscript" }),
    );

    expect(html).toContain('data-slot="collapsible-caption"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("컨텍스트 약 63.0% · 정가 $1.40");
    expect(html).not.toContain("컨텍스트 약 6,300 / 10,000 (63.0%)");
    expect(html).toContain('hidden=""');
    expect(html).toContain("입력 1,200 · 출력 340 · 정가 $1.40");
    expect(html).not.toContain("턴 완료");
  });

  it("expands into two full wrapped rows without repeating the folded title", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const contextText = "컨텍스트 약 645,367 / 1,024,000 (63.0%)";
    const completeText = "입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)";

    act(() => root?.render(createElement(ChatMessageItem, {
      presentation: "manuscript",
      msg: makeMessage("system", "complete-large", {
        treeNodeType: "complete",
        turnUsageCaption: {
          title: "컨텍스트 약 63.0% · 정가 $0.62",
          contextText,
          completeText,
        },
      }),
    })));

    const button = host.querySelector<HTMLButtonElement>('[data-slot="collapsible-caption"] button')!;
    expect(button.textContent).toContain("컨텍스트 약 63.0% · 정가 $0.62");
    expect(button.querySelector("span")?.className).toContain("truncate");

    act(() => button.click());

    const caption = host.querySelector('[data-slot="collapsible-caption"]')!;
    const expandedButton = caption.querySelector("button")!;
    const expandedTitle = expandedButton.querySelector("span")!;
    const details = caption.querySelector("[id]")!;
    expect(expandedTitle.textContent).toBe(contextText);
    expect(expandedTitle.textContent).not.toContain("컨텍스트 약 63.0% · 정가 $0.62");
    expect(expandedTitle.className).toContain("whitespace-normal");
    expect(expandedTitle.className.split(/\s+/)).not.toContain("flex-1");
    expect(expandedTitle.className).not.toContain("truncate");
    expect(expandedButton.className).toContain("!h-auto");
    expect(expandedButton.className.split(/\s+/)).toContain("w-full");
    expect(details.textContent).toBe(completeText);
    expect(caption.textContent?.match(/컨텍스트 약 645,367 \/ 1,024,000 \(63\.0%\)/g)).toHaveLength(1);
  });

  it("keeps the manuscript error row before its usage caption", () => {
    const msg = makeMessage("system", "error-19", {
      treeNodeType: "error",
      content: "응답을 마치지 못했습니다.",
      isError: true,
      turnUsageCaption: {
        title: "컨텍스트 50.0%",
        contextText: "컨텍스트 500 / 1,000 (50.0%)",
      },
    });

    const html = renderToStaticMarkup(
      createElement(ChatMessageItem, { msg, presentation: "manuscript" }),
    );

    expect(html.indexOf("응답을 마치지 못했습니다.")).toBeLessThan(
      html.indexOf('data-slot="collapsible-caption"'),
    );
  });
});

/** @vitest-environment jsdom */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { ChatMessageItem } from "./ChatMessageItem";
import { projectPersistentTurnUsage } from "../../lib/persistent-turn-usage-projection";

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

  it("keeps structured image attachments manuscript-only and after the user text", () => {
    const msg = makeMessage("user", "structured-images", {
      content: "원문 텍스트입니다.",
      attachmentPaths: ["/incoming/first.png", "/incoming/notes.txt", "/incoming/second.webp"],
      attachmentNodeId: "eiaserinnys",
    });
    const defaultHtml = renderToStaticMarkup(createElement(ChatMessageItem, { msg }));
    const manuscriptHtml = renderToStaticMarkup(createElement(ChatMessageItem, { msg, presentation: "manuscript" }));

    expect(defaultHtml).not.toContain('data-chat-image-run="attachments"');
    expect(manuscriptHtml.indexOf("원문 텍스트입니다.")).toBeLessThan(
      manuscriptHtml.indexOf('data-chat-image-run="attachments"'),
    );
    expect(manuscriptHtml).toContain('data-chat-image-count="2"');
    expect(manuscriptHtml).toContain("nodeId=eiaserinnys&amp;path=%2Fincoming%2Ffirst.png");
    expect(manuscriptHtml).toContain("nodeId=eiaserinnys&amp;path=%2Fincoming%2Fsecond.webp");
    expect(manuscriptHtml).not.toContain("notes.txt");
  });

  it("opens the message gallery at the clicked image, navigates, and restores focus without moving scroll", () => {
    const msg = makeMessage("assistant", "gallery", {
      content: "첫 설명입니다.\n\n![첫 이미지](/first.png)\n\n사이 설명입니다.\n\n![둘째 이미지](/second.png)",
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(ChatMessageItem, { msg, presentation: "manuscript" })));

    const body = host.querySelector<HTMLElement>('[data-slot="chat-body"]')!;
    body.scrollTop = 73;
    const triggers = host.querySelectorAll<HTMLImageElement>('[data-chat-image-index] img[role="button"]');
    const trigger = triggers[1]!;
    act(() => trigger.click());

    let dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
    expect(dialog.textContent).toContain("2/2");
    expect(dialog.querySelector<HTMLButtonElement>('[aria-label="다음 이미지"]')?.disabled).toBe(true);
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="이전 이미지"]')!.click());
    dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
    expect(dialog.textContent).toContain("1/2");
    expect(dialog.querySelector<HTMLButtonElement>('[aria-label="이전 이미지"]')?.disabled).toBe(true);

    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());

    expect(document.activeElement).toBe(trigger);
    expect(body.scrollTop).toBe(73);
    expect(document.body.querySelector('[data-slot="dialog-popup"]')).toBeNull();
  });

  it("hides viewer navigation for one image", () => {
    const msg = makeMessage("assistant", "single-image", {
      content: "![단일 이미지](/single.png)",
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(ChatMessageItem, { msg, presentation: "manuscript" })));

    const trigger = host.querySelector<HTMLImageElement>('[data-chat-image-index] img[role="button"]')!;
    act(() => trigger.click());
    const dialog = document.body.querySelector('[data-slot="dialog-popup"]')!;

    expect(dialog.querySelector('[aria-label="이전 이미지"]')).toBeNull();
    expect(dialog.querySelector('[aria-label="다음 이미지"]')).toBeNull();
    expect(dialog.querySelector('.chat-image-viewer-count')).toBeNull();
  });

  it("shows a small image failure status while keeping the message text", () => {
    const msg = makeMessage("assistant", "failed-image", {
      content: "설명은 남아 있습니다.\n\n![열 수 없는 이미지](/missing.png)",
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(ChatMessageItem, { msg, presentation: "manuscript" })));

    const image = host.querySelector<HTMLImageElement>('img[src="/missing.png"]')!;
    act(() => image.dispatchEvent(new Event("error")));

    expect(host.querySelector(".chat-image-status")?.textContent).toBe("이미지를 불러오지 못했습니다.");
    expect(host.textContent).toContain("설명은 남아 있습니다.");
    expect(host.querySelector('img[src="/missing.png"]')).toBeNull();
  });

  it("renders manuscript complete usage collapsed with its details hidden below the header", () => {
    const msg = makeMessage("system", "complete-18", {
      treeNodeType: "complete",
      turnUsageCaption: {
        title: "컨텍스트 약 63.0% · 정가 $1.40",
        contextText: "컨텍스트 약 6,300 / 10,000 (63.0%)",
        completeText: "턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40",
      },
    });

    const html = renderToStaticMarkup(
      createElement(ChatMessageItem, { msg, presentation: "manuscript" }),
    );

    expect(html).toContain('data-slot="turn-end-captions"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("컨텍스트 약 63.0% · 정가 $1.40");
    expect(html).toContain('hidden=""');
    expect(html).toContain("컨텍스트 약 6,300 / 10,000 (63.0%)");
    expect(html).toContain("턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40");
  });

  it("expands context and completion details below a stable header", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const contextText = "컨텍스트 약 645,367 / 1,024,000 (63.0%)";
    const completeText = "턴 완료 · 입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)";

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

    const button = host.querySelector<HTMLButtonElement>('[data-slot="turn-end-captions"] button')!;
    expect(button.textContent).toContain("컨텍스트 약 63.0% · 정가 $0.62");
    expect(button.querySelector("span")?.className).toContain("truncate");
    expect(button.querySelector("span")?.classList.contains("break-keep")).toBe(false);

    act(() => button.click());

    const caption = host.querySelector('[data-slot="turn-end-captions"]')!;
    const expandedButton = caption.querySelector("button")!;
    const expandedTitle = expandedButton.querySelector("span")!;
    const details = caption.querySelector("[id]")!;
    expect(expandedTitle.textContent).toBe("컨텍스트 약 63.0% · 정가 $0.62");
    expect(expandedTitle.className).toContain("truncate");
    expect(expandedTitle.className.split(/\s+/)).not.toContain("flex-1");
    expect(expandedButton.className).not.toContain("!h-auto");
    expect(expandedButton.classList.contains("w-full")).toBe(false);
    expect(expandedButton.classList.contains("max-w-full")).toBe(true);
    expect(details.textContent).toBe(contextText + completeText);
    expect(details.children).toHaveLength(2);
    for (const text of Array.from(details.children)) {
      expect(text.classList.contains("break-keep")).toBe(true);
      expect(text.classList.contains("break-words")).toBe(true);
    }
    expect(caption.textContent?.match(/컨텍스트 약 645,367 \/ 1,024,000 \(63\.0%\)/g)).toHaveLength(1);

    act(() => root?.render(createElement(ChatMessageItem, {
      msg: makeMessage("system", "jev-default", {
        treeNodeType: "persistent_jev_candidates",
        jevCandidates: [],
      }),
    })));
    const defaultButton = host.querySelector("button")!;
    expect(defaultButton.querySelector("span")?.classList.contains("break-keep")).toBe(false);
    act(() => defaultButton.click());
    expect(defaultButton.querySelector("span")?.classList.contains("break-keep")).toBe(false);
  });

  it.each<[string, Partial<ChatMessage>, ChatMessage["contextUsageData"] | undefined, string]>([
    ["price only", { turnCostUsd: 0 }, undefined, "턴 완료 · 정가 $0.00"],
    ["tokens only", { usage: { input_tokens: 150, output_tokens: 35 } }, undefined, "턴 완료 · 입력 150 · 출력 35"],
    ["context and price", { turnCostUsd: 0.62 }, { usedTokens: 326300, maxTokens: 1000000, percent: 32.6 }, "턴 완료 · 정가 $0.62"],
    ["full stats without context", { usage: { input_tokens: 150, output_tokens: 35 }, turnCostUsd: 0.62, sessionCostUsd: 17.91 }, undefined, "턴 완료 · 입력 150 · 출력 35 · 정가 $0.62 (세션 $17.91)"],
  ])("expands %s with the app completion label and each value once in its body", (_label, completeData, context, expected) => {
    const messages = [
      ...(context ? [makeMessage("system", "context", { treeNodeType: "context_usage", contextUsageData: context })] : []),
      makeMessage("system", "complete", { treeNodeType: "complete", ...completeData }),
    ];
    const [msg] = projectPersistentTurnUsage(messages, "collapsed");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(ChatMessageItem, { msg: msg!, presentation: "manuscript" })));
    const button = host.querySelector("button")!;
    expect(button.classList.contains("w-full")).toBe(false);
    act(() => button.click());
    expect(button.classList.contains("w-full")).toBe(false);
    expect(button.classList.contains("max-w-full")).toBe(true);
    const caption = host.querySelector('[data-slot="turn-end-captions"]')!;
    expect(caption.textContent).toContain(expected);
    expect(caption.textContent?.match(/턴 완료/g)).toHaveLength(1);
    if (context) {
      expect(button.textContent).not.toBe("컨텍스트 326,300 / 1,000,000 (32.6%)");
      expect(caption.querySelector("[id]")?.textContent).toContain("컨텍스트 326,300 / 1,000,000 (32.6%)");
      expect(caption.querySelector("[id]")?.textContent).toContain(expected);
    } else {
      expect(button.textContent).not.toBe(expected);
      expect(caption.querySelector("[id]")?.textContent).toBe(expected);
    }
    const detailsText = caption.querySelector("[id]")?.textContent ?? "";
    for (const value of ["$0.00", "$0.62", "입력 150", "출력 35", "$17.91"]) {
      if (expected.includes(value)) expect(detailsText.split(value)).toHaveLength(2);
    }
  });

  it.each(["user", "intervention"] as const)("measures %s manuscript spacing inside its outer row", role => {
    const msg = makeMessage(role, role);
    host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ChatMessageItem, { msg, presentation: "manuscript" }));
    const row = host.querySelector(`[data-tree-node-id="root-${role}"]`)!;
    expect(row.classList.contains("mt-10")).toBe(false);
    expect(row.classList.contains("mb-5")).toBe(false);
    expect(row.classList.contains("pt-10")).toBe(true);
    expect(row.classList.contains("pb-5")).toBe(true);
    const normal = document.createElement("div");
    normal.innerHTML = renderToStaticMarkup(createElement(ChatMessageItem, { msg }));
    expect(normal.querySelector(`[data-tree-node-id="root-${role}"]`)?.className).toBe("flex justify-end gap-2 px-3 py-1.5");
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

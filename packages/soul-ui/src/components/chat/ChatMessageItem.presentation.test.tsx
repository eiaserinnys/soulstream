/** @vitest-environment jsdom */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../../lib/flatten-tree";
import { MarkdownImage } from "../MarkdownImage";
import { ChatMessageItem } from "./ChatMessageItem";
import { projectPersistentTurnUsage } from "../../lib/persistent-turn-usage-projection";
import { ChatUiControllerProvider } from "../chat-ui/ChatUiControllerProvider";
import { isSupportedChatUiPublication } from "../chat-ui/ChatUiMessage";
import { envelope } from "../chat-ui/chat-ui.test-fixture";

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
    vi.unstubAllGlobals();
    root = null;
    host = null;
  });

  it.each(["default", "manuscript"] as const)("scopes only internal attachment links to the row session (%s)", presentation => {
    const msg = makeMessage("user", "links", { content: "[ID](/api/attachments/a/content?download=1#file) [경로](/api/attachments/files?nodeId=node&path=%2Fincoming%2Fa.txt) [외부](https://example.com/api/attachments/a/content) [세션](/sessions/other) [카드](/cards/card)" });
    host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ChatMessageItem, { msg, sessionId: "route-session", presentation }));
    const links = [...host.querySelectorAll("a")].map(a => a.getAttribute("href"));
    expect(links).toEqual([
      "/api/attachments/a/content?download=1&context_type=session&context_id=route-session#file",
      "/api/attachments/files?nodeId=node&path=%2Fincoming%2Fa.txt&context_type=session&context_id=route-session",
      "https://example.com/api/attachments/a/content", "/sessions/other", "/cards/card",
    ]);
  });

  it.each([400, 401, 403, 404, 422, 429, 500, 503])("shows retry only for a server failure (HTTP %s)", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root?.render(createElement(ChatMessageItem, {
      msg: makeMessage("user", "failed-projection", { eventId: 42, attachmentIds: ["asset"] }), sessionId: "session",
    })));
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "다시 시도")).toBe(status >= 500);
    if (status === 400 || status === 422) expect(host.querySelector('[role="status"]')?.textContent).toBe("첨부 정보를 확인할 수 없습니다.");
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

  it("marks only a manuscript narration assistant row", () => {
    const msg = makeMessage("assistant", "narration");
    const manuscriptHtml = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg,
      presentation: "manuscript",
      narration: true,
    } as never));
    const defaultHtml = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg,
      narration: true,
    } as never));

    expect(manuscriptHtml).toContain('data-chat-narration="true"');
    expect(defaultHtml).not.toContain('data-chat-narration="true"');

    const thinking = makeMessage("assistant", "thinking", { treeNodeType: "thinking" });
    const thinkingHtml = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg: thinking,
      presentation: "manuscript",
    }));
    expect(thinkingHtml).toContain('data-chat-narration="true"');
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
    expect(manuscriptHtml).not.toContain("chat-image-metadata");
  });

  it("renders a default row's same internal Markdown image only through its attachment row", async () => {
    const sessionId = "inline-session";
    const message = makeMessage("user", "inline-duplicate", {
      content: "![same image](/api/attachments/inline-asset/content?context_type=session&context_id=inline-session)",
      eventId: 901,
      attachmentIds: ["inline-asset"],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      if (!rawUrl.includes(`/api/sessions/${sessionId}/events/901/attachments`)) {
        throw new Error(`Unexpected request: ${rawUrl}`);
      }
      return new Response(JSON.stringify({
        event_id: 901,
        items: [{
          kind: "asset",
          descriptor: {
            attachment_id: "inline-asset",
            name: "same.png",
            mime_type: "image/png",
            byte_size: 4,
            checksum_sha256: null,
            width: 1,
            height: 1,
            preview_kind: "image",
            preview_mime_type: "image/png",
          },
          read_context: { type: "session", id: sessionId },
          legacy_sources: [],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(ChatMessageItem, { msg: message, sessionId }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    const row = host.querySelector<HTMLElement>('[data-tree-node-id="root-inline-duplicate"]')!;
    expect(row.querySelectorAll('img[src*="inline-asset"]').length).toBe(1);
    expect(row.querySelector('[data-chat-attachment-rows]')).toBeNull();
    expect(row.querySelectorAll('[data-chat-image-index]')).toHaveLength(1);
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
    expect(dialog.querySelector<HTMLButtonElement>('[aria-label="다음 이미지"]')?.getAttribute('aria-disabled')).toBe('true');
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="이전 이미지"]')!.click());
    dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
    expect(dialog.textContent).toContain("1/2");
    expect(dialog.querySelector<HTMLButtonElement>('[aria-label="이전 이미지"]')?.getAttribute('aria-disabled')).toBe('true');

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

  it("chatRefined shows pending until real load or error and reports both callbacks", () => {
    const events: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const renderImage = (src: string) => createElement(MarkdownImage, {
      src,
      alt: "검수 이미지",
      variant: "chatRefined",
      className: "chat-image-thumbnail-image",
      onLoad: loadedSrc => events.push(`load:${loadedSrc}`),
      onError: failedSrc => events.push(`error:${failedSrc}`),
    });

    act(() => root?.render(renderImage("/slow.png")));
    expect(host.querySelector(".chat-image-status")?.textContent).toBe("이미지 불러오는 중…");
    const slowImage = host.querySelector<HTMLImageElement>('img[src="/slow.png"]')!;
    expect(slowImage.classList.contains("chat-image-thumbnail-image")).toBe(true);

    act(() => slowImage.dispatchEvent(new Event("load")));
    expect(host.querySelector(".chat-image-status")).toBeNull();
    expect(events).toEqual(["load:/slow.png"]);

    act(() => root?.render(renderImage("/failed.png")));
    expect(host.querySelector(".chat-image-status")?.textContent).toBe("이미지 불러오는 중…");
    const failedImage = host.querySelector<HTMLImageElement>('img[src="/failed.png"]')!;
    act(() => failedImage.dispatchEvent(new Event("error")));
    expect(host.querySelector(".chat-image-status")).toBeNull();
    expect(events).toEqual(["load:/slow.png", "error:/failed.png"]);
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
    expect(host.querySelector(".chat-image-status")?.textContent).toBe("이미지 불러오는 중…");
    act(() => image.dispatchEvent(new Event("error")));

    expect(host.querySelector(".chat-image-status")?.textContent).toBe("불러오지 못함");
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

  it("loads message attachments in default, manuscript, intervention, assistant, and rich rows using each row's session", async () => {
    expect(isSupportedChatUiPublication(envelope)).toBe(true);
    const scenarios = [
      { id: "default-user", role: "user" as const, presentation: "default" as const, eventId: 101, sessionId: "ordinary-session" },
      { id: "default-intervention", role: "intervention" as const, presentation: "default" as const, eventId: 102, sessionId: "ordinary-session" },
      { id: "default-assistant", role: "assistant" as const, presentation: "default" as const, eventId: 103, sessionId: "ordinary-session" },
      { id: "default-rich", role: "assistant" as const, presentation: "default" as const, eventId: 104, sessionId: "ordinary-session", rich: true },
      { id: "manuscript-user", role: "user" as const, presentation: "manuscript" as const, eventId: 105, sessionId: "pas-session" },
      { id: "manuscript-intervention", role: "intervention" as const, presentation: "manuscript" as const, eventId: 106, sessionId: "pas-session" },
      { id: "manuscript-assistant", role: "assistant" as const, presentation: "manuscript" as const, eventId: 107, sessionId: "overlay-session" },
      { id: "manuscript-rich", role: "assistant" as const, presentation: "manuscript" as const, eventId: 108, sessionId: "overlay-session", rich: true },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, window.location.origin);
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events\/(\d+)\/attachments$/);
      if (!match) throw new Error(`Unexpected request: ${url.pathname}`);
      const sessionId = decodeURIComponent(match[1]!);
      const eventId = Number(match[2]);
      const asset = (suffix: string, name: string, mimeType: string, previewKind: "image" | "info") => ({
        kind: "asset" as const,
        descriptor: {
          attachment_id: `asset-${eventId}-${suffix}`,
          name,
          mime_type: mimeType,
          byte_size: 4,
          checksum_sha256: null,
          width: previewKind === "image" ? 1 : null,
          height: previewKind === "image" ? 1 : null,
          preview_kind: previewKind,
          preview_mime_type: previewKind === "image" ? mimeType : null,
        },
        read_context: { type: "session" as const, id: sessionId },
        legacy_sources: [],
      });
      const body = {
        event_id: eventId,
        items: [
          asset("image", `${eventId}.png`, "image/png", "image"),
          asset("file", `${eventId}.zip`, "application/zip", "info"),
        ],
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ChatUiControllerProvider sessionId="pas-session">
          {scenarios.map(scenario => {
            const msg = makeMessage(scenario.role, scenario.id, {
              eventId: scenario.eventId,
              attachmentIds: [`asset-${scenario.eventId}-image`, `asset-${scenario.eventId}-file`],
              ...(scenario.rich ? { ui: envelope } : {}),
            });
            return <ChatMessageItem key={scenario.id} msg={msg} sessionId={scenario.sessionId} presentation={scenario.presentation} />;
          })}
        </ChatUiControllerProvider>,
      );
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    for (const scenario of scenarios) {
      const row = host.querySelector<HTMLElement>(`[data-tree-node-id="root-${scenario.id}"]`)!;
      expect(row).toBeTruthy();
      expect(row.querySelector(`.chat-image-run[data-chat-image-role="${scenario.role === "assistant" ? "assistant" : "user"}"]`)).not.toBeNull();
      expect(row.querySelector("[data-chat-attachment-rows]")).not.toBeNull();
      expect(row.classList.contains("justify-end")).toBe(scenario.role !== "assistant");
    }
    expect(fetchMock).toHaveBeenCalledTimes(scenarios.length);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/sessions/overlay-session/events/107/attachments"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/sessions/pas-session/events/105/attachments"))).toBe(true);
    expect(host.querySelector('[data-tree-node-id="root-default-rich"] [data-slot="chat-ui"]')).not.toBeNull();

    const trigger = host.querySelector<HTMLImageElement>('[data-tree-node-id="root-default-user"] [data-chat-image-index] img[role="button"]')!;
    await act(async () => trigger.click());
    let dialog = document.body.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
    expect(dialog.textContent).toContain("101.png");
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector('[data-slot="dialog-popup"]')).toBeNull();
  });
});

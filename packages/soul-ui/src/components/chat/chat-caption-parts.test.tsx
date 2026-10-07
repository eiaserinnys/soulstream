/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CollapsibleCaption } from "./CollapsibleCaption";
import { SystemMessage } from "./SystemMessage";
import { TurnEndCaptions } from "./TurnEndCaptions";
import { LabeledDivider } from "./LabeledDivider";
import type { ChatMessage } from "../../lib/flatten-tree";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("chat caption parts", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root !== null) act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("toggles the controlled content and exposes its expanded state", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <CollapsibleCaption title="Jev 후보 3">
        <span>T38 · 요약 한 줄 · 3/3</span>
      </CollapsibleCaption>,
    ));

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.className).toContain("!text-xs");
    expect(button?.className).toContain("!font-medium");
    expect(button?.classList.contains("max-w-full")).toBe(true);
    expect(button?.classList.contains("w-full")).toBe(false);
    expect(button?.className).toContain("h-6");
    expect(button?.className).not.toContain("px-2");
    const contentId = button?.getAttribute("aria-controls");
    expect(contentId).toBeTruthy();
    expect(document.getElementById(contentId!)?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector("[id]")?.className).toContain("mt-0.5");

    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(contentId!)?.hasAttribute("hidden")).toBe(false);
  });

  it("uses initiallyCollapsed only when first mounted", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <CollapsibleCaption title="Jev 후보 0" initiallyCollapsed={false}>
        <span>2점 이상인 후보가 없습니다.</span>
      </CollapsibleCaption>,
    ));

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("true");

    act(() => root?.render(
      <CollapsibleCaption title="Jev 후보 0" initiallyCollapsed>
        <span>2점 이상인 후보가 없습니다.</span>
      </CollapsibleCaption>,
    ));

    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the end variant beside the trailing avatar slot and right-aligns its content", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <CollapsibleCaption title="Jev 후보 1" align="end" initiallyCollapsed={false}>
        <span className="truncate">긴 후보 설명</span>
      </CollapsibleCaption>,
    ));

    const row = container.querySelector('[data-slot="collapsible-caption"]');
    const button = container.querySelector("button");
    expect(row?.className).toContain("justify-end");
    expect(row?.querySelector(".w-8")).not.toBeNull();
    const content = row?.children[0];
    expect(content?.classList.contains("w-full")).toBe(true);
    expect(content?.classList.contains("max-w-[86%]")).toBe(true);
    expect(content?.classList.contains("items-end")).toBe(true);
    expect(container.querySelector("[id]")?.classList.contains("max-w-full")).toBe(true);
    expect(button?.className).toContain("-me-2");
    expect(button?.className).toContain("!pe-2");
    expect(button?.className).toContain("justify-end");
    expect(button?.className).not.toContain("-ms-2");
    expect(container.querySelector("[hidden]")).toBeNull();
  });

  it("removes avatar insets when caption rows align to manuscript content", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <>
        <CollapsibleCaption title="Jev 후보 1" align="end" alignmentInset="content">
          <span>후보</span>
        </CollapsibleCaption>
        <LabeledDivider label="새 세대" alignmentInset="content" />
      </>,
    ));

    const caption = container.querySelector('[data-slot="collapsible-caption"]');
    const divider = container.querySelector('[data-slot="labeled-divider-row"]');
    expect(caption?.querySelector(".w-8")).toBeNull();
    expect(caption?.className).not.toContain("px-3");
    expect(divider?.querySelector(".w-8")).toBeNull();
    expect(divider?.className).not.toContain("px-3");
  });

  it("separates turn-end usage and summary bodies by one spacing token", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <TurnEndCaptions
        usageCaption={{ title: "사용량", contextText: "컨텍스트", completeText: "턴 완료" }}
        summaryCaption={{ treeNodeId: "summary", content: "요약 내용" }}
      />,
    ));

    const headers = container.querySelectorAll("button");
    act(() => {
      headers[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      headers[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const bodies = container.querySelectorAll("[id]");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.className).toContain("mt-0.5");
    expect(bodies[1]?.className).toContain("mt-2");
  });

  it("keeps the summary-only body at the default caption spacing", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <TurnEndCaptions summaryCaption={{ treeNodeId: "summary", content: "요약 내용" }} />,
    ));

    expect(container.querySelector("[id]")?.className).toContain("mt-0.5");
  });

  // jsdom does not load Tailwind CSS; browser captures verify the rendered bounds.
  it.each([
    ["content", "end", "-me-px", "!pe-0", "-me-2"],
    ["content", "start", "-ms-px", "!ps-0", "-ms-2"],
    ["avatar", "end", "-me-2", "!pe-2", "-me-px"],
    ["avatar", "start", "-ms-2", "justify-start", "-ms-px"],
  ] as const)("keeps %s %s caption edges within their inset contract", (alignmentInset, align, margin, padding, excludedMargin) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <CollapsibleCaption title="Jev 후보 1" alignmentInset={alignmentInset} align={align}>
        <span>후보</span>
      </CollapsibleCaption>,
    ));

    const button = container.querySelector("button")!;
    expect(button.classList.contains(margin)).toBe(true);
    expect(button.classList.contains(padding)).toBe(true);
    expect(button.classList.contains(excludedMargin)).toBe(false);
  });

  it("renders a labeled, non-interactive separator with decorative lines", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<LabeledDivider label="새 세대" />));

    const separator = container.querySelector('[role="separator"]');
    expect(separator?.getAttribute("aria-label")).toBe("새 세대");
    expect(separator?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(container.querySelector('[role="separator"]')?.className).toContain("my-10");
    expect(container.querySelector('[role="separator"] [aria-hidden="true"]')?.className).toContain("border-input");
    expect(
      container.querySelector('[role="separator"] span:not([aria-hidden="true"])')?.className,
    ).toContain("truncate");
    expect(container.querySelector('[data-slot="labeled-divider-row"]')).not.toBeNull();
    expect(container.querySelectorAll(".w-8")).toHaveLength(1);
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps usage and summary collapsed independently in one right-aligned header row", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(
      <TurnEndCaptions
        usageCaption={{
          title: "컨텍스트 약 63% · 정가 $1.40",
          contextText: "컨텍스트 6,300 / 10,000 (63.0%)",
          completeText: "턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40",
        }}
        summaryCaption={{ treeNodeId: "summary-1", content: "이번 턴에서 화면을 정리했습니다." }}
      />,
    ));

    const row = container.querySelector('[data-slot="turn-end-captions"]');
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(row?.className).toContain("justify-end");
    expect(buttons.map(button => button.textContent)).toEqual([
      "컨텍스트 약 63% · 정가 $1.40", "요약",
    ]);
    expect(buttons.map(button => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    const usageBodyId = buttons[0]?.getAttribute("aria-controls");
    const summaryBodyId = buttons[1]?.getAttribute("aria-controls");
    expect(document.getElementById(usageBodyId!)?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById(summaryBodyId!)?.hasAttribute("hidden")).toBe(true);

    act(() => buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(buttons.map(button => button.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(document.getElementById(usageBodyId!)?.textContent).toContain("컨텍스트 6,300 / 10,000");
    expect(document.getElementById(usageBodyId!)?.textContent).toContain("턴 완료 · 입력 1,200");
    expect(document.getElementById(summaryBodyId!)?.hasAttribute("hidden")).toBe(true);

    act(() => buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(buttons.map(button => button.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(document.getElementById(summaryBodyId!)?.textContent).toBe("이번 턴에서 화면을 정리했습니다.");

    act(() => buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(buttons.map(button => button.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(document.getElementById(usageBodyId!)?.hasAttribute("hidden")).toBe(true);
    expect(document.getElementById(summaryBodyId!)?.hasAttribute("hidden")).toBe(false);
    expect(Array.from(row?.querySelectorAll("[id]") ?? []).map(body => body.textContent)).toEqual([
      "컨텍스트 6,300 / 10,000 (63.0%)턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40",
      "이번 턴에서 화면을 정리했습니다.",
    ]);
  });

  it("uses turn-end captions only in the manuscript while keeping the default summary row", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const summary: ChatMessage = {
      id: "summary-1",
      role: "system",
      content: "요약 본문",
      treeNodeId: "summary-1",
      treeNodeType: "turn_summary",
    };

    act(() => root?.render(
      <>
        <SystemMessage msg={summary} presentation="manuscript" />
        <SystemMessage msg={summary} />
      </>,
    ));

    expect(Array.from(container.querySelectorAll("button")).map(button => button.textContent)).toEqual(["요약"]);
    expect(container.textContent).toContain("요약 본문");
    expect(container.querySelectorAll('[data-slot="turn-end-captions"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-tree-node-id="summary-1"]')).toHaveLength(2);
  });
});

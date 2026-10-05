/**
 * @vitest-environment jsdom
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CollapsibleCaption } from "./CollapsibleCaption";
import { LabeledDivider } from "./LabeledDivider";

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
});

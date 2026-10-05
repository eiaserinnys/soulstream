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
    const contentId = button?.getAttribute("aria-controls");
    expect(contentId).toBeTruthy();
    expect(document.getElementById(contentId!)?.hasAttribute("hidden")).toBe(true);

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

  it("renders a labeled, non-interactive separator with decorative lines", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<LabeledDivider label="새 세대" />));

    const separator = container.querySelector('[role="separator"]');
    expect(separator?.getAttribute("aria-label")).toBe("새 세대");
    expect(separator?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    expect(container.querySelector("button")).toBeNull();
  });
});

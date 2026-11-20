/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LiquidGlassCard, supportsLiquidGlassEnhancement } from "./LiquidGlassCard";

describe("LiquidGlassCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container?.remove();
    document.querySelectorAll('[data-liquid-glass-shared-resource="true"]').forEach((node) => node.remove());
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the fallback surface as the root element in unsupported environments", () => {
    expect(supportsLiquidGlassEnhancement()).toBe(false);

    flushSync(() => {
      root!.render(
        createElement(
          LiquidGlassCard,
          {
            className: "custom-card",
            "data-testid": "glass-card",
            "data-custom": "kept",
          },
          "Card body",
        ),
      );
    });

    const card = container!.querySelector<HTMLElement>('[data-testid="glass-card"]');
    expect(card).not.toBeNull();
    expect(card!.className).toContain("liquid-glass-card");
    expect(card!.className).toContain("custom-card");
    expect(card!.dataset.custom).toBe("kept");
    expect(card!.dataset.liquidGlassEnhanced).toBe("false");
    expect(card!.textContent).toBe("Card body");
    expect(card!.querySelector(".liquid-glass-card__layer")).toBeNull();
  });

  it("anchors the enhanced layer to the full card bounds", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => true) });

    flushSync(() => {
      root!.render(
        createElement(
          LiquidGlassCard,
          {
            className: "custom-card",
            cornerRadius: "2xl",
            "data-testid": "glass-card",
          },
          "Card body",
        ),
      );
    });

    const card = container!.querySelector<HTMLElement>('[data-testid="glass-card"]');
    const layer = card!.querySelector<HTMLElement>(".liquid-glass-card__layer");
    const effect = card!.querySelector<HTMLElement>(".liquid-glass-card__effect");

    expect(card!.dataset.liquidGlassEnhanced).toBe("true");
    expect(layer).not.toBeNull();
    expect(effect).not.toBeNull();
    expect(effect!.style.position).toBe("absolute");
    expect(effect!.style.top).toBe("50%");
    expect(effect!.style.left).toBe("50%");
    expect(effect!.style.width).toBe("100%");
    expect(effect!.style.height).toBe("100%");
    expect(effect!.style.transform).toContain("-50%");
  });

  it("makes the inner glass and rim follow the frame radius instead of setting their own", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => true) });

    flushSync(() => {
      root!.render(
        createElement(
          LiquidGlassCard,
          { className: "rounded-3xl", cornerRadius: "3xl", "data-testid": "glass-card" },
          "Card body",
        ),
      );
    });

    const card = container!.querySelector<HTMLElement>('[data-testid="glass-card"]');
    const glass = card!.querySelector<HTMLElement>(".liquid-glass-card__effect > .glass");
    const rims = [...card!.querySelectorAll<HTMLElement>(".liquid-glass-card__layer > span")];

    // cornerRadius는 틀의 곡률 변수만 정하고, 안쪽 요소는 인라인 곡률을 직접 쓰지 않는다.
    expect(card!.style.getPropertyValue("--liquid-glass-radius")).toBe("var(--radius-3xl)");
    expect(glass).not.toBeNull();
    expect(glass!.style.borderRadius).toBe("");
    expect(rims).toHaveLength(2);
    for (const rim of rims) expect(rim.style.borderRadius).toBe("");
  });

  it("shares one enhanced filter resource across many card surfaces", () => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => true) });
    const createElementSpy = vi.spyOn(document, "createElement");

    flushSync(() => {
      root!.render(
        createElement(
          "div",
          null,
          createElement(LiquidGlassCard, { "data-testid": "glass-a" }, "A"),
          createElement(LiquidGlassCard, { "data-testid": "glass-b" }, "B"),
          createElement(LiquidGlassCard, { "data-testid": "glass-c" }, "C"),
        ),
      );
    });

    expect(container!.querySelectorAll(".liquid-glass-card__effect")).toHaveLength(3);
    expect(document.querySelectorAll('[data-liquid-glass-shared-resource="true"]')).toHaveLength(1);
    expect(document.querySelectorAll("filter#liquid-glass-card-shared-filter-standard")).toHaveLength(1);
    expect(
      document
        .querySelector("filter#liquid-glass-card-shared-filter-standard feImage")
        ?.getAttribute("href"),
    ).toMatch(/^data:image\/jpeg;base64,/);
    expect(
      createElementSpy.mock.calls.filter(([tagName]) => tagName === "canvas"),
    ).toHaveLength(0);

    const warps = container!.querySelectorAll<HTMLElement>(".glass__warp");
    expect(warps).toHaveLength(3);
    warps.forEach((warp) => {
      expect(warp.style.filter).toBe("url(#liquid-glass-card-shared-filter-standard)");
      expect(warp.style.backdropFilter).toBe("blur(4.64px) saturate(125%)");
    });
  });
});

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
            cornerRadius: 18,
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

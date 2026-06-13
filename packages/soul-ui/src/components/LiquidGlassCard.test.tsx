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
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
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
});

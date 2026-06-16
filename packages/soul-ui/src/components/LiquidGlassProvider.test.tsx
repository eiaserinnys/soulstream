/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEBGL_GLASS_STORAGE_KEY } from "../lib/webgl-glass";
import { LiquidGlassCard } from "./LiquidGlassCard";
import { LiquidGlassProvider } from "./LiquidGlassProvider";

describe("LiquidGlassProvider", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let getContextSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    getContextSpy?.mockRestore();
    container?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    root = undefined;
    container = undefined;
    getContextSpy = undefined;
  });

  it("stays no-op when the localStorage flag is enabled but WebGL2 is unavailable", () => {
    window.localStorage.setItem(WEBGL_GLASS_STORAGE_KEY, "1");
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(() => null);

    flushSync(() => {
      root!.render(
        createElement(
          LiquidGlassProvider,
          null,
          createElement(
            LiquidGlassCard,
            { webglSurface: true, "data-testid": "surface" },
            "Surface",
          ),
        ),
      );
    });

    const card = container!.querySelector<HTMLElement>('[data-testid="surface"]');
    expect(card).not.toBeNull();
    expect(card!.dataset.liquidGlassWebgl).toBeUndefined();
    expect(container!.querySelector("[data-liquid-glass-webgl-provider='true']")).toBeNull();
  });
});

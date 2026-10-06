/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardIconCap } from "./DashboardIconCap";

const glass = vi.hoisted(() => ({
  surface: vi.fn((_ref: { current: HTMLButtonElement | null }, _options: { enabled: boolean }) => true),
  lens: vi.fn((_ref: { current: HTMLButtonElement | null }, _options: { scale: number; enabled: boolean }) => {}),
}));
vi.mock("./LiquidGlassProvider", () => ({ useGlassSurface: glass.surface }));
vi.mock("../lib/liquid-lens", () => ({ useLiquidLens: glass.lens }));

describe("DashboardIconCap", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("owns the v1 cap chrome, accessible name, tooltip, and toggle state", () => {
    const onClick = vi.fn();
    flushSync(() => root.render(
      <DashboardIconCap label="별표 추가" aria-pressed={false} onClick={onClick}>
        <span aria-hidden="true">☆</span>
      </DashboardIconCap>,
    ));

    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button?.className).toContain("dashboard-icon-cap");
    expect(button?.getAttribute("data-slot")).toBe("dashboard-icon-cap");
    expect(button?.getAttribute("aria-label")).toBe("별표 추가");
    expect(button?.title).toBe("별표 추가");
    expect(button?.getAttribute("aria-pressed")).toBe("false");

    button?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("connects an external object ref and the internal glass ref to the same button", () => {
    const external = createRef<HTMLButtonElement>();
    flushSync(() => root.render(<DashboardIconCap ref={external} label="선택"/>));
    const button = container.querySelector("button");
    expect(external.current).toBe(button);
    expect(glass.surface.mock.lastCall?.[0].current).toBe(button);
    expect(glass.lens.mock.lastCall?.[0].current).toBe(button);
    expect(glass.lens.mock.lastCall?.[1]).toEqual({ scale: 22, enabled: false });
    expect(button?.getAttribute("data-liquid-glass-webgl")).toBe("true");
    flushSync(() => root.render(null));
    expect(external.current).toBeNull();
  });

  it("connects and clears a trigger callback ref", () => {
    const external = vi.fn();
    flushSync(() => root.render(<DashboardIconCap ref={external} label="선택"/>));
    expect(external).toHaveBeenLastCalledWith(container.querySelector("button"));
    flushSync(() => root.render(null));
    expect(external).toHaveBeenLastCalledWith(null);
  });
});

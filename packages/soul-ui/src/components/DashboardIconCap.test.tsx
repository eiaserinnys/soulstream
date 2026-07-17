/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardIconCap } from "./DashboardIconCap";

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
});

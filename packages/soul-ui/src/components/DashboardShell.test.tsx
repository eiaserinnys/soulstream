/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import { DashboardShell } from "./DashboardShell";
import { DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY } from "./dashboard-sidebar-collapse";

function renderShell() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  useDashboardStore.getState().reset();
  flushSync(() => {
    root.render(createElement(DashboardShell, {
      title: "Dashboard",
      leftPanel: createElement("div", { "data-testid": "folders-panel" }, "left"),
      leftFeedPanel: createElement("div", { "data-testid": "feed-panel" }, "feed"),
      centerPanel: createElement("div", null, "center"),
      rightPanel: createElement("div", null, "right"),
    }));
  });
  return { container, root };
}

describe("DashboardShell", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    window.localStorage.clear();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  it("collapses and persists the desktop left sidebar", () => {
    ({ container, root } = renderShell());

    const sidebar = container.querySelector<HTMLElement>('[data-testid="session-panel"]');
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="left-sidebar-toggle"]');
    expect(sidebar?.style.width).toBe("264px");

    flushSync(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(sidebar?.style.width).toBe("44px");
    expect(window.localStorage.getItem(DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
  });

  it("renders the desktop left sidebar in the standard layout", () => {
    ({ container, root } = renderShell());

    expect(container.querySelector('[data-testid="session-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="left-sidebar-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="folders-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("center");
    expect(container.textContent).toContain("right");
  });

  it("toggles the desktop left sidebar between folders and feed", () => {
    ({ container, root } = renderShell());

    expect(container.querySelector('[data-testid="folders-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="feed-panel"]')).toBeNull();

    const feedToggle = container.querySelector<HTMLButtonElement>('[data-testid="left-navigation-feed"]');
    expect(feedToggle).not.toBeNull();

    flushSync(() => {
      feedToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="folders-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="feed-panel"]')).not.toBeNull();
    expect(useDashboardStore.getState().leftNavigationMode).toBe("feed");
    expect(window.localStorage.getItem("soul-dashboard-storage")).toContain('"leftNavigationMode":"feed"');
  });
});

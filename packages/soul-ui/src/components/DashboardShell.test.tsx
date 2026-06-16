/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDashboardStore } from "../stores/dashboard-store";
import { DashboardShell, type DashboardShellProps } from "./DashboardShell";
import {
  DASHBOARD_LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY,
  DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./dashboard-sidebar-collapse";

function renderShell(props: Partial<DashboardShellProps> = {}) {
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
      ...props,
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

  it("renders the desktop folder navigation label in Korean", () => {
    ({ container, root } = renderShell());

    const foldersToggle = container.querySelector<HTMLButtonElement>('[data-testid="left-navigation-folders"]');
    expect(foldersToggle).not.toBeNull();
    expect(foldersToggle?.textContent).toContain("폴더");
    expect(foldersToggle?.textContent).not.toContain("Folders");
  });

  it("switches desktop navigation to the center feed while keeping folders in the sidebar", () => {
    ({ container, root } = renderShell());

    expect(container.querySelector('[data-testid="folders-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="feed-panel"]')).toBeNull();

    const feedToggle = container.querySelector<HTMLButtonElement>('[data-testid="left-navigation-feed"]');
    expect(feedToggle).not.toBeNull();

    flushSync(() => {
      feedToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="folders-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="feed-panel"]')).toBeNull();
    expect(useDashboardStore.getState().leftNavigationMode).toBe("feed");
    expect(useDashboardStore.getState().viewMode).toBe("feed");
    expect(window.localStorage.getItem("soul-dashboard-storage")).toContain('"leftNavigationMode":"feed"');
  });

  it("syncs desktop navigation back to folders when folder selection changes the center surface", () => {
    ({ container, root } = renderShell());

    const feedToggle = container.querySelector<HTMLButtonElement>('[data-testid="left-navigation-feed"]');
    const foldersToggle = container.querySelector<HTMLButtonElement>('[data-testid="left-navigation-folders"]');
    expect(feedToggle).not.toBeNull();
    expect(foldersToggle).not.toBeNull();

    flushSync(() => {
      feedToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(feedToggle?.getAttribute("aria-pressed")).toBe("true");

    flushSync(() => {
      useDashboardStore.getState().selectFolder("folder-a");
    });

    expect(useDashboardStore.getState().viewMode).toBe("folder");
    expect(useDashboardStore.getState().leftNavigationMode).toBe("folders");
    expect(feedToggle?.getAttribute("aria-pressed")).toBe("false");
    expect(foldersToggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("adds runbooks as a desktop navigation surface", () => {
    ({ container, root } = renderShell());

    const runbooksToggle = container.querySelector<HTMLButtonElement>('[data-testid="left-navigation-runbooks"]');
    expect(runbooksToggle).not.toBeNull();
    expect(runbooksToggle?.textContent).toContain("런북");

    flushSync(() => {
      runbooksToggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().viewMode).toBe("runbooks");
    expect(runbooksToggle?.getAttribute("aria-pressed")).toBe("true");
  });

  it("resizes and persists the desktop left sidebar width", () => {
    ({ container, root } = renderShell());

    const sidebar = container.querySelector<HTMLElement>('[data-testid="session-panel"]');
    const resizeHandle = sidebar?.querySelector<HTMLElement>(".cursor-col-resize");
    expect(sidebar?.style.width).toBe("264px");
    expect(resizeHandle).not.toBeNull();

    flushSync(() => {
      resizeHandle!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 264 }));
    });
    flushSync(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 344 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 344 }));
    });

    expect(sidebar?.style.width).toBe("344px");
    expect(window.localStorage.getItem(DASHBOARD_LEFT_SIDEBAR_WIDTH_STORAGE_KEY)).toBe("344");
  });

  it("keeps banner in the existing content position by default", () => {
    ({ container, root } = renderShell({
      banner: createElement("div", { "data-testid": "restart-banner" }, "Restarting"),
    }));

    const banner = container.querySelector<HTMLElement>('[data-testid="restart-banner"]');
    const wrapper = banner?.parentElement;
    expect(wrapper?.className).toContain("left-[308px]");
    expect(wrapper?.className).toContain("right-[22px]");
    expect(wrapper?.className).toContain("top-[76px]");
    expect(wrapper?.className).not.toContain("inset-x-0");
    expect(wrapper?.className).not.toContain("top-0");
  });

  it("can render the banner at the viewport top", () => {
    ({ container, root } = renderShell({
      banner: createElement("div", { "data-testid": "restart-banner" }, "Restarting"),
      bannerPlacement: "viewport-top",
    }));

    const banner = container.querySelector<HTMLElement>('[data-testid="restart-banner"]');
    const wrapper = banner?.parentElement;
    expect(wrapper?.className).toContain("fixed");
    expect(wrapper?.className).toContain("inset-x-0");
    expect(wrapper?.className).toContain("top-0");
    expect(wrapper?.className).toContain("z-50");
    expect(wrapper?.className).not.toContain("left-[308px]");
    expect(wrapper?.className).not.toContain("top-[76px]");
  });
});

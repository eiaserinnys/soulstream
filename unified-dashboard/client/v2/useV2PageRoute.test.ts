import { describe, expect, it, vi } from "vitest";

import {
  createV2PageRouteController,
  formatV2PagePath,
  parseV2PageRoute,
} from "./useV2PageRoute";

function createTarget(pathname: string) {
  const popstateListeners = new Set<() => void>();
  const target = {
    location: { pathname },
    history: {
      pushState: vi.fn((_state: unknown, _unused: string, nextPath: string) => {
        target.location.pathname = nextPath;
      }),
      replaceState: vi.fn((_state: unknown, _unused: string, nextPath: string) => {
        target.location.pathname = nextPath;
      }),
    },
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "popstate") popstateListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "popstate") popstateListeners.delete(listener);
    }),
    restore(nextPath: string) {
      target.location.pathname = nextPath;
      for (const listener of popstateListeners) listener();
    },
  };
  return target;
}

describe("v2 page route", () => {
  it("treats /v2 as the lazy daily entry", () => {
    expect(parseV2PageRoute("/v2")).toEqual({ kind: "daily" });
    expect(parseV2PageRoute("/v2/")).toEqual({ kind: "daily" });
  });

  it("restores an encoded /v2/pages/:pageId deep link", () => {
    expect(parseV2PageRoute("/v2/pages/page%3A2026-07-12")).toEqual({
      kind: "page",
      pageId: "page:2026-07-12",
    });
    expect(formatV2PagePath("page:2026-07-12")).toBe("/v2/pages/page%3A2026-07-12");
  });

  it("rejects missing, extra, and malformed page routes explicitly", () => {
    expect(parseV2PageRoute("/v2/pages").kind).toBe("invalid");
    expect(parseV2PageRoute("/v2/pages/a/extra").kind).toBe("invalid");
    expect(parseV2PageRoute("/v2/pages/%E0%A4%A").kind).toBe("invalid");
  });

  it("publishes push navigation and browser back/forward restoration", () => {
    const target = createTarget("/v2");
    const controller = createV2PageRouteController(target);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.navigateToPage("page-one");
    expect(target.history.pushState).toHaveBeenCalledWith(null, "", "/v2/pages/page-one");
    expect(controller.getSnapshot()).toEqual({ kind: "page", pageId: "page-one" });

    target.restore("/v2/pages/page-two");
    expect(controller.getSnapshot()).toEqual({ kind: "page", pageId: "page-two" });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    controller.destroy();
    expect(target.removeEventListener).toHaveBeenCalledWith("popstate", expect.any(Function));
  });

  it("replaces the daily placeholder after lazy get-or-create", () => {
    const target = createTarget("/v2");
    const controller = createV2PageRouteController(target);
    controller.navigateToPage("daily-page", { replace: true });
    expect(target.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/v2/pages/daily-page",
    );
  });
});

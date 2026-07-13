import { describe, expect, it, vi } from "vitest";

import {
  createV2PageRouteController,
  formatV2BlockReferencePath,
  formatV2LegacyFolderPath,
  formatV2PagePath,
  parseV2Lens,
  parseV2PageRoute,
} from "./useV2PageRoute";

function createTarget(initialUrl: string) {
  const popstateListeners = new Set<() => void>();
  const [pathname, initialSearch = ""] = initialUrl.split("?");
  const target = {
    location: { pathname, search: initialSearch ? `?${initialSearch}` : "" },
    history: {
      pushState: vi.fn((_state: unknown, _unused: string, nextUrl: string) => {
        setUrl(nextUrl);
      }),
      replaceState: vi.fn((_state: unknown, _unused: string, nextUrl: string) => {
        setUrl(nextUrl);
      }),
    },
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "popstate") popstateListeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === "popstate") popstateListeners.delete(listener);
    }),
    restore(nextUrl: string) {
      setUrl(nextUrl);
      for (const listener of popstateListeners) listener();
    },
  };
  function setUrl(nextUrl: string) {
    const [nextPathname, nextSearch = ""] = nextUrl.split("?");
    target.location.pathname = nextPathname;
    target.location.search = nextSearch ? `?${nextSearch}` : "";
  }
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
      blockId: null,
    });
    expect(formatV2PagePath("page:2026-07-12")).toBe("/v2/pages/page%3A2026-07-12");
  });

  it("changes the lens without dropping an additive page/block deep link", () => {
    const target = createTarget("/v2?page=page-one&block=block-two&lens=running");
    const controller = createV2PageRouteController(target);

    controller.setLens("completed");

    expect(target.history.pushState).toHaveBeenCalledWith(
      null,
      "",
      "/v2?page=page-one&block=block-two&lens=completed",
    );
    expect(controller.getSnapshot()).toEqual({
      kind: "page",
      pageId: "page-one",
      blockId: "block-two",
    });
  });

  it("restores the additive page/block reference deep link and keeps the legacy page path", () => {
    expect(parseV2PageRoute("/v2", "?page=page%3Aone&block=block%2Ftwo")).toEqual({
      kind: "page",
      pageId: "page:one",
      blockId: "block/two",
    });
    expect(formatV2BlockReferencePath("page:one", "block/two")).toBe(
      "/v2?page=page%3Aone&block=block%2Ftwo",
    );
    expect(parseV2PageRoute("/v2/pages/page-one")).toEqual({
      kind: "page",
      pageId: "page-one",
      blockId: null,
    });
  });

  it("restores legacy folders and the running/completed lens from history", () => {
    expect(parseV2PageRoute("/v2/legacy-folders/folder%3Aone")).toEqual({
      kind: "legacy-folder",
      folderId: "folder:one",
    });
    expect(formatV2LegacyFolderPath("folder:one")).toBe("/v2/legacy-folders/folder%3Aone");
    expect(parseV2Lens("?lens=running")).toBe("running");
    expect(parseV2Lens("?lens=completed")).toBe("completed");
    expect(parseV2Lens("?lens=unknown")).toBe("default");

    const target = createTarget("/v2/legacy-folders/folder-one?lens=running");
    const controller = createV2PageRouteController(target);
    const unsubscribe = controller.subscribe(() => undefined);
    expect(controller.getSnapshot()).toEqual({ kind: "legacy-folder", folderId: "folder-one" });
    expect(controller.getLensSnapshot()).toBe("running");

    controller.setLens("completed");
    expect(target.history.pushState).toHaveBeenCalledWith(
      null,
      "",
      "/v2/legacy-folders/folder-one?lens=completed",
    );
    target.restore("/v2/legacy-folders/folder-one?lens=running");
    expect(controller.getLensSnapshot()).toBe("running");
    unsubscribe();
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
    expect(controller.getSnapshot()).toEqual({ kind: "page", pageId: "page-one", blockId: null });

    controller.navigateToBlock("page-one", "block-two");
    expect(target.history.pushState).toHaveBeenCalledWith(
      null,
      "",
      "/v2?page=page-one&block=block-two",
    );
    expect(controller.getSnapshot()).toEqual({
      kind: "page",
      pageId: "page-one",
      blockId: "block-two",
    });

    target.restore("/v2/pages/page-two");
    expect(controller.getSnapshot()).toEqual({ kind: "page", pageId: "page-two", blockId: null });
    expect(listener).toHaveBeenCalledTimes(3);

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

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isPageLens, type PageLens } from "@seosoyoung/soul-ui/page";

export type V2PageRoute =
  | { readonly kind: "daily" }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "legacy-folder"; readonly folderId: string }
  | { readonly kind: "invalid"; readonly message: string };

interface V2RouteTarget {
  readonly location: { pathname: string; search?: string };
  readonly history: {
    pushState(state: unknown, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface V2PageRouteController {
  getSnapshot(): V2PageRoute;
  getLensSnapshot(): PageLens;
  subscribe(listener: () => void): () => void;
  navigateToPage(pageId: string, options?: { replace?: boolean }): void;
  navigateToLegacyFolder(folderId: string): void;
  navigateToDaily(): void;
  setLens(lens: PageLens): void;
  destroy(): void;
}

export function parseV2PageRoute(pathname: string): V2PageRoute {
  if (pathname === "/v2" || pathname === "/v2/") return { kind: "daily" };
  const pageMatch = /^\/v2\/pages\/([^/]+)$/.exec(pathname);
  const legacyMatch = /^\/v2\/legacy-folders\/([^/]+)$/.exec(pathname);
  const match = pageMatch ?? legacyMatch;
  if (!match) {
    return {
      kind: "invalid",
      message: `Unsupported v2 page route: ${pathname}`,
    };
  }
  try {
    const id = decodeURIComponent(match[1]!);
    if (!id || id.trim() !== id) throw new Error("invalid route id");
    return pageMatch
      ? { kind: "page", pageId: id }
      : { kind: "legacy-folder", folderId: id };
  } catch {
    return {
      kind: "invalid",
      message: `Invalid encoded page id in route: ${pathname}`,
    };
  }
}

export function parseV2Lens(search: string): PageLens {
  const value = new URLSearchParams(search).get("lens");
  return isPageLens(value) ? value : "default";
}

export function formatV2PagePath(pageId: string): string {
  if (!pageId || pageId.trim() !== pageId) {
    throw new Error("pageId must be a non-empty trimmed string");
  }
  return `/v2/pages/${encodeURIComponent(pageId)}`;
}

export function formatV2LegacyFolderPath(folderId: string): string {
  if (!folderId || folderId.trim() !== folderId) {
    throw new Error("folderId must be a non-empty trimmed string");
  }
  return `/v2/legacy-folders/${encodeURIComponent(folderId)}`;
}

export function createV2PageRouteController(
  target: V2RouteTarget = window,
): V2PageRouteController {
  const listeners = new Set<() => void>();
  let snapshot = parseV2PageRoute(target.location.pathname);
  let lensSnapshot = parseV2Lens(target.location.search ?? "");
  let destroyed = false;
  let listening = false;
  const publishLocation = () => {
    if (destroyed) return;
    snapshot = parseV2PageRoute(target.location.pathname);
    lensSnapshot = parseV2Lens(target.location.search ?? "");
    for (const listener of listeners) listener();
  };
  const startListening = () => {
    if (listening) return;
    listening = true;
    target.addEventListener("popstate", publishLocation);
  };
  const stopListening = () => {
    if (!listening) return;
    listening = false;
    target.removeEventListener("popstate", publishLocation);
  };

  return {
    getSnapshot: () => snapshot,
    getLensSnapshot: () => lensSnapshot,
    subscribe(listener) {
      if (destroyed) throw new Error("v2 page route controller is destroyed");
      listeners.add(listener);
      startListening();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopListening();
      };
    },
    navigateToPage(pageId, options = {}) {
      if (destroyed) throw new Error("v2 page route controller is destroyed");
      const path = withLens(formatV2PagePath(pageId), lensSnapshot);
      if (options.replace) target.history.replaceState(null, "", path);
      else target.history.pushState(null, "", path);
      publishLocation();
    },
    navigateToLegacyFolder(folderId) {
      if (destroyed) throw new Error("v2 page route controller is destroyed");
      target.history.pushState(null, "", withLens(formatV2LegacyFolderPath(folderId), lensSnapshot));
      publishLocation();
    },
    navigateToDaily() {
      if (destroyed) throw new Error("v2 page route controller is destroyed");
      target.history.pushState(null, "", withLens("/v2", lensSnapshot));
      publishLocation();
    },
    setLens(lens) {
      if (destroyed) throw new Error("v2 page route controller is destroyed");
      target.history.pushState(null, "", withLens(target.location.pathname, lens));
      publishLocation();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      stopListening();
    },
  };
}

export function useV2PageRoute(
  injectedController?: V2PageRouteController,
): readonly [V2PageRoute, V2PageRouteController, PageLens] {
  const controller = useMemo(
    () => injectedController ?? createV2PageRouteController(),
    [injectedController],
  );
  const route = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const lens = useSyncExternalStore(
    controller.subscribe,
    controller.getLensSnapshot,
    controller.getLensSnapshot,
  );
  useEffect(() => () => {
    if (!injectedController) controller.destroy();
  }, [controller, injectedController]);
  return [route, controller, lens] as const;
}

function withLens(pathname: string, lens: PageLens): string {
  return lens === "default" ? pathname : `${pathname}?lens=${lens}`;
}

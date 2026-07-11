import { useEffect, useMemo, useSyncExternalStore } from "react";

export type V2PageRoute =
  | { readonly kind: "daily" }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "invalid"; readonly message: string };

interface V2RouteTarget {
  readonly location: { pathname: string };
  readonly history: {
    pushState(state: unknown, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface V2PageRouteController {
  getSnapshot(): V2PageRoute;
  subscribe(listener: () => void): () => void;
  navigateToPage(pageId: string, options?: { replace?: boolean }): void;
  navigateToDaily(): void;
  destroy(): void;
}

export function parseV2PageRoute(pathname: string): V2PageRoute {
  if (pathname === "/v2" || pathname === "/v2/") return { kind: "daily" };
  const match = /^\/v2\/pages\/([^/]+)$/.exec(pathname);
  if (!match) {
    return {
      kind: "invalid",
      message: `Unsupported v2 page route: ${pathname}`,
    };
  }
  try {
    const pageId = decodeURIComponent(match[1]!);
    if (!pageId || pageId.trim() !== pageId) throw new Error("invalid page id");
    return { kind: "page", pageId };
  } catch {
    return {
      kind: "invalid",
      message: `Invalid encoded page id in route: ${pathname}`,
    };
  }
}

export function formatV2PagePath(pageId: string): string {
  if (!pageId || pageId.trim() !== pageId) {
    throw new Error("pageId must be a non-empty trimmed string");
  }
  return `/v2/pages/${encodeURIComponent(pageId)}`;
}

export function createV2PageRouteController(
  target: V2RouteTarget = window,
): V2PageRouteController {
  const listeners = new Set<() => void>();
  let snapshot = parseV2PageRoute(target.location.pathname);
  let destroyed = false;
  let listening = false;
  const publishLocation = () => {
    if (destroyed) return;
    snapshot = parseV2PageRoute(target.location.pathname);
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
      const path = formatV2PagePath(pageId);
      if (options.replace) target.history.replaceState(null, "", path);
      else target.history.pushState(null, "", path);
      publishLocation();
    },
    navigateToDaily() {
      if (destroyed) throw new Error("v2 page route controller is destroyed");
      target.history.pushState(null, "", "/v2");
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
): readonly [V2PageRoute, V2PageRouteController] {
  const controller = useMemo(
    () => injectedController ?? createV2PageRouteController(),
    [injectedController],
  );
  const route = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => () => {
    if (!injectedController) controller.destroy();
  }, [controller, injectedController]);
  return [route, controller] as const;
}

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  PageApiError,
  createPageYjsClient,
  type PageApiClient,
  type PageDocumentProjection,
  type PageDocumentSnapshot,
  type PageDto,
  type PageYjsClient,
  type PageYjsClientSnapshot,
  type PageLens,
} from "@seosoyoung/soul-ui/page";

import type { V2PageSurfaceState } from "./V2PageSurface";
import {
  useV2PageRoute,
  type V2PageRouteController,
} from "./useV2PageRoute";

const WAITING_CLIENT: PageYjsClientSnapshot = Object.freeze({
  status: "connecting",
  ready: false,
  connected: false,
  synced: false,
  error: null,
});
const EMPTY_DOCUMENT: PageDocumentSnapshot = Object.freeze({
  page: Object.freeze({
    id: "",
    title: "Waiting for page",
    dailyDate: null,
    mutationVersion: 1,
    archived: false,
    metadata: Object.freeze({}),
  }),
  blocks: Object.freeze([]),
});
const noopSubscribe = () => () => undefined;
const DEFAULT_CREATE_PAGE_CLIENT = (pageId: string) => createPageYjsClient({ pageId });

type PageRequestState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly page: PageDto }
  | { readonly status: "authentication" | "error"; readonly message: string };

export interface V2PageWorkspace {
  readonly selectedPageId: string | null;
  readonly selectedLegacyFolderId: string | null;
  readonly lens: PageLens;
  readonly pageState: V2PageSurfaceState;
  readonly starredPages: readonly PageDto[];
  readonly starredLoading: boolean;
  readonly starredError: string | null;
  openDaily(): void;
  openPage(pageId: string): void;
  openLegacyFolder(folderId: string): void;
  setLens(lens: PageLens): void;
  toggleCurrentPageStar(): Promise<void>;
  unstarPage(page: PageDto): Promise<void>;
}

export function useV2PageWorkspace({
  apiClient,
  routeController,
  createPageClient = DEFAULT_CREATE_PAGE_CLIENT,
}: {
  apiClient: PageApiClient;
  routeController?: V2PageRouteController;
  createPageClient?: (pageId: string) => PageYjsClient;
}): V2PageWorkspace {
  const [route, controller, lens] = useV2PageRoute(routeController);
  const [pageRequest, setPageRequest] = useState<PageRequestState>({ status: "idle" });
  const [starredPages, setStarredPages] = useState<readonly PageDto[]>([]);
  const [starredLoading, setStarredLoading] = useState(true);
  const [starredError, setStarredError] = useState<string | null>(null);
  const [starringPageIds, setStarringPageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pageActionError, setPageActionError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<PageYjsClient | null>(null);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [runtimeConnectError, setRuntimeConnectError] = useState<string | null>(null);
  const initialStarredRequested = useRef(false);
  const dailyRequest = useRef<ReturnType<PageApiClient["getDailyPage"]> | null>(null);
  const pageReadRequest = useRef<{
    pageId: string;
    promise: ReturnType<PageApiClient["getPage"]>;
  } | null>(null);

  const reloadStarred = useCallback(async () => {
    setStarredLoading(true);
    setStarredError(null);
    try {
      const result = await apiClient.listPages({ starred: true });
      setStarredPages(result.items);
    } catch (error) {
      setStarredError(messageFor(error, "Starred pages could not be loaded."));
    } finally {
      setStarredLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    if (initialStarredRequested.current) return;
    initialStarredRequested.current = true;
    void reloadStarred();
  }, [reloadStarred]);

  useEffect(() => {
    let active = true;
    setPageActionError(null);
    if (route.kind === "invalid") {
      dailyRequest.current = null;
      pageReadRequest.current = null;
      setPageRequest({ status: "error", message: route.message });
      return () => { active = false; };
    }
    if (route.kind === "legacy-folder") {
      dailyRequest.current = null;
      pageReadRequest.current = null;
      setPageRequest({ status: "idle" });
      return () => { active = false; };
    }
    if (route.kind === "daily") {
      pageReadRequest.current = null;
      setPageRequest({ status: "loading" });
      dailyRequest.current ??= apiClient.getDailyPage();
      const request = dailyRequest.current;
      void request.then(
        (result) => {
          if (!active) return;
          controller.navigateToPage(result.page.id, { replace: true });
          void reloadStarred();
        },
        (error: unknown) => {
          if (!active) return;
          if (dailyRequest.current === request) dailyRequest.current = null;
          setPageRequest(requestFailure(error, "Today's page could not be opened."));
        },
      );
      return () => { active = false; };
    }

    dailyRequest.current = null;
    setPageRequest({ status: "loading" });
    if (pageReadRequest.current?.pageId !== route.pageId) {
      pageReadRequest.current = {
        pageId: route.pageId,
        promise: apiClient.getPage(route.pageId),
      };
    }
    const request = pageReadRequest.current;
    void request.promise.then(
      (result) => {
        if (active) setPageRequest({ status: "ready", page: result.page });
      },
      (error: unknown) => {
        if (!active) return;
        if (pageReadRequest.current === request) pageReadRequest.current = null;
        setPageRequest(requestFailure(error, "Page unavailable."));
      },
    );
    return () => { active = false; };
  }, [apiClient, controller, reloadStarred, route]);

  useEffect(() => {
    if (route.kind !== "page") {
      setRuntime(null);
      setRuntimeConnectError(null);
      return;
    }
    let active = true;
    const client = createPageClient(route.pageId);
    setRuntime(client);
    setRuntimeConnectError(null);
    void client.connect().catch((error: unknown) => {
      if (active) setRuntimeConnectError(messageFor(error, "Page sync failed to connect."));
    });
    return () => {
      active = false;
      client.destroy();
    };
  }, [createPageClient, route, runtimeGeneration]);

  const resyncPage = useCallback(() => {
    setRuntimeGeneration((generation) => generation + 1);
  }, []);

  const runtimeSnapshot = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? (() => WAITING_CLIENT),
    runtime?.getSnapshot ?? (() => WAITING_CLIENT),
  );
  const projectionResult = useMemo<
    { projection: PageDocumentProjection | null; error: string | null }
  >(() => {
    if (!runtime || !runtimeSnapshot.ready) return { projection: null, error: null };
    try {
      return { projection: runtime.getProjection(), error: null };
    } catch (error) {
      return { projection: null, error: messageFor(error, "Page projection could not be read.") };
    }
  }, [runtime, runtimeSnapshot.ready]);
  const projectionSnapshot = useSyncExternalStore(
    projectionResult.projection?.subscribe ?? noopSubscribe,
    projectionResult.projection?.getSnapshot ?? (() => EMPTY_DOCUMENT),
    projectionResult.projection?.getSnapshot ?? (() => EMPTY_DOCUMENT),
  );

  const pageState = useMemo<V2PageSurfaceState>(() => {
    if (pageRequest.status === "authentication") {
      return { status: "authentication", message: pageRequest.message };
    }
    if (pageRequest.status === "error") {
      return { status: "error", message: pageRequest.message };
    }
    if (runtimeConnectError) return { status: "error", message: runtimeConnectError };
    if (runtimeSnapshot.status === "authentication_failed") {
      return {
        status: "authentication",
        message: runtimeSnapshot.error?.message ?? "Sign in again to sync this page.",
      };
    }
    if (runtimeSnapshot.status === "disconnected" || runtimeSnapshot.status === "destroyed") {
      return {
        status: "error",
        message: runtimeSnapshot.error?.message ?? "Page sync is unavailable.",
      };
    }
    if (projectionResult.error) return { status: "error", message: projectionResult.error };
    if (route.kind === "invalid") return { status: "error", message: route.message };
    if (route.kind === "legacy-folder") {
      return { status: "loading", message: "Opening legacy folder…" };
    }
    if (pageRequest.status !== "ready" || !runtime || !runtimeSnapshot.ready || !projectionResult.projection) {
      const message = runtimeSnapshot.status === "reconnecting"
        ? "Reconnecting page…"
        : route.kind === "daily"
          ? "Loading today's page…"
          : "Loading page…";
      return { status: "loading", message };
    }
    const projected = projectionSnapshot.page;
    const projectionCaughtUp = projected.mutationVersion >= pageRequest.page.version;
    const page: PageDto = {
      ...pageRequest.page,
      title: projectionCaughtUp ? projected.title : pageRequest.page.title,
      daily_date: projectionCaughtUp ? projected.dailyDate : pageRequest.page.daily_date,
      version: projectionCaughtUp ? projected.mutationVersion : pageRequest.page.version,
      archived: projectionCaughtUp ? projected.archived : pageRequest.page.archived,
      metadata: projectionCaughtUp
        ? { ...projected.metadata }
        : { ...pageRequest.page.metadata },
    };
    return {
      status: "ready",
      page,
      blocks: projectionSnapshot.blocks,
      editor: {
        doc: runtime.doc,
        apiClient,
        onResync: resyncPage,
      },
      starring: starringPageIds.has(page.id),
      actionError: pageActionError,
    };
  }, [
    pageActionError,
    apiClient,
    pageRequest,
    projectionResult,
    projectionSnapshot,
    route,
    resyncPage,
    runtime,
    runtimeConnectError,
    runtimeSnapshot,
    starringPageIds,
  ]);

  const mutateStar = useCallback(async (page: PageDto, starred: boolean) => {
    setStarringPageIds((current) => new Set(current).add(page.id));
    setPageActionError(null);
    try {
      const result = await apiClient.setStarred(page.id, {
        starred,
        expectedVersion: page.version,
        idempotencyKey: pageStarIdempotencyKey(page.id),
      });
      setPageRequest((current) => current.status === "ready" && current.page.id === page.id
        ? { status: "ready", page: result.page }
        : current);
      await reloadStarred();
    } catch (error) {
      const message = messageFor(error, "Page star could not be changed.");
      setPageActionError(message);
      setStarredError(message);
    } finally {
      setStarringPageIds((current) => {
        const next = new Set(current);
        next.delete(page.id);
        return next;
      });
    }
  }, [apiClient, reloadStarred]);

  return {
    selectedPageId: route.kind === "page" ? route.pageId : null,
    selectedLegacyFolderId: route.kind === "legacy-folder" ? route.folderId : null,
    lens,
    pageState,
    starredPages,
    starredLoading,
    starredError,
    openDaily: controller.navigateToDaily,
    openPage: controller.navigateToPage,
    openLegacyFolder: controller.navigateToLegacyFolder,
    setLens: controller.setLens,
    async toggleCurrentPageStar() {
      if (pageState.status !== "ready") return;
      await mutateStar(pageState.page, pageState.page.metadata.starred !== true);
    },
    async unstarPage(page) {
      await mutateStar(page, false);
    },
  };
}

function requestFailure(error: unknown, fallback: string): PageRequestState {
  const status = error instanceof PageApiError && error.kind === "authentication"
    ? "authentication"
    : "error";
  return { status, message: messageFor(error, fallback) };
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function pageStarIdempotencyKey(pageId: string): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Page star mutation requires crypto.randomUUID");
  }
  return `v2-page-star:${pageId}:${globalThis.crypto.randomUUID()}`;
}

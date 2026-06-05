/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { getChildFolders } from "../board-workspace/board-workspace-helpers";
import { useSessionStreamCacheSync } from "./useSessionStreamCacheSync";
import { useSessionStreamSSE } from "./useSessionStreamSSE";

vi.mock("./useSessionStreamSSE", () => ({
  useSessionStreamSSE: vi.fn(),
}));

function Harness() {
  useSessionStreamCacheSync({
    enabled: true,
    urlBuilder: () => "/api/sessions/stream",
    queryKey: ["sessions", "all", "feed", null],
  });
  return null;
}

describe("useSessionStreamCacheSync catalog_updated", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.mocked(useSessionStreamSSE).mockClear();
    useDashboardStore.getState().reset();
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
  });

  it("applies folder rename, move, and delete snapshots to the store immediately", () => {
    const initialCatalog: CatalogState = {
      folders: [
        { id: "parent", name: "Parent", sortOrder: 0, parentFolderId: null },
        { id: "child", name: "Child", sortOrder: 0, parentFolderId: "parent" },
        { id: "deleted", name: "Deleted", sortOrder: 1, parentFolderId: null },
      ],
      sessions: {},
    };
    const nextCatalog: CatalogState = {
      folders: [
        { id: "parent", name: "Renamed Parent", sortOrder: 0, parentFolderId: null },
        { id: "child", name: "Child", sortOrder: 1, parentFolderId: null },
      ],
      sessions: {},
    };

    useDashboardStore.getState().setCatalog(initialCatalog);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    flushSync(() => {
      root?.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
    });

    const streamOptions = vi.mocked(useSessionStreamSSE).mock.calls[0][0];
    streamOptions.onCatalogUpdated?.({ type: "catalog_updated", catalog: nextCatalog, lastEventId: "7" });

    const catalog = useDashboardStore.getState().catalog;
    expect(catalog?.folders.map((folder) => folder.name)).toEqual(["Renamed Parent", "Child"]);
    expect(getChildFolders(catalog?.folders ?? [], "parent")).toEqual([]);
    expect(getChildFolders(catalog?.folders ?? [], null).map((folder) => folder.id)).toEqual(["parent", "child"]);
  });
});

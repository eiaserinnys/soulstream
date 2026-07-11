/** @vitest-environment jsdom */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { useDashboardStore } from "@seosoyoung/soul-ui";

import {
  boardItemsFailureKind,
  collectLegacyFolderIds,
  useV2LegacyBoardItems,
} from "./useV2LegacyBoardItems";

describe("legacy board item loading", () => {
  it("collects the selected folder subtree in structural source order", () => {
    expect(collectLegacyFolderIds([
      { id: "root", name: "Root", sortOrder: 0 },
      { id: "child-b", name: "B", sortOrder: 2, parentFolderId: "root" },
      { id: "child-a", name: "A", sortOrder: 1, parentFolderId: "root" },
      { id: "grandchild", name: "Grandchild", sortOrder: 0, parentFolderId: "child-a" },
    ], "root")).toEqual(["root", "child-a", "grandchild", "child-b"]);
  });

  it("separates authentication and permission failures", () => {
    expect(boardItemsFailureKind(401)).toBe("authentication");
    expect(boardItemsFailureKind(403)).toBe("forbidden");
    expect(boardItemsFailureKind(503)).toBe("error");
  });

  it("loads each folder in the selected subtree into the existing catalog store", async () => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog({
      folders: [
        { id: "root", name: "Root", sortOrder: 0 },
        { id: "child", name: "Child", sortOrder: 0, parentFolderId: "root" },
      ],
      sessions: {},
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const folderId = new URL(url, "https://example.test").searchParams.get("folder_id")!;
      return Response.json({
        boardItems: [{
          id: `markdown:${folderId}`,
          folderId,
          itemType: "markdown",
          itemId: folderId,
          x: 999,
          y: -999,
        }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    const Probe = () => {
      const state = useV2LegacyBoardItems({
        folderId: "root",
        folders: useDashboardStore.getState().catalog!.folders,
        enabled: true,
      });
      return createElement("output", { "data-status": state.status });
    };
    flushSync(() => root.render(createElement(Probe)));

    for (let index = 0; index < 20; index += 1) {
      if (container.querySelector("[data-status='ready']")) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/board-items?folder_id=root",
      "/api/board-items?folder_id=child",
    ]);
    expect(useDashboardStore.getState().catalog?.boardItems?.map((item) => item.id)).toEqual([
      "markdown:root",
      "markdown:child",
    ]);
    flushSync(() => root.unmount());
    vi.unstubAllGlobals();
  });
});

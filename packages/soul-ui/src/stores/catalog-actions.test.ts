import { describe, expect, it } from "vitest";

import type { CatalogState } from "../shared/types";
import {
  addBoardItemToCatalog,
  setBoardItemsForContainerInCatalog,
  setBoardItemsForFolderInCatalog,
} from "./catalog-actions";

describe("catalog-actions", () => {
  it("upserts existing board items by id without duplicating them", () => {
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      boardItems: [{
        id: "frame:launch",
        folderId: "root",
        itemType: "frame",
        itemId: "frame:launch",
        x: 0,
        y: 0,
        metadata: {
          title: "Launch",
          collapsed: false,
          childItemIds: [],
        },
      }],
    };

    const updated = addBoardItemToCatalog(catalog, {
      id: "frame:launch",
      folderId: "root",
      itemType: "frame",
      itemId: "frame:launch",
      x: 0,
      y: 0,
      metadata: {
        title: "Launch",
        collapsed: true,
        childItemIds: ["session:a"],
      },
    });

    expect(updated.boardItems).toHaveLength(1);
    expect(updated.boardItems?.[0]?.metadata).toMatchObject({
      collapsed: true,
      childItemIds: ["session:a"],
    });
  });

  it("replaces the full folder scope without duplicating task container items", () => {
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      boardItems: [
        {
          id: "session:folder-a",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          itemType: "session",
          itemId: "folder-a",
          x: 0,
          y: 0,
        },
        {
          id: "session:task-a",
          folderId: "root",
          containerKind: "task",
          containerId: "rb-1",
          itemType: "session",
          itemId: "task-a",
          x: 10,
          y: 10,
        },
        {
          id: "session:other",
          folderId: "other",
          containerKind: "folder",
          containerId: "other",
          itemType: "session",
          itemId: "other",
          x: 20,
          y: 20,
        },
      ],
    };

    const updated = setBoardItemsForFolderInCatalog(catalog, "root", [
      {
        id: "session:folder-a",
        folderId: "root",
        containerKind: "folder",
        containerId: "root",
        itemType: "session",
        itemId: "folder-a",
        x: 100,
        y: 100,
      },
      {
        id: "session:task-a",
        folderId: "root",
        containerKind: "task",
        containerId: "rb-1",
        itemType: "session",
        itemId: "task-a",
        x: 120,
        y: 120,
      },
    ]);

    expect(updated.boardItems?.map((item) => item.id)).toEqual([
      "session:other",
      "session:folder-a",
      "session:task-a",
    ]);
    expect(updated.boardItems?.filter((item) => item.id === "session:task-a")).toHaveLength(1);
    expect(updated.boardItems?.find((item) => item.id === "session:task-a")).toMatchObject({
      containerKind: "task",
      containerId: "rb-1",
      x: 120,
      y: 120,
    });
  });

  it("treats folder container fetches as folder-scoped board item snapshots", () => {
    const catalog: CatalogState = {
      folders: [],
      sessions: {},
      boardItems: [
        {
          id: "session:task-a",
          folderId: "root",
          containerKind: "task",
          containerId: "rb-1",
          itemType: "session",
          itemId: "task-a",
          x: 10,
          y: 10,
        },
      ],
    };

    const updated = setBoardItemsForContainerInCatalog(
      catalog,
      { kind: "folder", id: "root" },
      [{
        id: "session:task-a",
        folderId: "root",
        containerKind: "task",
        containerId: "rb-1",
        itemType: "session",
        itemId: "task-a",
        x: 120,
        y: 120,
      }],
    );

    expect(updated.boardItems).toHaveLength(1);
    expect(updated.boardItems?.[0]).toMatchObject({ id: "session:task-a", x: 120 });
  });
});

import { describe, expect, it } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import {
  buildBoardSessionRelations,
  getDirectChildPortalItems,
  getSameFolderChildBoardItemIdsToRemove,
  getSessionParentRef,
  shouldSuppressSessionInFolder,
} from "./board-session-relations";
import { buildBoardWorkspaceItems } from "./board-workspace-items";

const sessions: SessionSummary[] = [
  {
    agentSessionId: "parent",
    status: "running",
    eventCount: 1,
    prompt: "Parent",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
  {
    agentSessionId: "same-child",
    status: "completed",
    eventCount: 2,
    prompt: "Same folder child",
    callerSessionId: "parent",
    updatedAt: "2026-06-01T01:00:00.000Z",
  },
  {
    agentSessionId: "cross-child",
    status: "completed",
    eventCount: 3,
    prompt: "Cross folder child",
    callerSessionId: "parent",
    updatedAt: "2026-06-01T02:00:00.000Z",
  },
  {
    agentSessionId: "grandchild",
    status: "completed",
    eventCount: 4,
    prompt: "Grandchild",
    callerSessionId: "same-child",
    updatedAt: "2026-06-01T03:00:00.000Z",
  },
  {
    agentSessionId: "orphan-child",
    status: "completed",
    eventCount: 5,
    prompt: "Orphan child",
    callerSessionId: "deleted-parent",
    updatedAt: "2026-06-01T04:00:00.000Z",
  },
];

const catalog: CatalogState = {
  folders: [
    {
      id: "root",
      name: "Root",
      sortOrder: 0,
      parentFolderId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "other",
      name: "Other",
      sortOrder: 1,
      parentFolderId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  sessions: {
    parent: { folderId: "root", displayName: null },
    "same-child": { folderId: "root", displayName: null },
    "cross-child": { folderId: "other", displayName: null },
    grandchild: { folderId: "root", displayName: null },
    "orphan-child": { folderId: "root", displayName: null },
  },
  sessionList: sessions,
  boardItems: [
    {
      id: "session:parent",
      folderId: "root",
      itemType: "session",
      itemId: "parent",
      x: 0,
      y: 0,
    },
    {
      id: "session:same-child",
      folderId: "root",
      itemType: "session",
      itemId: "same-child",
      x: 320,
      y: 0,
    },
    {
      id: "session:orphan-child",
      folderId: "root",
      itemType: "session",
      itemId: "orphan-child",
      x: 640,
      y: 0,
    },
    {
      id: "session:cross-child",
      folderId: "other",
      itemType: "session",
      itemId: "cross-child",
      x: 0,
      y: 0,
    },
  ],
};

describe("board session relations", () => {
  it("counts direct children only and classifies same-folder suppression", () => {
    const relations = buildBoardSessionRelations({ catalog, sessions: [] });

    expect(relations.childrenByParentId.get("parent")?.map((s) => s.agentSessionId)).toEqual([
      "cross-child",
      "same-child",
    ]);
    expect(getDirectChildPortalItems(relations, "parent", "root")).toHaveLength(2);
    expect(shouldSuppressSessionInFolder(relations, "same-child", "root")).toBe(true);
    expect(shouldSuppressSessionInFolder(relations, "cross-child", "other")).toBe(false);
    expect(shouldSuppressSessionInFolder(relations, "orphan-child", "root")).toBe(false);
  });

  it("keeps cross-folder children visible with a live back-ref and disables missing parent refs", () => {
    const relations = buildBoardSessionRelations({ catalog, sessions: [] });

    expect(getSessionParentRef(relations, "cross-child")).toMatchObject({
      parentSessionId: "parent",
      parentFolderId: "root",
      parentFolderName: "Root",
      parentAvailable: true,
    });
    expect(getSessionParentRef(relations, "orphan-child")).toMatchObject({
      parentSessionId: "deleted-parent",
      parentAvailable: false,
    });

    const rootItems = buildBoardWorkspaceItems({ catalog, selectedFolderId: "root", sessions: [] });
    expect(rootItems.map((item) => item.boardItemId)).toEqual([
      "session:parent",
      "session:orphan-child",
    ]);
    expect(rootItems.find((item) => item.id === "parent")).toMatchObject({
      type: "session",
      childStack: { count: 2 },
    });

    const otherItems = buildBoardWorkspaceItems({ catalog, selectedFolderId: "other", sessions: [] });
    expect(otherItems).toHaveLength(1);
    expect(otherItems[0]).toMatchObject({
      type: "session",
      id: "cross-child",
      parentRef: {
        parentSessionId: "parent",
        parentFolderName: "Root",
        parentAvailable: true,
      },
    });
  });

  it("identifies same-folder child Yjs items that must be removed", () => {
    const relations = buildBoardSessionRelations({ catalog, sessions: [] });

    expect(getSameFolderChildBoardItemIdsToRemove(catalog, relations, "root")).toEqual([
      "session:same-child",
    ]);
    expect(getSameFolderChildBoardItemIdsToRemove(catalog, relations, "other")).toEqual([]);
  });
});

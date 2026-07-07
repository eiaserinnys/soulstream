import { describe, expect, it } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { mergeSessionAssignmentsFromSummaries } from "../hooks/session-stream-helpers";
import {
  buildBoardWorkspaceItems,
  computeBoardCanvasSize,
  findFirstOpenBoardPosition,
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
  snapBoardPosition,
} from "./board-workspace-items";
import {
  buildFrameMembershipUpdates,
  buildFrameMoveUpdates,
  getBoardFrameMetadata,
} from "./board-frames";

const catalog: CatalogState = {
  folders: [
    {
      id: "folder-old",
      name: "Old folder",
      sortOrder: 0,
      parentFolderId: "root",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "folder-new",
      name: "New folder",
      sortOrder: 1,
      parentFolderId: "root",
      createdAt: "2026-06-03T00:00:00.000Z",
    },
    {
      id: "nested",
      name: "Nested",
      sortOrder: 0,
      parentFolderId: "folder-new",
      createdAt: "2026-06-04T00:00:00.000Z",
    },
  ],
  sessions: {
    "session-a": { folderId: "root", displayName: null },
    "session-b": { folderId: "root", displayName: "Pinned name" },
    nested: { folderId: "folder-new", displayName: null },
  },
  boardItems: [
    {
      id: "session:session-b",
      folderId: "root",
      itemType: "session",
      itemId: "session-b",
      x: 0,
      y: 0,
    },
    {
      id: "session:session-a",
      folderId: "root",
      itemType: "session",
      itemId: "session-a",
      x: 200,
      y: 40,
    },
    {
      id: "subfolder:folder-new",
      folderId: "root",
      itemType: "subfolder",
      itemId: "folder-new",
      x: 40,
      y: 160,
    },
    {
      id: "markdown:doc-root",
      folderId: "root",
      itemType: "markdown",
      itemId: "doc-root",
      x: 240,
      y: 160,
      metadata: {
        title: "Board note",
        preview: "Short markdown preview",
      },
    },
    {
      id: "subfolder:nested",
      folderId: "folder-new",
      itemType: "subfolder",
      itemId: "nested",
      x: 0,
      y: 0,
    },
    {
      id: "session:nested",
      folderId: "folder-new",
      itemType: "session",
      itemId: "nested",
      x: 160,
      y: 0,
    },
  ],
};

const sessions: SessionSummary[] = [
  {
    agentSessionId: "session-a",
    status: "completed",
    eventCount: 10,
    prompt: "Prompt title",
    updatedAt: "2026-06-02T00:00:00.000Z",
  },
  {
    agentSessionId: "session-b",
    status: "running",
    eventCount: 12,
    prompt: "Fallback prompt",
    updatedAt: "2026-06-01T12:00:00.000Z",
    lastMessage: {
      type: "assistant",
      preview: "Latest assistant message",
      timestamp: "2026-06-04T00:00:00.000Z",
    },
    displayName: "Pinned name",
  },
];

describe("board workspace item helpers", () => {
  it("builds a coordinate-sorted item list from catalog boardItems", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "session:session-b",
      "session:session-a",
      "folder:folder-new",
      "markdown:doc-root",
    ]);
    expect(items.find((item) => item.id === "folder-new")).toMatchObject({
      type: "folder",
      childCount: 2,
    });
    expect(items.find((item) => item.id === "doc-root")).toMatchObject({
      type: "markdown",
      title: "Board note",
      preview: "Short markdown preview",
    });
  });

  it("builds runbook board items as first-class board objects", () => {
    const items = buildBoardWorkspaceItems({
      catalog: {
        ...catalog,
        boardItems: [
          ...(catalog.boardItems ?? []),
          {
            id: "runbook:rb-1",
            folderId: "root",
            itemType: "runbook",
            itemId: "rb-1",
            x: 400,
            y: 200,
            metadata: {
              title: "Launch runbook",
            },
          },
        ],
      },
      selectedFolderId: "root",
      sessions,
    });

    expect(items.find((item) => item.boardItemId === "runbook:rb-1")).toMatchObject({
      type: "runbook",
      id: "rb-1",
      runbookId: "rb-1",
      title: "Launch runbook",
      x: 400,
      y: 200,
    });
  });

  it("builds runbook container items without folder board fallback entries", () => {
    const items = buildBoardWorkspaceItems({
      catalog: {
        ...catalog,
        boardItems: [
          ...(catalog.boardItems ?? []),
          {
            id: "session:runbook-s1",
            folderId: "root",
            containerKind: "runbook",
            containerId: "rb-1",
            itemType: "session",
            itemId: "runbook-s1",
            x: -120,
            y: 0,
          },
          {
            id: "markdown:runbook-note",
            folderId: "root",
            containerKind: "runbook",
            containerId: "rb-1",
            itemType: "markdown",
            itemId: "runbook-note",
            x: 0,
            y: 0,
            metadata: { title: "Runbook note" },
          },
        ],
      },
      selectedFolderId: "root",
      boardContainer: { kind: "runbook", id: "rb-1" },
      sessions: [
        ...sessions,
        {
          agentSessionId: "runbook-s1",
          status: "running",
          eventCount: 1,
          prompt: "Runbook task",
          folderId: "root",
        },
      ],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "session:runbook-s1",
      "markdown:runbook-note",
    ]);
  });

  it("keeps same-runbook primary child sessions inside the visible parent stack", () => {
    const runbookCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        parent: { folderId: "root", displayName: null },
        child1: { folderId: "root", displayName: null },
        child2: { folderId: "root", displayName: null },
      },
      boardItems: [
        {
          id: "session:parent",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "primary",
          itemType: "session",
          itemId: "parent",
          x: 0,
          y: 0,
        },
        {
          id: "session:child1",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "primary",
          itemType: "session",
          itemId: "child1",
          x: 320,
          y: 0,
        },
        {
          id: "session:child2",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "primary",
          itemType: "session",
          itemId: "child2",
          x: 640,
          y: 0,
        },
      ],
      sessionList: [
        {
          agentSessionId: "parent",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          prompt: "Parent",
        },
        {
          agentSessionId: "child1",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "parent",
          prompt: "Child 1",
        },
        {
          agentSessionId: "child2",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "parent",
          prompt: "Child 2",
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: runbookCatalog,
      selectedFolderId: "root",
      boardContainer: { kind: "runbook", id: "rb-1" },
      sessions: [],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual(["session:parent"]);
    expect(items[0]).toMatchObject({
      type: "session",
      childStack: { count: 2, status: "running" },
    });
  });

  it("keeps a runbook child session visible when its parent has no primary item in the runbook", () => {
    const runbookCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        child: { folderId: "root", displayName: null },
      },
      boardItems: [{
        id: "session:child",
        folderId: "root",
        containerKind: "runbook",
        containerId: "rb-1",
        membershipKind: "primary",
        itemType: "session",
        itemId: "child",
        x: 0,
        y: 0,
      }],
      sessionList: [{
        agentSessionId: "child",
        status: "running",
        eventCount: 1,
        folderId: "root",
        callerSessionId: "parent",
        prompt: "Child",
      }],
    };

    const items = buildBoardWorkspaceItems({
      catalog: runbookCatalog,
      selectedFolderId: "root",
      boardContainer: { kind: "runbook", id: "rb-1" },
      sessions: [],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual(["session:child"]);
  });

  it("does not suppress reference session memberships in a runbook container", () => {
    const runbookCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        parent: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      boardItems: [
        {
          id: "session:parent",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "primary",
          itemType: "session",
          itemId: "parent",
          x: 0,
          y: 0,
        },
        {
          id: "session:child:reference",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "reference",
          itemType: "session",
          itemId: "child",
          x: 320,
          y: 0,
        },
      ],
      sessionList: [
        {
          agentSessionId: "parent",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          prompt: "Parent",
        },
        {
          agentSessionId: "child",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "parent",
          prompt: "Child",
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: runbookCatalog,
      selectedFolderId: "root",
      boardContainer: { kind: "runbook", id: "rb-1" },
      sessions: [],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "session:parent",
      "session:child",
    ]);
  });

  it("does not generate folder board fallback entries for sessions owned by another folder container", () => {
    const items = buildBoardWorkspaceItems({
      catalog: {
        folders: [{
          id: "root",
          name: "Root",
          sortOrder: 0,
          parentFolderId: null,
          createdAt: "2026-06-01T00:00:00.000Z",
        }],
        sessions: {
          "root-session": { folderId: "root", displayName: null },
          "nested-board-session": { folderId: "root", displayName: null },
        },
        boardItems: [
          {
            id: "session:root-session",
            folderId: "root",
            containerKind: "folder",
            containerId: "root",
            membershipKind: "primary",
            itemType: "session",
            itemId: "root-session",
            x: 0,
            y: 0,
          },
          {
            id: "session:nested-board-session",
            folderId: "root",
            containerKind: "folder",
            containerId: "child-folder-or-nested-board",
            membershipKind: "primary",
            itemType: "session",
            itemId: "nested-board-session",
            x: 120,
            y: 120,
          },
        ],
      },
      selectedFolderId: "root",
      sessions: [
        {
          agentSessionId: "root-session",
          status: "running",
          eventCount: 1,
          folderId: "root",
          prompt: "Root session",
        },
        {
          agentSessionId: "nested-board-session",
          status: "running",
          eventCount: 1,
          folderId: "root",
          prompt: "Nested board session",
        },
      ],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual(["session:root-session"]);
  });

  it("builds frame items and hides children while collapsed without changing child coordinates", () => {
    const frameCatalog: CatalogState = {
      ...catalog,
      boardItems: [
        ...(catalog.boardItems ?? []),
        {
          id: "frame:launch",
          folderId: "root",
          itemType: "frame",
          itemId: "frame:launch",
          x: -20,
          y: -20,
          metadata: {
            title: "Launch",
            width: 640,
            height: 420,
            childItemIds: ["session:session-b"],
          },
        },
      ],
    };

    const expanded = buildBoardWorkspaceItems({
      catalog: frameCatalog,
      selectedFolderId: "root",
      sessions,
    });

    const frame = expanded.find((item) => item.type === "frame");
    expect(frame).toMatchObject({
      type: "frame",
      id: "frame:launch",
      title: "Launch",
      childCount: 1,
      collapsed: false,
      x: -20,
      y: -20,
      width: 640,
      height: 420,
    });
    expect(expanded.map((item) => item.boardItemId)).toContain("session:session-b");

    const collapsed = buildBoardWorkspaceItems({
      catalog: {
        ...frameCatalog,
        boardItems: frameCatalog.boardItems?.map((item) =>
          item.id === "frame:launch"
            ? { ...item, metadata: { ...(item.metadata ?? {}), collapsed: true } }
            : item
        ),
      },
      selectedFolderId: "root",
      sessions,
    });

    expect(collapsed.map((item) => item.boardItemId)).toContain("frame:launch");
    expect(collapsed.map((item) => item.boardItemId)).not.toContain("session:session-b");
    expect(getBoardFrameMetadata(frameCatalog.boardItems!.at(-1)!).childItemIds).toEqual(["session:session-b"]);
  });

  it("keeps collapsed frame running state when only a stacked same-folder child is running", () => {
    const frameCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        parent: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      sessionList: [
        {
          agentSessionId: "parent",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          prompt: "Parent",
        },
        {
          agentSessionId: "child",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "parent",
          prompt: "Running child",
        },
      ],
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
          id: "frame:launch",
          folderId: "root",
          itemType: "frame",
          itemId: "frame:launch",
          x: -20,
          y: -20,
          metadata: {
            title: "Launch",
            width: 640,
            height: 420,
            collapsed: true,
            childItemIds: ["session:parent"],
          },
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: frameCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.find((item) => item.id === "child")).toBeUndefined();
    expect(items.find((item) => item.type === "frame")).toMatchObject({
      type: "frame",
      id: "frame:launch",
      childCount: 1,
      hasRunningChild: true,
    });
  });

  it("moves frame children with the frame and updates membership without allowing nested frames", () => {
    const frameCatalog: CatalogState = {
      ...catalog,
      boardItems: [
        ...(catalog.boardItems ?? []),
        {
          id: "frame:launch",
          folderId: "root",
          itemType: "frame",
          itemId: "frame:launch",
          x: 0,
          y: 0,
          metadata: {
            title: "Launch",
            width: 640,
            height: 420,
            childItemIds: ["session:session-b"],
          },
        },
        {
          id: "frame:other",
          folderId: "root",
          itemType: "frame",
          itemId: "frame:other",
          x: 700,
          y: 0,
          metadata: {
            title: "Other",
            width: 320,
            height: 240,
          },
        },
      ],
    };
    const items = buildBoardWorkspaceItems({
      catalog: frameCatalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(buildFrameMoveUpdates(items, { boardItemId: "frame:launch", x: 100, y: 80 }))
      .toEqual(expect.arrayContaining([
        { boardItemId: "frame:launch", x: 100, y: 80 },
        { boardItemId: "session:session-b", x: 100, y: 80 },
      ]));

    const movedItems = items.map((item) =>
      item.boardItemId === "session:session-a" ? { ...item, x: 120, y: 120 } : item
    );
    const membership = buildFrameMembershipUpdates(movedItems, ["session:session-a", "frame:other"]);
    expect(membership.find((item) => item.id === "frame:launch")?.metadata?.childItemIds)
      .toEqual(["session:session-b", "session:session-a"]);
    expect(membership.find((item) => item.id === "frame:other")).toBeUndefined();

    const collapsedItems = items.map((item) => {
      if (item.boardItemId === "frame:launch") return { ...item, collapsed: true };
      if (item.boardItemId === "session:session-a") return { ...item, x: 360, y: 220 };
      return item;
    });
    expect(buildFrameMembershipUpdates(collapsedItems, ["session:session-a"])).toEqual([]);
  });

  it("ignores stale session board items whose session assignment moved to another folder", () => {
    const staleCatalog: CatalogState = {
      ...catalog,
      folders: [
        ...catalog.folders,
        {
          id: "other",
          name: "Other",
          sortOrder: 2,
          parentFolderId: null,
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      ],
      sessions: {
        ...catalog.sessions,
        "moved-away": { folderId: "other", displayName: null },
      },
      boardItems: [
        ...(catalog.boardItems ?? []),
        {
          id: "session:moved-away",
          folderId: "root",
          itemType: "session",
          itemId: "moved-away",
          x: 0,
          y: 320,
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: staleCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).not.toContain("session:moved-away");
  });

  it("shows a moved session only on its target board even when the old board item remains", () => {
    const movedCatalog: CatalogState = {
      folders: [
        {
          id: "source",
          name: "Source",
          sortOrder: 0,
          parentFolderId: null,
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "target",
          name: "Target",
          sortOrder: 1,
          parentFolderId: null,
          createdAt: "2026-06-02T00:00:00.000Z",
        },
      ],
      sessions: {
        "moved-session": { folderId: "target", displayName: null },
      },
      boardItems: [
        {
          id: "session:moved-session",
          folderId: "source",
          itemType: "session",
          itemId: "moved-session",
          x: 0,
          y: 0,
        },
      ],
    };

    expect(buildBoardWorkspaceItems({
      catalog: movedCatalog,
      selectedFolderId: "source",
      sessions: [],
    }).map((item) => `${item.type}:${item.id}`)).not.toContain("session:moved-session");

    expect(buildBoardWorkspaceItems({
      catalog: movedCatalog,
      selectedFolderId: "target",
      sessions: [],
    }).map((item) => `${item.type}:${item.id}`)).toEqual(["session:moved-session"]);
  });

  it("does not show uncategorized sessions on a concrete folder board through stale board items", () => {
    const nullAssignmentCatalog: CatalogState = {
      ...catalog,
      sessions: {
        ...catalog.sessions,
        unassigned: { folderId: null, displayName: null },
      },
      boardItems: [
        ...(catalog.boardItems ?? []),
        {
          id: "session:unassigned",
          folderId: "root",
          itemType: "session",
          itemId: "unassigned",
          x: 0,
          y: 320,
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: nullAssignmentCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).not.toContain("session:unassigned");
  });

  it("applies the same folder assignment gate when boardItems are absent", () => {
    const { boardItems: _unused, ...legacyCatalog } = catalog;
    const foreignSession: SessionSummary = {
      agentSessionId: "nested",
      status: "running",
      eventCount: 1,
      sessionType: "claude",
      folderId: "folder-new",
      prompt: "Foreign folder session",
    };

    const items = buildBoardWorkspaceItems({
      catalog: legacyCatalog,
      selectedFolderId: "root",
      sessions: [...sessions, foreignSession],
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "folder:folder-old",
      "folder:folder-new",
      "session:session-a",
      "session:session-b",
    ]);
  });

  it("falls back to deterministic 280x160 placement when boardItems are absent", () => {
    const { boardItems: _unused, ...legacyCatalog } = catalog;
    const items = buildBoardWorkspaceItems({
      catalog: legacyCatalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "folder:folder-old",
      "folder:folder-new",
      "session:session-a",
      "session:session-b",
    ]);
    expect(items.map((item) => [item.x, item.y])).toEqual([
      [0, 0],
      [280, 0],
      [560, 0],
      [840, 0],
    ]);
  });

  it("keeps board session tiles visible before session summaries arrive", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "folder-new",
      sessions: [],
    });

    const sessionItem = items.find((item) => item.type === "session");
    expect(sessionItem).toMatchObject({
      type: "session",
      id: "nested",
      session: {
        agentSessionId: "nested",
        folderId: "folder-new",
        status: "unknown",
        eventCount: 0,
      },
    });
  });

  it("keeps a single assigned session visible when synced Yjs boardItems are empty", () => {
    const singleSessionCatalog: CatalogState = {
      folders: [{
        id: "general-user-folder",
        name: "김서하",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-06T00:00:00.000Z",
      }],
      sessions: {
        "only-session": { folderId: "general-user-folder", displayName: null },
      },
      sessionList: [{
        agentSessionId: "only-session",
        status: "running",
        eventCount: 1,
        sessionType: "claude",
        folderId: "general-user-folder",
        prompt: "Single visible session",
        createdAt: "2026-06-06T01:00:00.000Z",
      }],
      boardItems: [],
    };

    const items = buildBoardWorkspaceItems({
      catalog: singleSessionCatalog,
      selectedFolderId: "general-user-folder",
      sessions: [],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "session",
      id: "only-session",
      boardItemId: "session:only-session",
      x: 0,
      y: 0,
    });
  });

  it("keeps a generated same-folder child in its visible parent stack without moving existing cards", () => {
    const spawnCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        parent: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      sessionList: [
        {
          agentSessionId: "parent",
          status: "running",
          eventCount: 1,
          folderId: "root",
          prompt: "Parent",
          updatedAt: "2026-06-06T00:00:00.000Z",
        },
        {
          agentSessionId: "child",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "parent",
          prompt: "Generated child",
          updatedAt: "2026-06-06T00:01:00.000Z",
        },
      ],
      boardItems: [{
        id: "session:parent",
        folderId: "root",
        itemType: "session",
        itemId: "parent",
        x: 0,
        y: 0,
      }],
    };

    const items = buildBoardWorkspaceItems({
      catalog: spawnCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.find((item) => item.id === "parent")).toMatchObject({ x: 0, y: 0 });
    expect(items.find((item) => item.id === "parent")).toMatchObject({
      type: "session",
      childStack: { count: 1, status: "running" },
    });
    expect(items.find((item) => item.id === "child")).toBeUndefined();
  });

  it("keeps a generated same-folder child in the inbox rail when its parent is also generated there", () => {
    const spawnCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        anchor: { folderId: "root", displayName: null },
        parent: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      sessionList: [
        {
          agentSessionId: "child",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "parent",
          prompt: "Generated child",
        },
        {
          agentSessionId: "parent",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "external-parent",
          prompt: "Generated parent",
        },
        {
          agentSessionId: "anchor",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          prompt: "Existing card",
        },
      ],
      boardItems: [{
        id: "session:anchor",
        folderId: "root",
        itemType: "session",
        itemId: "anchor",
        x: 0,
        y: 0,
      }],
    };

    const items = buildBoardWorkspaceItems({
      catalog: spawnCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.find((item) => item.id === "parent")).toMatchObject({
      type: "session",
      y: 0,
      x: 320,
      generatedPlacementKind: "inbox",
    });
    expect(items.find((item) => item.id === "parent")).toMatchObject({
      type: "session",
      childStack: undefined,
    });
    expect(items.find((item) => item.id === "child")).toMatchObject({
      type: "session",
      y: 180,
      x: 320,
      generatedPlacementKind: "inbox",
    });
  });

  it("spawns generated sessions without a visible parent on the inbox rail", () => {
    const spawnCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        anchor: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      sessionList: [
        {
          agentSessionId: "anchor",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          prompt: "Existing card",
        },
        {
          agentSessionId: "child",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "external-parent",
          prompt: "Generated child",
        },
      ],
      boardItems: [{
        id: "session:anchor",
        folderId: "root",
        itemType: "session",
        itemId: "anchor",
        x: 0,
        y: 0,
      }],
    };

    const items = buildBoardWorkspaceItems({
      catalog: spawnCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.find((item) => item.id === "anchor")).toMatchObject({ x: 0, y: 0 });
    expect(items.find((item) => item.id === "child")).toMatchObject({ x: 320, y: 0 });
  });

  it("keeps generated parentless sessions in the inbox rail without overlapping frames or existing cards", () => {
    const spawnCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        anchor: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      sessionList: [
        {
          agentSessionId: "child",
          status: "running",
          eventCount: 1,
          folderId: "root",
          callerSessionId: "external-parent",
          prompt: "Generated child",
        },
        {
          agentSessionId: "anchor",
          status: "completed",
          eventCount: 1,
          folderId: "root",
          prompt: "Existing card",
        },
      ],
      boardItems: [
        {
          id: "session:anchor",
          folderId: "root",
          itemType: "session",
          itemId: "anchor",
          x: 0,
          y: 0,
        },
        {
          id: "frame:existing",
          folderId: "root",
          itemType: "frame",
          itemId: "frame:existing",
          x: 320,
          y: 0,
          metadata: {
            title: "Existing frame",
            collapsed: true,
            childItemIds: [],
          },
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: spawnCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    expect(items.find((item) => item.id === "child")).toMatchObject({
      type: "session",
      x: 640,
      y: 0,
      generatedPlacementKind: "inbox",
    });
  });

  it("does not create a board card for a dense same-folder child stack", () => {
    const spawnCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        parent: { folderId: "root", displayName: null },
        blocker1: { folderId: "root", displayName: null },
        blocker2: { folderId: "root", displayName: null },
        blocker3: { folderId: "root", displayName: null },
        child: { folderId: "root", displayName: null },
      },
      sessionList: [{
        agentSessionId: "child",
        status: "running",
        eventCount: 1,
        folderId: "root",
        callerSessionId: "parent",
        prompt: "Generated child",
      }],
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
          id: "session:blocker1",
          folderId: "root",
          itemType: "session",
          itemId: "blocker1",
          x: 320,
          y: 0,
        },
        {
          id: "session:blocker2",
          folderId: "root",
          itemType: "session",
          itemId: "blocker2",
          x: 0,
          y: 180,
        },
        {
          id: "session:blocker3",
          folderId: "root",
          itemType: "session",
          itemId: "blocker3",
          x: 320,
          y: 180,
        },
      ],
    };

    const items = buildBoardWorkspaceItems({
      catalog: spawnCatalog,
      selectedFolderId: "root",
      sessions: [],
    });
    const child = items.find((item) => item.id === "child");

    expect(items.find((item) => item.id === "parent")).toMatchObject({
      type: "session",
      childStack: { count: 1, status: "running" },
    });
    expect(child).toBeUndefined();
  });

  it("allocates non-overlapping inbox slots for simultaneous generated sessions", () => {
    const spawnCatalog: CatalogState = {
      folders: [{
        id: "root",
        name: "Root",
        sortOrder: 0,
        parentFolderId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      sessions: {
        anchor: { folderId: "root", displayName: null },
        child1: { folderId: "root", displayName: null },
        child2: { folderId: "root", displayName: null },
        child3: { folderId: "root", displayName: null },
      },
      sessionList: ["child1", "child2", "child3", "anchor"].map((agentSessionId) => ({
        agentSessionId,
        status: "running" as const,
        eventCount: 1,
        folderId: "root",
        prompt: agentSessionId,
        ...(agentSessionId === "anchor" ? {} : { callerSessionId: "external-parent" }),
      })),
      boardItems: [{
        id: "session:anchor",
        folderId: "root",
        itemType: "session",
        itemId: "anchor",
        x: 0,
        y: 0,
      }],
    };

    const generatedItems = buildBoardWorkspaceItems({
      catalog: spawnCatalog,
      selectedFolderId: "root",
      sessions: [],
    }).filter((item) => item.type === "session" && item.id.startsWith("child"));

    expect(generatedItems.map((item) => [item.id, item.x, item.y])).toEqual([
      ["child1", 320, 0],
      ["child2", 320, 180],
      ["child3", 320, 360],
    ]);
    expect(new Set(generatedItems.map((item) => `${item.x}:${item.y}`)).size).toBe(3);
  });

  it("uses /api/sessions summaries for general-user board session agent metadata", () => {
    const generalUserCatalog: CatalogState = {
      ...catalog,
      sessions: {},
      sessionList: undefined,
      boardItems: [
        {
          id: "session:session-live",
          folderId: "root",
          itemType: "session",
          itemId: "session-live",
          x: 0,
          y: 0,
        },
      ],
    };
    const sessionSummary: SessionSummary = {
      agentSessionId: "session-live",
      status: "running",
      eventCount: 7,
      sessionType: "claude",
      folderId: "root",
      prompt: "Live board session",
      agentId: "roselin_codex",
      agentName: "Roselin",
      agentPortraitUrl: "/api/nodes/eias/agents/roselin_codex/portrait",
      backend: "codex",
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const mergedCatalog = mergeSessionAssignmentsFromSummaries(
      generalUserCatalog,
      [sessionSummary],
    );

    const items = buildBoardWorkspaceItems({
      catalog: mergedCatalog,
      selectedFolderId: "root",
      sessions: [],
    });

    const sessionItem = items.find((item) => item.type === "session");
    expect(sessionItem).toMatchObject({
      type: "session",
      id: "session-live",
      session: {
        agentName: "Roselin",
        agentPortraitUrl: "/api/nodes/eias/agents/roselin_codex/portrait",
        backend: "codex",
      },
    });
  });

  it("snaps positions to 20px, allows negative coordinates, and finds the first empty tile slot", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(snapBoardPosition(59, 101)).toEqual({ x: 60, y: 100 });
    expect(snapBoardPosition(-31, -51)).toEqual({ x: -40, y: -60 });
    expect(findFirstOpenBoardPosition(items)).toEqual({ x: 280, y: 0 });
    expect(computeBoardCanvasSize(items)).toEqual({ width: 720, height: 520 });
  });

  it("uses lastMessage.preview for session previews and displayName for titles", () => {
    expect(getSessionBoardTitle(sessions[1])).toBe("Pinned name");
    expect(getSessionBoardPreview(sessions[1])).toBe("Latest assistant message");
    expect(getSessionBoardPreview(sessions[0])).toBe("Prompt title");
  });

  it("formats invalid or missing timestamps as an ellipsis", () => {
    expect(formatBoardWorkspaceTime(undefined)).toBe("...");
    expect(formatBoardWorkspaceTime("not-a-date")).toBe("...");
  });
});

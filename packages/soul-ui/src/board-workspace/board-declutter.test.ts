import { describe, expect, it } from "vitest";

import {
  DECLUTTER_CATALOG_ITEM_TYPES,
  declutterBoardItems,
} from "./board-declutter";
import {
  BOARD_FRAME_DEFAULT_HEIGHT,
  BOARD_FRAME_DEFAULT_WIDTH,
} from "./board-frames";
import {
  BOARD_GRID_SIZE,
  BOARD_ASSET_TILE_HEIGHT,
  BOARD_RUNBOOK_FIXED_CARD_RECT,
  BOARD_RUNBOOK_TILE_HEIGHT,
  BOARD_RUNBOOK_TILE_WIDTH,
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  getBoardItemHeight,
  getBoardItemWidth,
  type BoardWorkspaceItem,
  type FrameBoardWorkspaceItem,
  type SessionBoardWorkspaceItem,
} from "./board-workspace-items";

const TARGET_ASPECT_RATIO = 4 / 3;

describe("declutterBoardItems", () => {
  it("returns no updates for empty and single-item boards", () => {
    expect(declutterBoardItems([])).toEqual([]);
    expect(declutterBoardItems([folder("only", 0)])).toEqual([]);
  });

  it("keeps every catalog board item type in the arrangement contract", () => {
    expect(Object.keys(DECLUTTER_CATALOG_ITEM_TYPES).sort()).toEqual([
      "asset",
      "custom_view",
      "frame",
      "markdown",
      "runbook",
      "session",
      "subfolder",
    ]);
  });

  it("clusters markdown, custom views, sessions, and other cards in that order", () => {
    const items: BoardWorkspaceItem[] = [
      runbook("runbook", "2026-07-13T00:00:00.000Z"),
      session("session-old", "2026-07-11T00:00:00.000Z"),
      markdown("markdown-old", "2026-07-10T00:00:00.000Z"),
      customView("custom-old", "2026-07-09T00:00:00.000Z"),
      session("session-new", "2026-07-13T00:00:00.000Z"),
      markdown("markdown-new", "2026-07-12T00:00:00.000Z"),
      customView("custom-new", "2026-07-11T00:00:00.000Z"),
      folder("folder", 0),
    ];

    const positions = finalPositions(items);
    const clusterOrder = [
      ["markdown-new", "markdown-old"],
      ["custom-new", "custom-old"],
      ["session-new", "session-old"],
      ["runbook", "folder"],
    ].map((ids) => clusterBounds(items, positions, ids));

    expect([...clusterOrder].sort(readingOrder)).toEqual(clusterOrder);
    expect(readingOrderPosition(positions.get("markdown-new")!, positions.get("markdown-old")!)).toBeLessThan(0);
    expect(readingOrderPosition(positions.get("custom-new")!, positions.get("custom-old")!)).toBeLessThan(0);
    expect(readingOrderPosition(positions.get("session-new")!, positions.get("session-old")!)).toBeLessThan(0);
  });

  it("packs mixed card sizes without overlap near a 4:3 bounding box", () => {
    const items: BoardWorkspaceItem[] = [
      ...Array.from({ length: 4 }, (_, index) =>
        markdown(`markdown-${index}`, `2026-07-1${index}T00:00:00.000Z`)),
      ...Array.from({ length: 4 }, (_, index) =>
        customView(`custom-${index}`, `2026-07-1${index}T00:00:00.000Z`)),
      ...Array.from({ length: 4 }, (_, index) =>
        session(`session-${index}`, `2026-07-1${index}T00:00:00.000Z`)),
      runbook("runbook-a", "2026-07-13T00:00:00.000Z"),
      runbook("runbook-b", "2026-07-12T00:00:00.000Z"),
      folder("folder-a", 0),
      folder("folder-b", 1),
    ];

    const positions = finalPositions(items);
    const rects = items.map((item) => itemRect(item, positions.get(item.boardItemId)!));

    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) {
        expect(overlapsWithMargin(rects[left]!, rects[right]!)).toBe(false);
      }
    }

    const bounds = unionBounds(rects);
    const ratio = bounds.width / bounds.height;
    expect(Math.abs(ratio - TARGET_ASPECT_RATIO)).toBeLessThan(0.2);
  });

  it("arranges asset and frame cards with every other catalog item type without overlap", () => {
    const items: BoardWorkspaceItem[] = [
      folder("folder", 0),
      session("session", "2026-07-13T00:00:00.000Z"),
      markdown("markdown", "2026-07-13T00:00:00.000Z"),
      asset("asset", "2026-07-13T00:00:00.000Z"),
      frame("frame", []),
      runbook("runbook", "2026-07-13T00:00:00.000Z"),
      customView("custom-view", "2026-07-13T00:00:00.000Z"),
    ];
    const positions = finalPositions(items);
    const rects = items.map((item) => itemRect(item, positions.get(item.boardItemId)!));

    for (let left = 0; left < rects.length; left += 1) {
      for (let right = left + 1; right < rects.length; right += 1) {
        expect(overlapsWithMargin(rects[left]!, rects[right]!)).toBe(false);
      }
    }
  });

  it("packs cards below the fixed runbook checklist using its rendered size", () => {
    const items: BoardWorkspaceItem[] = [
      markdown("markdown", "2026-07-13T00:00:00.000Z"),
      session("session", "2026-07-12T00:00:00.000Z"),
    ];

    const positions = finalPositions(
      items,
      declutterBoardItems(items, [BOARD_RUNBOOK_FIXED_CARD_RECT]),
    );
    for (const item of items) {
      const rect = itemRect(item, positions.get(item.boardItemId)!);
      expect(overlapsWithMargin(rect, BOARD_RUNBOOK_FIXED_CARD_RECT)).toBe(false);
    }
  });

  it("keeps frame children and generated inbox sessions fixed", () => {
    const child = folder("frame-child", 0);
    child.x = 80;
    child.y = 80;
    const fixedSession = inboxSession("generated", 0, 0);
    const items: BoardWorkspaceItem[] = [
      fixedSession,
      frame("frame", ["frame-child"]),
      child,
      markdown("movable", "2026-07-13T00:00:00.000Z"),
    ];

    const updates = declutterBoardItems(items);
    const positions = finalPositions(items, updates);

    expect(updates.some((update) => update.boardItemId === child.boardItemId)).toBe(false);
    expect(updates.some((update) => update.boardItemId === fixedSession.boardItemId)).toBe(false);
    expect(positions.get(child.boardItemId)).toEqual({ x: 80, y: 80 });
    expect(positions.get(fixedSession.boardItemId)).toEqual({ x: 0, y: 0 });
    expect(
      overlapsWithMargin(
        itemRect(items[3]!, positions.get(items[3]!.boardItemId)!),
        itemRect(fixedSession, positions.get(fixedSession.boardItemId)!),
      ),
    ).toBe(false);
  });
});

function folder(id: string, order: number): BoardWorkspaceItem {
  return {
    type: "folder",
    id,
    boardItemId: id,
    folder: {
      id,
      name: id,
      sortOrder: order,
      parentFolderId: null,
      createdAt: `2026-07-${String(order + 1).padStart(2, "0")}T00:00:00.000Z`,
    },
    childCount: 0,
    x: 0,
    y: 0,
  };
}

function markdown(id: string, updatedAt: string): BoardWorkspaceItem {
  return {
    type: "markdown",
    id,
    boardItemId: id,
    documentId: id,
    title: id,
    preview: "",
    version: 1,
    updatedAt,
    x: 0,
    y: 0,
  };
}

function customView(id: string, updatedAt: string): BoardWorkspaceItem {
  return {
    type: "custom_view",
    id,
    boardItemId: id,
    customViewId: id,
    title: id,
    preview: "",
    revision: 1,
    updatedAt,
    x: 0,
    y: 0,
    width: BOARD_TILE_WIDTH,
    height: BOARD_TILE_HEIGHT,
  };
}

function asset(id: string, updatedAt: string): BoardWorkspaceItem {
  return {
    type: "asset",
    id,
    boardItemId: id,
    assetId: id,
    fileName: `${id}.png`,
    mimeType: "image/png",
    byteSize: 1,
    updatedAt,
    x: 0,
    y: 0,
    width: BOARD_TILE_WIDTH,
    height: BOARD_ASSET_TILE_HEIGHT,
  };
}

function session(id: string, updatedAt: string): BoardWorkspaceItem {
  return {
    type: "session",
    id,
    boardItemId: id,
    session: {
      agentSessionId: id,
      status: "completed",
      eventCount: 1,
      updatedAt,
    },
    x: 0,
    y: 0,
  };
}

function runbook(id: string, updatedAt: string): BoardWorkspaceItem {
  return {
    type: "runbook",
    id,
    boardItemId: id,
    runbookId: id,
    title: id,
    updatedAt,
    x: 0,
    y: 0,
    width: BOARD_RUNBOOK_TILE_WIDTH,
    height: BOARD_RUNBOOK_TILE_HEIGHT,
  };
}

function frame(id: string, childItemIds: string[]): FrameBoardWorkspaceItem {
  return {
    type: "frame",
    id,
    boardItemId: id,
    folderId: "root",
    title: id,
    collapsed: false,
    childItemIds,
    childCount: childItemIds.length,
    hasRunningChild: false,
    x: 0,
    y: 0,
    width: BOARD_FRAME_DEFAULT_WIDTH,
    height: BOARD_FRAME_DEFAULT_HEIGHT,
  };
}

function inboxSession(id: string, x: number, y: number): SessionBoardWorkspaceItem {
  return {
    type: "session",
    id,
    boardItemId: id,
    session: {
      agentSessionId: id,
      status: "running",
      eventCount: 1,
    },
    generatedPlacementKind: "inbox",
    x,
    y,
  };
}

function finalPositions(
  items: readonly BoardWorkspaceItem[],
  updates = declutterBoardItems(items),
): Map<string, { x: number; y: number }> {
  const positions = new Map(
    items.map((item) => [item.boardItemId, { x: item.x, y: item.y }]),
  );
  for (const update of updates) {
    positions.set(update.boardItemId, { x: update.x, y: update.y });
  }
  return positions;
}

function clusterBounds(
  items: readonly BoardWorkspaceItem[],
  positions: ReadonlyMap<string, { x: number; y: number }>,
  ids: readonly string[],
) {
  return unionBounds(ids.map((id) => {
    const item = items.find((candidate) => candidate.boardItemId === id)!;
    return itemRect(item, positions.get(id)!);
  }));
}

function itemRect(item: BoardWorkspaceItem, position: { x: number; y: number }) {
  return {
    ...position,
    width: getBoardItemWidth(item),
    height: getBoardItemHeight(item),
  };
}

function unionBounds(rects: readonly ReturnType<typeof itemRect>[]) {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function readingOrder(
  left: { x: number; y: number },
  right: { x: number; y: number },
) {
  return left.y - right.y || left.x - right.x;
}

function readingOrderPosition(
  left: { x: number; y: number },
  right: { x: number; y: number },
) {
  return readingOrder(left, right);
}

function overlapsWithMargin(
  left: ReturnType<typeof itemRect>,
  right: ReturnType<typeof itemRect>,
  margin = BOARD_GRID_SIZE,
) {
  return left.x < right.x + right.width + margin
    && left.x + left.width + margin > right.x
    && left.y < right.y + right.height + margin
    && left.y + left.height + margin > right.y;
}

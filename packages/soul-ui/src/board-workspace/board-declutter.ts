import type { BoardItemPositionUpdate } from "./board-selection";
import {
  BOARD_GRID_SIZE,
  getBoardItemActivityMs,
  getBoardItemHeight,
  getBoardItemWidth,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

type ArrangeClusterKey = "markdown" | "custom_view" | "session" | "other";

interface ArrangeCell<T> {
  value: T;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ArrangeGrid<T> {
  cells: ArrangeCell<T>[];
  width: number;
  height: number;
}

interface ArrangeCluster {
  layout: ArrangeGrid<BoardWorkspaceItem>;
}

const TARGET_ASPECT_RATIO = 4 / 3;
const CARD_GAP = BOARD_GRID_SIZE;
const CLUSTER_GAP = BOARD_GRID_SIZE * 4;
const CLUSTER_ORDER: readonly ArrangeClusterKey[] = [
  "markdown",
  "custom_view",
  "session",
  "other",
];

function getFrameChildIds(items: readonly BoardWorkspaceItem[]): Set<string> {
  const childIds = new Set<string>();
  for (const item of items) {
    if (item.type !== "frame") continue;
    for (const childId of item.childItemIds) childIds.add(childId);
  }
  return childIds;
}

function isPinnedItem(item: BoardWorkspaceItem): boolean {
  return item.type === "session" && item.generatedPlacementKind === "inbox";
}

function clusterKey(item: BoardWorkspaceItem): ArrangeClusterKey {
  if (item.type === "markdown" || item.type === "custom_view" || item.type === "session") {
    return item.type;
  }
  return "other";
}

function compareRecent(left: BoardWorkspaceItem, right: BoardWorkspaceItem): number {
  return getBoardItemActivityMs(right) - getBoardItemActivityMs(left)
    || left.boardItemId.localeCompare(right.boardItemId);
}

function dimensions(item: BoardWorkspaceItem): { width: number; height: number } {
  return {
    width: getBoardItemWidth(item),
    height: getBoardItemHeight(item),
  };
}

function packGrid<T>(
  values: readonly T[],
  columns: number,
  gap: number,
  sizeOf: (value: T) => { width: number; height: number },
): ArrangeGrid<T> {
  const columnCount = Math.min(Math.max(1, columns), values.length);
  const rowCount = Math.ceil(values.length / columnCount);
  const sizes = values.map(sizeOf);
  const columnWidths = Array.from({ length: columnCount }, () => 0);
  const rowHeights = Array.from({ length: rowCount }, () => 0);

  sizes.forEach((size, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    columnWidths[column] = Math.max(columnWidths[column]!, size.width);
    rowHeights[row] = Math.max(rowHeights[row]!, size.height);
  });

  const columnX = cumulativeOffsets(columnWidths, gap);
  const rowY = cumulativeOffsets(rowHeights, gap);
  return {
    cells: values.map((value, index) => {
      const column = index % columnCount;
      const row = Math.floor(index / columnCount);
      return {
        value,
        x: columnX[column]!,
        y: rowY[row]!,
        width: sizes[index]!.width,
        height: sizes[index]!.height,
      };
    }),
    width: sum(columnWidths) + gap * Math.max(0, columnCount - 1),
    height: sum(rowHeights) + gap * Math.max(0, rowCount - 1),
  };
}

function cumulativeOffsets(values: readonly number[], gap: number): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const value of values) {
    offsets.push(offset);
    offset += value + gap;
  }
  return offsets;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function aspectScore(layout: Pick<ArrangeGrid<unknown>, "width" | "height">): number {
  if (layout.width <= 0 || layout.height <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log((layout.width / layout.height) / TARGET_ASPECT_RATIO));
}

function chooseBestGrid<T>(
  values: readonly T[],
  gap: number,
  sizeOf: (value: T) => { width: number; height: number },
): ArrangeGrid<T> {
  let best = packGrid(values, 1, gap, sizeOf);
  for (let columns = 2; columns <= values.length; columns += 1) {
    const candidate = packGrid(values, columns, gap, sizeOf);
    const score = aspectScore(candidate);
    const bestScore = aspectScore(best);
    if (
      score < bestScore
      || (score === bestScore && candidate.width * candidate.height < best.width * best.height)
    ) {
      best = candidate;
    }
  }
  return best;
}

function buildClusters(items: readonly BoardWorkspaceItem[]): ArrangeCluster[] {
  const byKey = new Map<ArrangeClusterKey, BoardWorkspaceItem[]>(
    CLUSTER_ORDER.map((key) => [key, []]),
  );
  for (const item of items) byKey.get(clusterKey(item))!.push(item);

  return CLUSTER_ORDER.flatMap((key) => {
    const clusterItems = byKey.get(key)!.sort(compareRecent);
    if (clusterItems.length === 0) return [];
    return [{
      layout: chooseBestGrid(clusterItems, CARD_GAP, dimensions),
    }];
  });
}

function arrangeClusters(clusters: readonly ArrangeCluster[]): ArrangeGrid<ArrangeCluster> {
  return chooseBestGrid(clusters, CLUSTER_GAP, (cluster) => ({
    width: cluster.layout.width,
    height: cluster.layout.height,
  }));
}

function pinnedBottom(pinnedItems: readonly BoardWorkspaceItem[]): number | null {
  if (pinnedItems.length === 0) return null;
  return Math.max(...pinnedItems.map((item) => item.y + getBoardItemHeight(item)));
}

export function declutterBoardItems(
  items: readonly BoardWorkspaceItem[],
): BoardItemPositionUpdate[] {
  if (items.length <= 1) return [];

  const frameChildIds = getFrameChildIds(items);
  const rootItems = items.filter((item) => !frameChildIds.has(item.boardItemId));
  const pinnedItems = rootItems.filter(isPinnedItem);
  const movableItems = rootItems.filter((item) => !isPinnedItem(item));
  if (movableItems.length === 0) return [];

  const origin = snapBoardPosition(
    Math.min(...movableItems.map((item) => item.x)),
    Math.min(...movableItems.map((item) => item.y)),
  );
  const fixedBottom = pinnedBottom(pinnedItems);
  if (fixedBottom !== null) {
    origin.y = Math.max(origin.y, snapBoardPosition(0, fixedBottom + CLUSTER_GAP).y);
  }

  const clusterGrid = arrangeClusters(buildClusters(movableItems));
  const updates: BoardItemPositionUpdate[] = [];
  for (const clusterCell of clusterGrid.cells) {
    for (const itemCell of clusterCell.value.layout.cells) {
      const next = snapBoardPosition(
        origin.x + clusterCell.x + itemCell.x,
        origin.y + clusterCell.y + itemCell.y,
      );
      if (next.x === itemCell.value.x && next.y === itemCell.value.y) continue;
      updates.push({
        boardItemId: itemCell.value.boardItemId,
        x: next.x,
        y: next.y,
      });
    }
  }
  return updates;
}

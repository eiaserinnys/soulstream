import type { FastifyInstance } from "fastify";

import { normalizeBoardContainerKind } from "../board-yjs/board_container_kind_compat.js";
import type { BoardItemType, CatalogBoardItemRow } from "../board-yjs/board_yjs_types.js";
import { resolveLocalBoardYjsService, type BoardYjsHostProxyRouteOptions } from "./board_yjs_host_proxy.js";
import type { BoardContainerTarget, BoardItemRecord } from "./board_item_routes.js";

const boardItemTypes = new Set<BoardItemType>([
  "session", "markdown", "subfolder", "asset", "frame", "task", "custom_view",
]);

export async function updateLocalBoardItemPosition(
  app: FastifyInstance,
  hostProxy: BoardYjsHostProxyRouteOptions,
  item: BoardItemRecord,
  boardItemId: string,
  x: number,
  y: number,
): Promise<void> {
  const catalogItem = catalogBoardItem(item);
  await resolveLocalBoardYjsService(app, hostProxy).updateBoardItemPosition(
    {
      containerKind: catalogItem.containerKind ?? "folder",
      containerId: catalogItem.containerId ?? catalogItem.folderId,
    },
    boardItemId,
    x,
    y,
  );
}

export async function moveLocalBoardItem(
  app: FastifyInstance,
  hostProxy: BoardYjsHostProxyRouteOptions,
  item: BoardItemRecord,
  target: BoardContainerTarget,
  targetFolderId: string,
  position: { x: number; y: number } | undefined,
  idempotencyKey: string,
): Promise<CatalogBoardItemRow> {
  return resolveLocalBoardYjsService(app, hostProxy).moveBoardItemToContainer({
    boardItem: catalogBoardItem(item),
    targetScope: {
      folderId: targetFolderId,
      containerKind: target.kind,
      containerId: target.id,
    },
    ...(position ? { position } : {}),
    idempotencyKey,
  });
}

export function findBoardItem(
  boardItems: readonly BoardItemRecord[],
  boardItemId: string,
): BoardItemRecord | undefined {
  return boardItems.find((item) => item.id === boardItemId);
}

function catalogBoardItem(item: BoardItemRecord): CatalogBoardItemRow {
  const folderId = stringOrNull(item.folderId);
  const itemType = boardItemTypeOrNull(item.itemType);
  const itemId = stringOrNull(item.itemId);
  const x = finiteNumber(item.x);
  const y = finiteNumber(item.y);
  if (folderId === null || itemType === null || itemId === null || x === null || y === null) {
    throw new Error("Board item catalog row is incomplete");
  }
  return {
    id: item.id,
    folderId,
    containerKind: normalizeBoardContainerKind(item.containerKind) ?? "folder",
    containerId: stringOrNull(item.containerId) ?? folderId,
    membershipKind: item.membershipKind === "reference" ? "reference" : "primary",
    sourceTaskItemId: stringOrNull(item.sourceTaskItemId),
    itemType,
    itemId,
    x,
    y,
    metadata: objectValue(item.metadata),
  };
}

function boardItemTypeOrNull(value: unknown): BoardItemType | null {
  return typeof value === "string" && boardItemTypes.has(value as BoardItemType)
    ? value as BoardItemType
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

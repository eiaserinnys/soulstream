import type {
  CatalogBoardItemType,
  CatalogFolder,
  CatalogState,
  SessionSummary,
} from "../shared/types";

export interface LegacyFolderRow {
  readonly kind: "folder";
  readonly id: string;
  readonly depth: number;
  readonly title: string;
  readonly folderId: string;
}

export interface LegacySessionRow {
  readonly kind: "session";
  readonly id: string;
  readonly depth: number;
  readonly title: string;
  readonly session: SessionSummary;
}

export interface LegacyBoardItemRow {
  readonly kind: "board-item";
  readonly id: string;
  readonly depth: number;
  readonly title: string;
  readonly folderId: string;
  readonly itemType: CatalogBoardItemType;
  readonly itemId: string;
}

export type LegacyProjectionRow = LegacyFolderRow | LegacySessionRow | LegacyBoardItemRow;

export type LegacyFolderProjection =
  | { readonly status: "missing"; readonly folderId: string }
  | {
    readonly status: "ready";
    readonly folder: CatalogFolder;
    readonly rows: readonly LegacyProjectionRow[];
    readonly readOnly: true;
  };

export function projectLegacyFolder(
  catalog: CatalogState,
  sessions: readonly SessionSummary[],
  folderId: string,
): LegacyFolderProjection {
  const folder = catalog.folders.find((candidate) => candidate.id === folderId);
  if (!folder) return { status: "missing", folderId };

  const inputOrder = new Map(catalog.folders.map((candidate, index) => [candidate.id, index]));
  const rows: LegacyProjectionRow[] = [];
  const visited = new Set<string>();

  const appendContents = (currentFolderId: string, depth: number) => {
    if (visited.has(currentFolderId)) return;
    visited.add(currentFolderId);

    const children = catalog.folders
      .filter((candidate) => candidate.parentFolderId === currentFolderId)
      .sort((left, right) =>
        left.sortOrder - right.sortOrder
        || (inputOrder.get(left.id) ?? 0) - (inputOrder.get(right.id) ?? 0),
      );
    for (const child of children) {
      rows.push({
        kind: "folder",
        id: child.id,
        folderId: child.id,
        depth,
        title: child.name,
      });
      appendContents(child.id, depth + 1);
    }

    for (const source of sessions) {
      const assignment = catalog.sessions[source.agentSessionId];
      const assignedFolderId = assignment?.folderId ?? source.folderId ?? null;
      if (assignedFolderId !== currentFolderId) continue;
      const session = assignment?.displayName
        ? { ...source, displayName: assignment.displayName }
        : source;
      rows.push({
        kind: "session",
        id: session.agentSessionId,
        depth,
        title: session.displayName ?? session.prompt ?? session.agentSessionId,
        session,
      });
    }

    for (const item of catalog.boardItems ?? []) {
      const containerKind = item.containerKind ?? "folder";
      const containerId = item.containerId ?? item.folderId;
      if (containerKind !== "folder" || containerId !== currentFolderId) continue;
      if (item.itemType === "session" || item.itemType === "subfolder") continue;
      rows.push({
        kind: "board-item",
        id: item.id,
        depth,
        title: boardItemTitle(item.itemType, item.itemId, item.metadata),
        folderId: currentFolderId,
        itemType: item.itemType,
        itemId: item.itemId,
      });
    }
  };

  appendContents(folderId, 0);
  return { status: "ready", folder, rows, readOnly: true };
}

function boardItemTitle(
  itemType: CatalogBoardItemType,
  itemId: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const title = metadata?.title;
  if (typeof title === "string" && title.trim()) return title;
  return `${itemType.replace("_", " ")} · ${itemId}`;
}

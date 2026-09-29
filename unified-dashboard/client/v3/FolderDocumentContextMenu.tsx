import { useMemo, useState } from "react";
import {
  MarkdownDeleteDialog,
  type CatalogBoardItem,
} from "@seosoyoung/soul-ui";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { buildDocumentContextMenuActions } from "./context-menu-model";
import { metadataText } from "./folder-inline-board-model";
import type { FolderMoveTarget } from "./folder-move-targets";
import { FolderMoveDialog } from "./FolderMoveDialog";
import { V3ContextMenu, type V3ContextMenuTarget } from "./V3ContextMenu";

export interface FolderDocumentContextTarget {
  item: CatalogBoardItem;
  target: V3ContextMenuTarget;
}

export function FolderDocumentContextMenu({
  api,
  currentFolderId,
  defaultTargets,
  context,
  onClose,
  onOpen,
  onMove,
  onDelete,
}: {
  api: PageApiClient;
  currentFolderId: string;
  defaultTargets: readonly FolderMoveTarget[];
  context: FolderDocumentContextTarget | null;
  onClose(): void;
  onOpen(item: CatalogBoardItem): void;
  onMove(item: CatalogBoardItem, target: FolderMoveTarget): Promise<void>;
  onDelete(item: CatalogBoardItem): Promise<void>;
}) {
  const [moveItem, setMoveItem] = useState<CatalogBoardItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<CatalogBoardItem | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const actions = useMemo(() => context ? buildDocumentContextMenuActions({
    open: () => onOpen(context.item),
    copyId: () => navigator.clipboard.writeText(context.item.itemId),
    moveToTask: () => setMoveItem(context.item),
    remove: () => {
      setDeleteError(null);
      setDeleteItem(context.item);
    },
  }) : [], [context, onOpen]);
  const deleteTitle = deleteItem ? metadataText(deleteItem, "title") : "";

  return (
    <>
      <V3ContextMenu target={context?.target ?? null} actions={actions} onClose={onClose} />
      <FolderMoveDialog
        api={api}
        currentFolderId={currentFolderId}
        defaultTargets={defaultTargets}
        open={moveItem !== null}
        onClose={() => setMoveItem(null)}
        onMove={async (target) => {
          if (!moveItem) return;
          await onMove(moveItem, target);
        }}
      />
      <MarkdownDeleteDialog
        open={deleteItem !== null}
        title={deleteTitle}
        pending={deletePending}
        error={deleteError}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteItem(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => {
          if (!deleteItem || deletePending) return;
          setDeletePending(true);
          setDeleteError(null);
          void onDelete(deleteItem)
            .then(() => setDeleteItem(null))
            .catch((error: unknown) => {
              setDeleteError(error instanceof Error ? error.message : "문서를 삭제하지 못했습니다.");
            })
            .finally(() => setDeletePending(false));
        }}
      />
    </>
  );
}

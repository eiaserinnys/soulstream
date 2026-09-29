import type { ReactNode } from "react";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface StarredFolderDragData {
  type: "starred-folder";
  pageIds: string[];
}

export function reorderStarredFolderIds(
  pageIds: readonly string[],
  movedPageId: string,
  overPageId: string,
): string[] | null {
  const fromIndex = pageIds.indexOf(movedPageId);
  const overIndex = pageIds.indexOf(overPageId);
  if (fromIndex < 0 || overIndex < 0 || fromIndex === overIndex) return null;
  return arrayMove([...pageIds], fromIndex, overIndex);
}

export function StarredFolderSortableContext({
  ids,
  children,
}: {
  ids: string[];
  children: ReactNode;
}) {
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

export function useStarredFolderDragSurface({
  id,
  pageIds,
  disabled = false,
}: {
  id: string;
  pageIds: string[];
  disabled?: boolean;
}) {
  const data: StarredFolderDragData = { type: "starred-folder", pageIds };
  const sortable = useSortable({ id, disabled, data });

  return {
    setNodeRef: sortable.setNodeRef,
    setActivatorNodeRef: sortable.setActivatorNodeRef,
    attributes: sortable.attributes,
    listeners: sortable.listeners,
    style: disabled ? undefined : {
      transform: CSS.Transform.toString(sortable.transform),
      transition: sortable.transition,
    },
    isDragging: sortable.isDragging,
    isOver: sortable.isOver,
  };
}

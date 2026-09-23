import type { ReactNode } from "react";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface StarredTaskDragData {
  type: "starred-task";
  pageIds: string[];
}

export function reorderStarredTaskIds(
  pageIds: readonly string[],
  movedPageId: string,
  overPageId: string,
): string[] | null {
  const fromIndex = pageIds.indexOf(movedPageId);
  const overIndex = pageIds.indexOf(overPageId);
  if (fromIndex < 0 || overIndex < 0 || fromIndex === overIndex) return null;
  return arrayMove([...pageIds], fromIndex, overIndex);
}

export function StarredTaskSortableContext({
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

export function useStarredTaskDragSurface({
  id,
  pageIds,
  disabled = false,
}: {
  id: string;
  pageIds: string[];
  disabled?: boolean;
}) {
  const data: StarredTaskDragData = { type: "starred-task", pageIds };
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

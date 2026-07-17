import { useCallback, type ReactNode } from "react";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { FolderDragData, FolderRootDropData } from "./folder-dnd";

export function FolderSortableContext({
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

export function useFolderDragSurface({
  id,
  data,
  disabled = false,
}: {
  id: string;
  data: FolderDragData;
  disabled?: boolean;
}) {
  const sortable = useSortable({ id, disabled, data });
  const droppable = useDroppable({ id, data });
  const setNodeRef = useCallback((element: HTMLElement | null) => {
    sortable.setNodeRef(element);
    droppable.setNodeRef(element);
  }, [droppable.setNodeRef, sortable.setNodeRef]);

  return {
    setNodeRef,
    attributes: sortable.attributes,
    listeners: sortable.listeners,
    style: disabled ? undefined : {
      transform: CSS.Transform.toString(sortable.transform),
      transition: sortable.transition,
    },
    isDragging: sortable.isDragging,
    isOver: droppable.isOver,
  };
}

export function useFolderRootDropSurface(rootSiblingIds: string[]) {
  const data: FolderRootDropData = { type: "folder-root", siblingIds: rootSiblingIds };
  return useDroppable({ id: "folder-root", data });
}

export function useFolderDragActive(): boolean {
  const { active } = useDndContext();
  return active?.data.current?.type === "folder";
}

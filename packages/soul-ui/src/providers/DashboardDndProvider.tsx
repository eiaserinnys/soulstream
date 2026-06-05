/**
 * DashboardDndProvider - @dnd-kit DndContext 래퍼
 *
 * 대시보드의 두 가지 DnD 시나리오를 단일 DndContext에서 처리한다:
 *  1. 세션 드래그 → 폴더 드롭: onMoveSessions 콜백 호출
 *  2. 폴더 드래그 → 폴더 드롭: onReorderFolders 콜백 호출 (custom 정렬 모드)
 *
 * active.data.current.type 으로 시나리오를 구분한다:
 *  - type === "session": 세션 이동 (sessionIds 포함)
 *  - type === "folder":  폴더 재정렬 (currentOrder 포함)
 */

import { useCallback, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";

import type { CatalogFolderReorderItem } from "../shared/types";
import {
  buildFolderReorderItems,
  type FolderDragData,
} from "./folder-dnd";

export interface DashboardDndProviderProps {
  /** 세션을 다른 폴더로 이동하는 콜백 */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => void;
  /** 폴더 부모/순서 변경 콜백 */
  onReorderFolders?: (items: CatalogFolderReorderItem[]) => Promise<void>;
  children: ReactNode;
}

export function DashboardDndProvider({
  onMoveSessions,
  onReorderFolders,
  children,
}: DashboardDndProviderProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const activeData = active.data.current as
        | { type: "session"; sessionIds: string[] }
        | FolderDragData
        | undefined;

      if (!activeData) return;

      if (activeData.type === "session") {
        // 세션 → 폴더 드롭: 세션 이동
        // over.id가 "null-folder"이면 null(미분류), 그 외는 folder ID
        const targetFolderId =
          over.id === "null-folder" ? null : (over.id as string);
        onMoveSessions?.(activeData.sessionIds, targetFolderId);
      } else if (activeData.type === "folder") {
        // 폴더 → 폴더 드롭: 같은 부모면 재정렬, 다른 부모면 target folder의 자식으로 이동
        const activeId = active.id as string;
        const overId = over.id as string;
        const overData = over.data.current as FolderDragData | undefined;
        if (!overData || overData.type !== "folder") return;

        const items = buildFolderReorderItems({
          activeId,
          overId,
          activeParentFolderId: activeData.parentFolderId,
          overParentFolderId: overData.parentFolderId,
          activeSiblingIds: activeData.siblingIds,
          overSiblingIds: overData.siblingIds,
          overChildIds: overData.childIds,
        });
        if (!items) return;
        onReorderFolders?.(items);
      }
    },
    [onMoveSessions, onReorderFolders],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      {children}
    </DndContext>
  );
}

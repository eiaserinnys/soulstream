/**
 * DashboardDndProvider - @dnd-kit DndContext 래퍼
 *
 * 대시보드의 DnD 시나리오를 단일 DndContext에서 처리한다:
 *  1. 세션 드래그 → 폴더 드롭: onMoveSessions 콜백 호출
 *  2. 폴더 드래그 → 폴더 드롭: onReorderFolders 콜백 호출 (custom 정렬 모드)
 *  3. 별표 업무 드래그 → 별표 업무: onReorderStarredTasks 콜백 호출
 *
 * active.data.current.type 으로 시나리오를 구분한다:
 *  - type === "session": 세션 이동 (sessionIds 포함)
 *  - type === "folder": 폴더 재정렬
 *  - type === "starred-task": 중요 작업 재정렬
 */

import { useCallback, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";

import type { CatalogFolderReorderItem } from "../shared/types";
import {
  buildFolderMoveToRootItems,
  buildFolderReorderItems,
  type FolderDragData,
  type FolderRootDropData,
} from "./folder-dnd";
import { reorderStarredTaskIds, type StarredTaskDragData } from "./starred-task-dnd";

export interface DashboardDndProviderProps {
  /** 세션을 다른 폴더로 이동하는 콜백 */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => void;
  /** 폴더 부모/순서 변경 콜백 */
  onReorderFolders?: (items: CatalogFolderReorderItem[]) => Promise<void>;
  /** 중요 작업 별표 순서 변경 콜백 */
  onReorderStarredTasks?: (movedPageId: string, pageIds: string[]) => void;
  /** 화면별 충돌 판정. v1 기본값은 기존 closestCenter를 유지한다. */
  collisionDetection?: CollisionDetection;
  children: ReactNode;
}

export const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  return collisions.length > 0 ? collisions : closestCenter(args);
};

export function DashboardDndProvider({
  onMoveSessions,
  onReorderFolders,
  onReorderStarredTasks,
  collisionDetection = closestCenter,
  children,
}: DashboardDndProviderProps) {
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const sensors = useSensors(pointerSensor);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const activeData = active.data.current as
        | { type: "session"; sessionIds: string[] }
        | FolderDragData
        | StarredTaskDragData
        | undefined;

      if (!activeData) return;

      if (activeData.type === "session") {
        // 세션 → 폴더 드롭: 세션 이동
        // over.id가 "null-folder"이면 null(미분류), 그 외는 folder ID
        const targetFolderId =
          over.id === "null-folder" ? null : (over.id as string);
        onMoveSessions?.(activeData.sessionIds, targetFolderId);
      } else if (activeData.type === "starred-task") {
        const overData = over.data.current as StarredTaskDragData | undefined;
        if (overData?.type !== "starred-task") return;
        const activeId = active.id as string;
        const pageIds = reorderStarredTaskIds(activeData.pageIds, activeId, over.id as string);
        if (pageIds) onReorderStarredTasks?.(activeId, pageIds);
      } else if (activeData.type === "folder") {
        // 폴더 → 폴더 드롭: 같은 부모면 재정렬, 다른 부모면 target folder의 자식으로 이동
        const activeId = active.id as string;
        const overId = over.id as string;
        const overData = over.data.current as FolderDragData | FolderRootDropData | undefined;
        if (!overData) return;

        if (overData.type === "folder-root") {
          const rootItems = buildFolderMoveToRootItems({
            activeId,
            activeParentFolderId: activeData.parentFolderId,
            activeSiblingIds: activeData.siblingIds,
            rootSiblingIds: overData.siblingIds,
          });
          if (rootItems) onReorderFolders?.(rootItems);
          return;
        }

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
    [onMoveSessions, onReorderFolders, onReorderStarredTasks],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragEnd={handleDragEnd}
    >
      {children}
    </DndContext>
  );
}

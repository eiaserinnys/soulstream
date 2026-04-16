/**
 * FolderItem — 폴더 트리의 개별 폴더 행
 *
 * - useSortable(@dnd-kit/sortable): folderSortMode === "custom" + 일반 폴더일 때 폴더 재정렬 활성화
 * - useDroppable(@dnd-kit/core): 세션 드래그 → 폴더 드롭 타겟 등록
 * - 더블클릭 인라인 편집(rename), 컨텍스트 메뉴 트리거는 부모(FolderTree)가 관리한다.
 *
 * 부모(FolderTree)가 모든 콜백과 표시 상태를 props로 주입한다.
 */

import { useCallback, memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";
import { GripVertical } from "lucide-react";

export interface FolderItemProps {
  folder: { id: string; name: string; sortOrder: number; createdAt?: string };
  isSystem: boolean;
  isDraggableFolder: boolean;
  sortedNormalFolderIds: string[];
  isSelected: boolean;
  isEditingThis: boolean;
  editName: string;
  dragOverId: string | null;
  unreadCount: number;
  sessionCount: number;
  isRunning: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  onEditCancel: () => void;
}

export const FolderItem = memo(function FolderItem({
  folder,
  // isSystem은 부모에서 isDraggableFolder 계산용이지만 자식 렌더링 분기에는 쓰이지 않아 받아두기만 함
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isSystem: _isSystem,
  isDraggableFolder,
  sortedNormalFolderIds,
  isSelected,
  isEditingThis,
  editName,
  dragOverId,
  unreadCount,
  sessionCount,
  isRunning,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onEditChange,
  onEditSubmit,
  onEditCancel,
}: FolderItemProps) {
  // 폴더 재정렬용 (custom 모드에서만 active)
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isSortableDragging,
  } = useSortable({
    id: folder.id,
    disabled: !isDraggableFolder,
    data: {
      type: "folder",
      currentOrder: sortedNormalFolderIds,
    },
  });

  // 세션 drop target
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: folder.id,
    data: { type: "folder", folderId: folder.id },
  });

  // 두 ref를 합성
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      setSortableRef(el);
      setDroppableRef(el);
    },
    [setSortableRef, setDroppableRef],
  );

  const style = isDraggableFolder
    ? {
        transform: CSS.Transform.toString(transform),
        transition,
      }
    : undefined;

  return (
    <div
      ref={setRef}
      style={style}
      data-testid={isDraggableFolder ? "draggable-folder" : undefined}
      className={cn(
        "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50 group select-none",
        isSelected && "bg-accent text-accent-foreground",
        (isOver || dragOverId === folder.id) && "ring-2 ring-primary",
        isDraggableFolder && isSortableDragging && "opacity-50",
      )}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {isEditingThis ? (
        <input
          autoFocus
          className="flex-1 bg-transparent border-b border-primary outline-none text-sm"
          value={editName}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onEditSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEditSubmit();
            if (e.key === "Escape") onEditCancel();
          }}
        />
      ) : (
        <div className="flex items-center gap-1.5 min-w-0">
          {isDraggableFolder && (
            <GripVertical
              {...attributes}
              {...listeners}
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-60 cursor-grab"
            />
          )}
          <span className="truncate">{folder.name}</span>
          {isRunning && (
            <Spinner className="h-3 w-3 shrink-0" />
          )}
        </div>
      )}
      {unreadCount > 0 ? (
        <Badge variant="destructive" className="ml-2 text-xs font-bold">
          {unreadCount}
        </Badge>
      ) : (
        <Badge variant="secondary" className="ml-2 text-xs">
          {sessionCount}
        </Badge>
      )}
    </div>
  );
});

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
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import type { FolderDragData } from "../providers/folder-dnd";

export interface FolderItemProps {
  folder: { id: string; name: string; sortOrder: number; parentFolderId?: string | null; createdAt?: string };
  isSystem: boolean;
  isDraggableFolder: boolean;
  siblingFolderIds: string[];
  childFolderIds: string[];
  isSelected: boolean;
  isEditingThis: boolean;
  editName: string;
  dragOverId: string | null;
  unreadCount: number;
  sessionCount: number;
  isRunning: boolean;
  depth?: number;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
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
  siblingFolderIds,
  childFolderIds,
  isSelected,
  isEditingThis,
  editName,
  dragOverId,
  unreadCount,
  sessionCount,
  isRunning,
  depth = 0,
  hasChildren = false,
  isExpanded = false,
  onToggleExpanded,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onEditChange,
  onEditSubmit,
  onEditCancel,
}: FolderItemProps) {
  const folderDragData: FolderDragData = {
    type: "folder",
    parentFolderId: folder.parentFolderId ?? null,
    siblingIds: siblingFolderIds,
    childIds: childFolderIds,
  };

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
    data: folderDragData,
  });

  // 세션 drop target
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: folder.id,
    data: folderDragData,
  });

  // 두 ref를 합성
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      setSortableRef(el);
      setDroppableRef(el);
    },
    [setSortableRef, setDroppableRef],
  );

  const style = {
    ...(isDraggableFolder
      ? {
          transform: CSS.Transform.toString(transform),
          transition,
        }
      : {}),
    paddingLeft: `${12 + depth * 18}px`,
  };

  return (
    <div
      ref={setRef}
      style={style}
      data-testid={isDraggableFolder ? "draggable-folder" : undefined}
      className={cn(
        "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50 group select-none",
        "relative",
        isSelected && "bg-accent text-accent-foreground",
        (isOver || dragOverId === folder.id) && "ring-2 ring-primary",
        isDraggableFolder && isSortableDragging && "opacity-50",
      )}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {depth > 0 && (
        <span
          data-testid="folder-tree-guide-line"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 top-0 border-l border-border/50"
          style={{ left: `${12 + (depth - 1) * 18 + 8}px` }}
        />
      )}
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
          {hasChildren ? (
            <button
              type="button"
              data-testid={`folder-tree-toggle-${folder.id}`}
              aria-label={isExpanded ? `${folder.name} 접기` : `${folder.name} 펼치기`}
              className="-ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
              onClick={(event) => {
                event.stopPropagation();
                onToggleExpanded?.();
              }}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="-ml-1 h-4 w-4 shrink-0" />
          )}
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

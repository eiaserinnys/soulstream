import type { CSSProperties, MouseEvent } from "react";
import {
  DashboardDndProvider,
  FolderSortableContext,
  pointerFirstCollisionDetection,
  useFolderDragActive,
  useFolderDragSurface,
  useFolderRootDropSurface,
  type CatalogFolder,
  type CatalogFolderReorderItem,
  type FolderDragData,
} from "@seosoyoung/soul-ui";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";

import {
  buildProjectFolderTree,
  type ProjectFolderTreeNode,
} from "./project-folders";

export function ProjectNavigationTree({
  folders,
  selectedFolderId,
  isExpanded,
  onToggleExpanded,
  onSelect,
  onContextMenu,
  onReorder,
}: {
  folders: readonly CatalogFolder[];
  selectedFolderId: string | null;
  isExpanded(folderId: string): boolean;
  onToggleExpanded(folderId: string): void;
  onSelect(folder: CatalogFolder): void;
  onContextMenu(event: MouseEvent, folder: CatalogFolder): void;
  onReorder(items: CatalogFolderReorderItem[]): Promise<void>;
}) {
  const roots = buildProjectFolderTree(folders);
  return (
    <DashboardDndProvider
      collisionDetection={pointerFirstCollisionDetection}
      onReorderFolders={onReorder}
    >
      <ProjectTreeBody
        roots={roots}
        selectedFolderId={selectedFolderId}
        isExpanded={isExpanded}
        onToggleExpanded={onToggleExpanded}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
      />
    </DashboardDndProvider>
  );
}

function ProjectTreeBody({
  roots,
  selectedFolderId,
  isExpanded,
  onToggleExpanded,
  onSelect,
  onContextMenu,
}: {
  roots: ProjectFolderTreeNode[];
  selectedFolderId: string | null;
  isExpanded(folderId: string): boolean;
  onToggleExpanded(folderId: string): void;
  onSelect(folder: CatalogFolder): void;
  onContextMenu(event: MouseEvent, folder: CatalogFolder): void;
}) {
  const rootIds = roots.map((node) => node.folder.id);
  const rootDrop = useFolderRootDropSurface(rootIds);
  const folderDragActive = useFolderDragActive();
  return (
    <>
      <div
        ref={rootDrop.setNodeRef}
        className={`v3-project-root-drop${folderDragActive ? " is-visible" : ""}${rootDrop.isOver ? " is-drop-target" : ""}`}
        data-testid="v3-project-root-drop"
      >
        최상위로 이동
      </div>
      <div className="v3-project-tree-root" data-testid="v3-project-tree-root">
        <FolderSortableContext ids={rootIds}>
          {roots.map((node) => (
            <ProjectTreeNode
              key={node.folder.id}
              node={node}
              depth={0}
              siblingIds={rootIds}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onToggleExpanded={onToggleExpanded}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </FolderSortableContext>
      </div>
    </>
  );
}

function ProjectTreeNode({
  node,
  depth,
  siblingIds,
  selectedFolderId,
  isExpanded,
  onToggleExpanded,
  onSelect,
  onContextMenu,
}: {
  node: ProjectFolderTreeNode;
  depth: number;
  siblingIds: string[];
  selectedFolderId: string | null;
  isExpanded(folderId: string): boolean;
  onToggleExpanded(folderId: string): void;
  onSelect(folder: CatalogFolder): void;
  onContextMenu(event: MouseEvent, folder: CatalogFolder): void;
}) {
  const childIds = node.children.map((child) => child.folder.id);
  const expanded = node.children.length > 0 && isExpanded(node.folder.id);
  const dragData: FolderDragData = {
    type: "folder",
    parentFolderId: node.folder.parentFolderId ?? null,
    siblingIds,
    childIds,
  };
  const drag = useFolderDragSurface({ id: node.folder.id, data: dragData });
  const active = selectedFolderId === node.folder.id;
  const style = {
    ...drag.style,
    "--v3-project-depth": depth,
  } as CSSProperties;
  return (
    <div>
      <div
        ref={drag.setNodeRef}
        className={`v3-project-nav-row${active ? " is-active" : ""}${drag.isDragging ? " is-dragging" : ""}${drag.isOver ? " is-drop-target" : ""}`}
        style={style}
        data-testid={`v3-project-row-${node.folder.id}`}
        onContextMenu={(event) => onContextMenu(event, node.folder)}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className="v3-project-tree-toggle"
            aria-label={expanded ? `${node.folder.name} 접기` : `${node.folder.name} 펼치기`}
            aria-expanded={expanded}
            onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.folder.id); }}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        ) : <span className="v3-project-tree-toggle-spacer" />}
        <button
          type="button"
          className="v3-project-drag-handle"
          aria-label={`${node.folder.name} 이동`}
          {...drag.attributes}
          {...drag.listeners}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`v3-project-nav-link${active ? " is-active" : ""}`}
          aria-level={depth + 1}
          onClick={() => onSelect(node.folder)}
        >
          <span>{node.folder.name}</span>
        </button>
      </div>
      {expanded ? (
        <FolderSortableContext ids={childIds}>
          {node.children.map((child) => (
            <ProjectTreeNode
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              siblingIds={childIds}
              selectedFolderId={selectedFolderId}
              isExpanded={isExpanded}
              onToggleExpanded={onToggleExpanded}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
        </FolderSortableContext>
      ) : null}
    </div>
  );
}

import { useTranslation } from "react-i18next";
import "./v3-project-star.css";
import { FolderNameRowContent } from "./FolderNameRowContent";
import type { CSSProperties, MouseEvent } from "react";
import {
  DashboardDndProvider,
  DisclosureActionIcon,
  FolderSortableContext,
  pointerFirstCollisionDetection,
  useFolderDragActive,
  useFolderDragSurface,
  useFolderRootDropSurface,
  type CatalogFolder,
  type CatalogFolderReorderItem,
  type FolderDragData,
} from "@seosoyoung/soul-ui";
import { GripVertical } from "lucide-react";

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
  const { t } = useTranslation();
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
        {t("folders.navigation.moveRoot")}
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
  const { t } = useTranslation();
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
        data-selected={active ? "true" : "false"}
        onContextMenu={(event) => onContextMenu(event, node.folder)}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className="v3-project-tree-toggle"
            aria-label={expanded ? t("folders.common.collapseNamed", { name: node.folder.name }) : t("folders.common.expandNamed", { name: node.folder.name })}
            aria-expanded={expanded}
            onClick={(event) => { event.stopPropagation(); onToggleExpanded(node.folder.id); }}
          >
            <DisclosureActionIcon expanded={expanded} />
          </button>
        ) : <span className="v3-project-tree-toggle-spacer" />}
        <button
          type="button"
          className="v3-project-drag-handle"
          aria-label={t("folders.navigation.moveNamed", { name: node.folder.name })}
          {...drag.attributes}
          {...drag.listeners}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical aria-hidden="true" />
        </button>
        <FolderNameRowContent name={node.folder.name} level={depth + 1} active={active}
          onSelect={() => onSelect(node.folder)}/>
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

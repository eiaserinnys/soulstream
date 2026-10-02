import "./v3-project-star.css";
import { useId, useMemo, useState, type CSSProperties } from "react";
import { DisclosureActionIcon, Input, type CatalogFolder } from "@seosoyoung/soul-ui";
import { FolderNameRowContent } from "./FolderNameRowContent";
import { buildProjectFolderTree, type ProjectFolderTreeNode } from "./project-folders";
import { V3_CARD_GAP_PX } from "./v3-layout-metrics";
import "./folder-picker.css";
import { DetailTabs } from "./DetailTabs";

export interface FolderPickerProps {
  folders: readonly CatalogFolder[];
  starredFolderIds: readonly string[];
  disabledFolderIds: ReadonlySet<string>;
  selectedFolderId: string | null;
  pending: boolean;
  onSelect(folder: CatalogFolder): void;
}

export function FolderPicker({ folders, starredFolderIds, disabledFolderIds, selectedFolderId, pending, onSelect }: FolderPickerProps) {
  const id = useId();
  const [tab, setTab] = useState<"starred" | "all">(() => starredFolderIds.length ? "starred" : "all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const normalized = query.trim().toLocaleLowerCase();
  const roots = useMemo(() => buildProjectFolderTree(folders.filter((folder) => !folder.archived)), [folders]);
  const filteredRoots = useMemo(() => {
    const filter = (node: ProjectFolderTreeNode): ProjectFolderTreeNode | null => {
      const children = node.children.map(filter).filter((child): child is ProjectFolderTreeNode => child !== null);
      return node.folder.name.toLocaleLowerCase().includes(normalized) || children.length
        ? { ...node, children } : null;
    };
    return normalized ? roots.map(filter).filter((node): node is ProjectFolderTreeNode => node !== null) : roots;
  }, [normalized, roots]);
  const starred = starredFolderIds.map((id) => folders.find((folder) => folder.id === id))
    .filter((folder): folder is CatalogFolder => Boolean(folder && !folder.archived && folder.name.toLocaleLowerCase().includes(normalized)));
  const toggle = (folderId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
    return next;
  });
  const renderNode = (node: ProjectFolderTreeNode, depth: number) => {
    const isExpanded = node.children.length > 0 && (Boolean(normalized) || expanded.has(node.folder.id));
    const disabled = pending || disabledFolderIds.has(node.folder.id);
    const selected = selectedFolderId === node.folder.id;
    return <div key={node.folder.id}>
      <div className={`v3-project-nav-row v3-folder-picker-row${selected ? " is-active" : ""}`}
        role="treeitem" aria-level={depth + 1} aria-selected={selected}
        aria-expanded={node.children.length ? isExpanded : undefined} data-folder-id={node.folder.id}
        style={{ "--v3-project-depth": depth } as CSSProperties}>
        {node.children.length ? <button type="button" className="v3-project-tree-toggle"
          aria-label={`${node.folder.name} ${isExpanded ? "접기" : "펼치기"}`} aria-expanded={isExpanded}
          onClick={() => toggle(node.folder.id)}><DisclosureActionIcon expanded={isExpanded} /></button>
          : <span className="v3-project-tree-toggle-spacer" />}
        <span className="v3-folder-picker-drag-spacer" aria-hidden="true" />
        <FolderNameRowContent name={node.folder.name} level={depth + 1} active={selected}
          disabled={disabled} onSelect={() => onSelect(node.folder)}/>
      </div>
      {isExpanded ? <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div> : null}
    </div>;
  };
  return <div className="v3-shell v3-folder-picker" style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px` } as CSSProperties}>
    <DetailTabs<"starred"|"all"> id={id} label="폴더 목록" panelId={`${id}-folders`} tabs={[["starred","별표"],["all","전체"]]} value={tab} disabled={pending} onChange={setTab}/>
    <Input type="search" aria-label="이동할 폴더 검색" placeholder="폴더 검색…" value={query}
      disabled={pending} onChange={(event) => setQuery(event.target.value)} />
    <div id={`${id}-folders`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="v3-navigation-scroll v3-folder-picker-scroll">
      <div className="v3-nav-list" role="tree" aria-label="이동할 폴더">
        {tab === "starred" ? starred.map((folder) => renderNode({ folder, children: [] }, 0)) : filteredRoots.map((node) => renderNode(node, 0))}
      </div>
      {(tab === "starred" ? starred : filteredRoots).length === 0 ? <p>일치하는 폴더가 없습니다.</p> : null}
    </div>
  </div>;
}

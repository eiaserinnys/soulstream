import type { PlannerFolder } from '../api/plannerTypes';

export const PLANNER_FOLDER_CONTEXT_KEY = 'planner-folder';

export interface SessionContextItem {
  key: string;
  label: string;
  content: unknown;
}

export function buildPlannerFolderContextItem(folder: PlannerFolder): SessionContextItem {
  return {
    key: PLANNER_FOLDER_CONTEXT_KEY,
    label: folder.page.title,
    content: { pageId: folder.page.id, folderId: folder.folderId },
  };
}

/** Same `atom_context_sources` item the web new-session dialog sends for chosen atom nodes. */
export function buildAtomContextItem(references: ReadonlyArray<{
  nodeId: string;
  depth: number;
  titlesOnly: boolean;
  mode?: 'full' | 'index' | 'titles';
}>): SessionContextItem | null {
  const nodes = references.flatMap((reference) => {
    const nodeId = reference.nodeId.trim();
    return nodeId ? [{
      node_id: nodeId,
      depth: reference.depth,
      titles_only: reference.titlesOnly,
      ...(reference.mode ? { mode: reference.mode } : {}),
    }] : [];
  });
  return nodes.length > 0
    ? { key: 'atom_context_sources', label: '선택한 atom 노드', content: { nodes } }
    : null;
}

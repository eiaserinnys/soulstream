import type { Folder } from '../api/types';
import type { PlannerBlock } from '../api/plannerTypes';

export type AtomInstance = 'atom' | 'atom-nl';
export type AtomRenderMode = 'full' | 'index' | 'titles';

export interface FolderGuidance {
  blockId: string;
  text: string;
  scope: string;
}

export interface FolderAtomReference {
  blockId: string | null;
  instance: AtomInstance;
  nodeId: string;
  nodeTitle: string;
  depth: number;
  titlesOnly: boolean;
  limit?: number | null;
  mode?: AtomRenderMode;
}

export interface FolderSessionDefault {
  blockId: string;
  scope: string;
  agentId: string | null;
  nodeId: string | null;
  modelPreset: string | null;
}

export interface FolderPageContext {
  guidance: FolderGuidance[];
  atomReferences: FolderAtomReference[];
  sessionDefaults: FolderSessionDefault[];
}

export interface FolderContextSource {
  folderId: string;
  folderName: string;
  pageId: string;
}

export interface FolderContextPage {
  source: FolderContextSource;
  details: FolderPageContext;
}

export type Sourced<T> = T & { source: FolderContextSource };

export interface FolderContextInheritance {
  guidance: Array<Sourced<FolderGuidance>>;
  atomReferences: Array<Sourced<FolderAtomReference>>;
  sessionDefaults: Array<Sourced<FolderSessionDefault>>;
}

export type FolderContextSourceResolution =
  | { status: 'resolved'; sources: FolderContextSource[] }
  | { status: 'unavailable' };

const DEFAULT_ATOM_DEPTH = 3;

export function parseFolderPageContext(blocks: readonly PlannerBlock[]): FolderPageContext {
  return {
    guidance: blocks.flatMap((block) => {
      if (block.blockType !== 'guidance' || block.properties.enabled !== true) return [];
      const text = block.text.trim();
      return text ? [{ blockId: block.id, text, scope: stringProperty(block, 'scope') ?? block.id }] : [];
    }),
    atomReferences: blocks.flatMap((block) => {
      const reference = parseAtomReference(block);
      return reference ? [reference] : [];
    }),
    sessionDefaults: blocks.flatMap((block) => {
      if (block.blockType !== 'session_defaults') return [];
      const scope = stringProperty(block, 'scope');
      const agentId = stringProperty(block, 'agentId');
      const nodeId = stringProperty(block, 'nodeId');
      return scope && (agentId || nodeId)
        ? [{ blockId: block.id, scope, agentId, nodeId, modelPreset: stringProperty(block, 'modelPreset') }]
        : [];
    }),
  };
}

export function parseAtomReference(block: PlannerBlock): FolderAtomReference | null {
  if (block.blockType !== 'atom_ref') return null;
  const instance = stringProperty(block, 'instance') ?? 'atom';
  if (instance !== 'atom' && instance !== 'atom-nl') return null;
  const nodeId = stringProperty(block, 'nodeId');
  if (!nodeId) return null;
  const { depth, limit, mode, titlesOnly } = block.properties;
  return {
    blockId: block.id,
    instance,
    nodeId,
    nodeTitle: stringProperty(block, 'nodeTitle') ?? stringProperty(block, 'title') ?? stringProperty(block, 'label') ?? nodeId,
    depth: typeof depth === 'number' && Number.isInteger(depth) && depth >= 1 && depth <= 5 ? depth : DEFAULT_ATOM_DEPTH,
    titlesOnly: titlesOnly === true,
    ...(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? { limit } : {}),
    ...(mode === 'full' || mode === 'index' || mode === 'titles' ? { mode } : {}),
  };
}

/** Root-to-leaf pages of the folder's parent chain, the folder itself last. */
export function folderContextSources(
  folderId: string,
  folders: readonly Folder[],
): FolderContextSourceResolution {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let current = byId.get(folderId);
  if (!current) return { status: 'unavailable' };
  const path: Folder[] = [];
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    path.push(current);
    seen.add(current.id);
    current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
  }
  return {
    status: 'resolved',
    sources: path.reverse().flatMap((folder) => {
      const pageId = folder.projectPageId?.trim();
      return pageId ? [{ folderId: folder.id, folderName: folder.name, pageId }] : [];
    }),
  };
}

/** Same semantic keys as the server: the nearest page wins per key, values stay root-to-leaf. */
export function mergeFolderContextPages(pages: readonly FolderContextPage[]): FolderContextInheritance {
  const guidance = new Map<string, Ranked<Sourced<FolderGuidance>>>();
  const atoms = new Map<string, Ranked<Sourced<FolderAtomReference>>>();
  const defaults = new Map<string, Ranked<Sourced<FolderSessionDefault>>>();
  pages.forEach(({ source, details }, sourceIndex) => {
    details.guidance.forEach((item, blockIndex) => selectNearest(
      guidance, `guidance:${item.scope}`, { value: { ...item, source }, sourceIndex, blockIndex },
    ));
    details.atomReferences.forEach((item, blockIndex) => selectNearest(
      atoms, `atom_ref:${item.instance}:${item.nodeId}`, { value: { ...item, source }, sourceIndex, blockIndex },
    ));
    details.sessionDefaults.forEach((item, blockIndex) => selectNearest(
      defaults, `session_defaults:${item.scope}`, { value: { ...item, source }, sourceIndex, blockIndex },
    ));
  });
  return {
    guidance: selectedValues(guidance),
    atomReferences: selectedValues(atoms),
    sessionDefaults: selectedValues(defaults),
  };
}

interface Ranked<T> {
  value: T;
  sourceIndex: number;
  blockIndex: number;
}

function selectedValues<T>(items: Map<string, Ranked<T>>): T[] {
  return [...items.values()]
    .sort((left, right) => left.sourceIndex - right.sourceIndex || left.blockIndex - right.blockIndex)
    .map((item) => item.value);
}

function selectNearest<T>(items: Map<string, Ranked<T>>, key: string, candidate: Ranked<T>): void {
  const current = items.get(key);
  if (!current || candidate.sourceIndex > current.sourceIndex) items.set(key, candidate);
}

export function stringProperty(block: PlannerBlock, key: string): string | null {
  const value = block.properties[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

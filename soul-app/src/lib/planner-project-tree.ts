import type { Folder } from '../api/types';

export interface PlannerProjectTreeRow {
  folder: Folder;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  isExpanded: boolean;
}

const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;
const SORTABLE_CHARACTER = /[\p{Letter}\p{Number}]/u;

export function plannerProjectSortKey(name: string): string {
  const index = firstSortableCharacterIndex(name);
  return index === -1 ? '' : name.slice(index).trimEnd();
}

export function splitPlannerContentLabel(name: string): {
  emoji: string | null;
  title: string;
} {
  const trimmed = name.trimStart();
  if (!trimmed) return { emoji: null, title: '' };
  const first = firstGrapheme(trimmed);
  if (!EMOJI_GRAPHEME.test(first)) return { emoji: null, title: trimmed };
  return {
    emoji: first,
    title: trimmed.slice(first.length).trimStart(),
  };
}

export const splitPlannerProjectLabel = splitPlannerContentLabel;

export function buildPlannerProjectTreeRows(
  folders: readonly Folder[],
  expandedFolderIds: ReadonlySet<string> = new Set(),
): PlannerProjectTreeRow[] {
  const visibleFolders = folders.filter((folder) => !folder.archived);
  const byId = new Map(visibleFolders.map((folder) => [folder.id, folder]));
  const originalIndex = new Map(visibleFolders.map((folder, index) => [folder.id, index]));
  const cycleIds = findCycleIds(visibleFolders, byId);
  const children = new Map<string | null, Folder[]>();

  for (const folder of visibleFolders) {
    const rawParentId = folder.parentFolderId ?? null;
    const parentId = rawParentId
      && rawParentId !== folder.id
      && byId.has(rawParentId)
      && !cycleIds.has(folder.id)
      ? rawParentId
      : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(folder);
    children.set(parentId, siblings);
  }

  const compare = (left: Folder, right: Folder) => {
    const byTitle = plannerProjectSortKey(left.name).localeCompare(
      plannerProjectSortKey(right.name),
    );
    return byTitle || (originalIndex.get(left.id)! - originalIndex.get(right.id)!);
  };
  for (const siblings of children.values()) siblings.sort(compare);

  const rows: PlannerProjectTreeRow[] = [];
  const visit = (folder: Folder, depth: number) => {
    const childFolders = children.get(folder.id) ?? [];
    const isExpanded = expandedFolderIds.has(folder.id);
    rows.push({
      folder,
      depth,
      hasChildren: childFolders.length > 0,
      childCount: childFolders.length,
      isExpanded,
    });
    if (isExpanded) {
      for (const child of childFolders) visit(child, depth + 1);
    }
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return rows;
}

function firstGrapheme(value: string): string {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    const iterator = new Segmenter(undefined, { granularity: 'grapheme' })
      .segment(value)[Symbol.iterator]();
    const first = iterator.next();
    if (!first.done) return first.value.segment;
  }
  return Array.from(value)[0] ?? '';
}

function firstSortableCharacterIndex(value: string): number {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
      if (!EMOJI_GRAPHEME.test(part.segment) && SORTABLE_CHARACTER.test(part.segment)) {
        return part.index;
      }
    }
    return -1;
  }

  const characters = Array.from(value);
  let offset = 0;
  for (let index = 0; index < characters.length; index += 1) {
    let consumed = 1;
    let grapheme = characters[index];
    const variation = characters[index + consumed];
    if (variation === '\uFE0E' || variation === '\uFE0F') {
      grapheme += variation;
      consumed += 1;
    }
    if (characters[index + consumed] === '\u20E3') {
      grapheme += characters[index + consumed];
      consumed += 1;
    }
    if (!EMOJI_GRAPHEME.test(grapheme) && SORTABLE_CHARACTER.test(grapheme)) return offset;
    offset += grapheme.length;
    index += consumed - 1;
  }
  return -1;
}

function findCycleIds(
  folders: readonly Folder[],
  byId: ReadonlyMap<string, Folder>,
): Set<string> {
  const cycleIds = new Set<string>();
  for (const folder of folders) {
    const path: string[] = [];
    const indexById = new Map<string, number>();
    let cursor: Folder | undefined = folder;
    while (cursor) {
      const existingIndex = indexById.get(cursor.id);
      if (existingIndex !== undefined) {
        for (const id of path.slice(existingIndex)) cycleIds.add(id);
        break;
      }
      indexById.set(cursor.id, path.length);
      path.push(cursor.id);
      const parentId: string | null = cursor.parentFolderId ?? null;
      cursor = parentId ? byId.get(parentId) : undefined;
    }
  }
  return cycleIds;
}

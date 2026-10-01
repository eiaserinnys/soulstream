import type { PlannerBlock, PlannerFolder } from '../api/plannerTypes';
import { isPlannerDescriptionRoot } from './planner-description-blocks';
import {
  findPlannerFolderProjection,
  replaceFolderProjection,
  type PlannerProjectionState,
} from './planner-mutation-projection';

export interface PlannerDescriptionProjection {
  readonly page: Readonly<Pick<PlannerFolder['page'], 'version' | 'updatedAt'>>;
  readonly blocks: readonly PlannerBlock[];
}

export function capturePlannerDescriptionProjection(
  source: Pick<PlannerFolder, 'page' | 'blocks'>,
): PlannerDescriptionProjection {
  return {
    page: { version: source.page.version, updatedAt: source.page.updatedAt },
    blocks: descriptionOwnedBlocks(source.blocks),
  };
}

export function patchPlannerDescriptionProjection(
  state: PlannerProjectionState,
  folderPageId: string,
  description: PlannerDescriptionProjection,
): PlannerProjectionState {
  const current = findPlannerFolderProjection(state, folderPageId);
  if (!current) return state;
  return replaceFolderProjection(state, {
    ...current,
    page: {
      ...current.page,
      version: description.page.version,
      updatedAt: description.page.updatedAt,
    },
    blocks: replaceDescriptionOwnedBlocks(current.blocks, description.blocks),
  });
}

function descriptionOwnedBlocks(blocks: readonly PlannerBlock[]): PlannerBlock[] {
  const ownedIds = new Set(
    blocks.filter(isPlannerDescriptionRoot).map((block) => block.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      if (block.parentId && ownedIds.has(block.parentId) && !ownedIds.has(block.id)) {
        ownedIds.add(block.id);
        changed = true;
      }
    }
  }
  return blocks.filter((block) => ownedIds.has(block.id));
}

function replaceDescriptionOwnedBlocks(
  current: PlannerBlock[],
  incoming: readonly PlannerBlock[],
): PlannerBlock[] {
  const ownedIds = new Set(descriptionOwnedBlocks(current).map((block) => block.id));
  const firstOwnedIndex = current.findIndex((block) => ownedIds.has(block.id));
  if (firstOwnedIndex < 0) return [...incoming, ...current];
  return [
    ...current.slice(0, firstOwnedIndex).filter((block) => !ownedIds.has(block.id)),
    ...incoming,
    ...current.slice(firstOwnedIndex).filter((block) => !ownedIds.has(block.id)),
  ];
}

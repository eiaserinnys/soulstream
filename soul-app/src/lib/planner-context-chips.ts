import type { PlannerBlock } from '../api/plannerTypes';
import { buildVisibleFolderContextChips } from './planner-context-presentation';

export interface PlannerContextChip {
  id: string;
  icon: string;
  label: string;
}

export function plannerContextCount(blocks: readonly PlannerBlock[]): number {
  return blocks.filter((block) => (
    block.blockType !== 'paragraph' && block.blockType !== 'folder_ref'
  )).length;
}

export function plannerContextChips(
  blocks: readonly PlannerBlock[],
): PlannerContextChip[] {
  return buildVisibleFolderContextChips(blocks);
}

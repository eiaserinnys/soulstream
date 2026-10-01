import type { PlannerBlock } from '../api/plannerTypes';

/**
 * Web parity: unified-dashboard/client/v3/task-workspace-model.ts
 * 설명 편집은 루트 paragraph/checklist만 소유하며 다른 정본 블록은 보존한다.
 */
export function isPlannerDescriptionRoot(block: PlannerBlock): boolean {
  return block.parentId === null
    && (block.blockType === 'paragraph' || block.blockType === 'checklist')
    && !/^\[\[[^\[\]]+\]\]$/.test(block.text.trim());
}

export function plannerDescriptionText(blocks: readonly PlannerBlock[]): string {
  return blocks
    .filter(isPlannerDescriptionRoot)
    .map((block) => block.text)
    .join('\n\n');
}

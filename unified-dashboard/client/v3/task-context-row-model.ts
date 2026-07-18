import type { BlockDto } from "@seosoyoung/soul-ui/page";

export function updateOptimisticTaskAtomReference(
  blocks: readonly BlockDto[],
  blockId: string,
  patch: { depth: number; titlesOnly: boolean },
): BlockDto[] {
  if (!Number.isInteger(patch.depth) || patch.depth < 1 || patch.depth > 5) {
    throw new Error("atom depth는 1~5 정수여야 합니다");
  }
  return blocks.map((block) => block.id === blockId && block.block_type === "atom_ref"
    ? {
        ...block,
        properties: {
          ...block.properties,
          depth: patch.depth,
          titlesOnly: patch.titlesOnly,
        },
      }
    : block);
}

export function deleteOptimisticTaskContextBlock(
  blocks: readonly BlockDto[],
  blockId: string,
): BlockDto[] {
  return blocks.filter((block) => block.id !== blockId);
}

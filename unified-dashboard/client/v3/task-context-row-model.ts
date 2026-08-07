import type { BlockDto } from "@seosoyoung/soul-ui/page";

export function updateOptimisticTaskAtomReference(
  blocks: readonly BlockDto[],
  blockId: string,
  patch: {
    depth: number;
    titlesOnly: boolean;
    limit?: number | null;
    mode?: "full" | "index" | "titles";
  },
): BlockDto[] {
  if (!Number.isInteger(patch.depth) || patch.depth < 1 || patch.depth > 5) {
    throw new Error("atom depth는 1~5 정수여야 합니다");
  }
  if (patch.limit != null && (!Number.isInteger(patch.limit) || patch.limit < 1)) {
    throw new Error("atom 최근 자식 수는 양의 정수여야 합니다");
  }
  return blocks.map((block) => {
    if (block.id !== blockId || block.block_type !== "atom_ref") return block;
    const properties: Record<string, unknown> = {
      ...block.properties,
      depth: patch.depth,
      titlesOnly: patch.titlesOnly,
      ...(patch.limit != null ? { limit: patch.limit } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    };
    if (patch.limit == null) delete properties.limit;
    if (patch.mode === undefined) delete properties.mode;
    return { ...block, properties };
  });
}

export function deleteOptimisticTaskContextBlock(
  blocks: readonly BlockDto[],
  blockId: string,
): BlockDto[] {
  return blocks.filter((block) => block.id !== blockId);
}

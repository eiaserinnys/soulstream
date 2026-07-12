import { clampTextRange, SnapshotIndex, type SiblingGroup } from "./snapshot.js";
import {
  existingBlock,
  focusAt,
  noopPlan,
  type EditorBlockSnapshot,
  type EditorOperationPlan,
  type SemanticEditIntent,
  type TextRange,
} from "./types.js";

interface RequestedMoveFocus {
  readonly blockId: string;
  readonly selection: TextRange;
}

export function planIndent(
  index: SnapshotIndex,
  blockIds: readonly string[],
  requestedFocus?: RequestedMoveFocus,
): EditorOperationPlan {
  const group = index.siblingGroup(blockIds);
  if (!group) return noopPlan("invalid-group");
  const previousSibling = group.siblings[group.startIndex - 1];
  if (!previousSibling) return noopPlan("first-sibling");

  const intents: SemanticEditIntent[] = [];
  let after = index.lastChild(previousSibling.id);
  for (const block of group.blocks) {
    intents.push({
      type: "move-block",
      target: existingBlock(block.id),
      parent: existingBlock(previousSibling.id),
      after: after ? existingBlock(after.id) : null,
    });
    after = block;
  }
  return { intents, focus: moveFocus(index, group, requestedFocus) };
}

export function planOutdent(
  index: SnapshotIndex,
  blockIds: readonly string[],
  requestedFocus?: RequestedMoveFocus,
): EditorOperationPlan {
  const group = index.siblingGroup(blockIds);
  if (!group) return noopPlan("invalid-group");
  const parentId = group.blocks[0]!.parentId;
  if (parentId === null) return noopPlan("root-block");
  const parent = index.require(parentId);

  const intents: SemanticEditIntent[] = [];
  let afterId = parent.id;
  for (const block of group.blocks) {
    intents.push({
      type: "move-block",
      target: existingBlock(block.id),
      parent: parent.parentId === null ? null : existingBlock(parent.parentId),
      after: existingBlock(afterId),
    });
    afterId = block.id;
  }
  return { intents, focus: moveFocus(index, group, requestedFocus) };
}

export function planDeleteSelection(
  index: SnapshotIndex,
  blockIds: readonly string[],
): EditorOperationPlan {
  const group = resolveBlockSelection(index, blockIds);
  if (!group) return noopPlan("invalid-group");
  const next = index.flat.slice(group.lastFlatIndex + 1).find((block) => !group.deletedIds.has(block.id));
  const previous = [...index.flat.slice(0, group.firstFlatIndex)].reverse()
    .find((block) => !group.deletedIds.has(block.id));
  const focus = next
    ? focusAt(existingBlock(next.id), 0)
    : previous
      ? focusAt(existingBlock(previous.id), previous.text.length)
      : null;
  return {
    intents: group.roots.map((block) => ({
      type: "delete-subtree" as const,
      target: existingBlock(block.id),
    })),
    focus,
  };
}

export interface BlockSelectionGroup {
  readonly roots: readonly EditorBlockSnapshot[];
  readonly deletedIds: ReadonlySet<string>;
  readonly firstFlatIndex: number;
  readonly lastFlatIndex: number;
}

export function resolveBlockSelection(
  index: SnapshotIndex,
  blockIds: readonly string[],
): BlockSelectionGroup | null {
  if (blockIds.length === 0 || new Set(blockIds).size !== blockIds.length) return null;
  const selected = new Set(blockIds);
  const selectedBlocks = blockIds.map((blockId) => index.byId.get(blockId));
  if (selectedBlocks.some((block) => block === undefined)) return null;
  const roots = (selectedBlocks as EditorBlockSnapshot[])
    .filter((block) => !hasSelectedAncestor(index, block, selected))
    .sort((left, right) => flatIndex(index, left.id) - flatIndex(index, right.id));
  const deletedIds = new Set<string>();
  for (const root of roots) {
    for (const blockId of index.subtreeIds(root.id)) deletedIds.add(blockId);
  }
  const deletedIndexes = [...deletedIds].map((blockId) => flatIndex(index, blockId));
  const firstFlatIndex = Math.min(...deletedIndexes);
  const lastFlatIndex = Math.max(...deletedIndexes);
  const interval = index.flat.slice(firstFlatIndex, lastFlatIndex + 1);
  if (interval.length !== deletedIds.size || interval.some((block) => !deletedIds.has(block.id))) return null;
  return { roots, deletedIds, firstFlatIndex, lastFlatIndex };
}

export function placementBeforeSelection(index: SnapshotIndex, group: BlockSelectionGroup) {
  const first = group.roots[0]!;
  const siblings = index.siblingsOf(first);
  const position = siblings.findIndex((block) => block.id === first.id);
  const previous = position > 0 ? siblings[position - 1] ?? null : null;
  return {
    parent: first.parentId === null ? null : existingBlock(first.parentId),
    after: previous ? existingBlock(previous.id) : null,
  };
}

function hasSelectedAncestor(
  index: SnapshotIndex,
  block: EditorBlockSnapshot,
  selected: ReadonlySet<string>,
): boolean {
  let parentId = block.parentId;
  while (parentId !== null) {
    if (selected.has(parentId)) return true;
    parentId = index.require(parentId).parentId;
  }
  return false;
}

function flatIndex(index: SnapshotIndex, blockId: string): number {
  return index.flat.findIndex((block) => block.id === blockId);
}

export function parentReference(block: EditorBlockSnapshot) {
  return block.parentId === null ? null : existingBlock(block.parentId);
}

function moveFocus(
  index: SnapshotIndex,
  group: SiblingGroup,
  requested?: RequestedMoveFocus,
) {
  if (!requested || !group.blocks.some((block) => block.id === requested.blockId)) {
    return focusAt(existingBlock(group.blocks[0]!.id), 0);
  }
  const target = index.require(requested.blockId);
  return {
    target: existingBlock(target.id),
    selection: clampTextRange(requested.selection, target.text.length),
  };
}

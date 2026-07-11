import { SnapshotIndex, type SiblingGroup } from "./snapshot.js";
import {
  existingBlock,
  focusAt,
  noopPlan,
  type EditorBlockSnapshot,
  type EditorOperationPlan,
  type SemanticEditIntent,
} from "./types.js";

export function planIndent(index: SnapshotIndex, blockIds: readonly string[]): EditorOperationPlan {
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
  return { intents, focus: focusAt(existingBlock(group.blocks[0]!.id), 0) };
}

export function planOutdent(index: SnapshotIndex, blockIds: readonly string[]): EditorOperationPlan {
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
  return { intents, focus: focusAt(existingBlock(group.blocks[0]!.id), 0) };
}

export function planDeleteSelection(
  index: SnapshotIndex,
  blockIds: readonly string[],
): EditorOperationPlan {
  const group = index.siblingGroup(blockIds);
  if (!group) return noopPlan("invalid-group");
  const deletedIds = selectedSubtreeIds(index, group);
  const firstFlatIndex = index.flat.findIndex((block) => deletedIds.has(block.id));
  const lastFlatIndex = findLastSelectedIndex(index, deletedIds);
  const next = index.flat.slice(lastFlatIndex + 1).find((block) => !deletedIds.has(block.id));
  const previous = [...index.flat.slice(0, firstFlatIndex)].reverse().find((block) => !deletedIds.has(block.id));
  const focus = next
    ? focusAt(existingBlock(next.id), 0)
    : previous
      ? focusAt(existingBlock(previous.id), previous.text.length)
      : null;
  return {
    intents: group.blocks.map((block) => ({
      type: "delete-subtree" as const,
      target: existingBlock(block.id),
    })),
    focus,
  };
}

export function placementBeforeGroup(index: SnapshotIndex, group: SiblingGroup) {
  const first = group.blocks[0]!;
  const previous = group.siblings[group.startIndex - 1] ?? null;
  return {
    parent: first.parentId === null ? null : existingBlock(first.parentId),
    after: previous ? existingBlock(previous.id) : null,
  };
}

function selectedSubtreeIds(index: SnapshotIndex, group: SiblingGroup): Set<string> {
  const result = new Set<string>();
  for (const block of group.blocks) {
    for (const blockId of index.subtreeIds(block.id)) result.add(blockId);
  }
  return result;
}

function findLastSelectedIndex(index: SnapshotIndex, deletedIds: ReadonlySet<string>): number {
  for (let position = index.flat.length - 1; position >= 0; position -= 1) {
    const block = index.flat[position];
    if (block && deletedIds.has(block.id)) return position;
  }
  return -1;
}

export function parentReference(block: EditorBlockSnapshot) {
  return block.parentId === null ? null : existingBlock(block.parentId);
}

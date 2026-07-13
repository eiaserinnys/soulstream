import { normalizedRange, SnapshotIndex } from "./snapshot.js";
import { parentReference, planOutdent } from "./tree-operations.js";
import {
  existingBlock,
  focusAt,
  noopPlan,
  temporaryBlock,
  type EditorOperationPlan,
  type SemanticEditIntent,
  type TextRange,
} from "./types.js";

export function planSplit(
  index: SnapshotIndex,
  blockId: string,
  selection: TextRange,
  newBlockTempId: string | undefined,
  isComposing: boolean | undefined,
): EditorOperationPlan {
  if (isComposing) return noopPlan("composition");
  const block = index.require(blockId);
  const range = normalizedRange(selection.anchor, selection.focus, block.text.length);
  if (block.text.length === 0 && range.start === 0 && block.parentId !== null) {
    return planOutdent(index, [block.id]);
  }

  const prefix = block.text.slice(0, range.start);
  const suffix = block.text.slice(range.end);
  const tempId = newBlockTempId ?? `${block.id}-split`;
  const intents: SemanticEditIntent[] = [];
  if (prefix !== block.text) {
    intents.push({ type: "update-text", target: existingBlock(block.id), text: prefix });
  }
  intents.push({
    type: "create-block",
    tempId,
    parent: parentReference(block),
    after: existingBlock(block.id),
    blockType: block.type,
    text: suffix,
    properties: {},
    collapsed: false,
  });
  return { intents, focus: focusAt(temporaryBlock(tempId), 0) };
}

export function planMergePrevious(
  index: SnapshotIndex,
  blockId: string,
  selection: TextRange,
  isComposing: boolean | undefined,
): EditorOperationPlan {
  if (isComposing) return noopPlan("composition");
  const current = index.require(blockId);
  if (selection.anchor !== selection.focus || selection.focus !== 0) return noopPlan("not-at-start");
  const previous = index.previousFlat(blockId);
  if (!previous) return noopPlan("first-block");

  const intents: SemanticEditIntent[] = [{
    type: "update-text",
    target: existingBlock(previous.id),
    text: previous.text + current.text,
  }];
  appendChildMoves(index, current.id, previous.id, intents);
  intents.push({ type: "delete-subtree", target: existingBlock(current.id) });
  return { intents, focus: focusAt(existingBlock(previous.id), previous.text.length) };
}

export function planMergeNext(
  index: SnapshotIndex,
  blockId: string,
  selection: TextRange,
  isComposing: boolean | undefined,
): EditorOperationPlan {
  if (isComposing) return noopPlan("composition");
  const current = index.require(blockId);
  if (selection.anchor !== selection.focus || selection.focus !== current.text.length) {
    return noopPlan("not-at-end");
  }
  const next = index.nextSibling(blockId);
  if (!next) return noopPlan("last-block");

  const intents: SemanticEditIntent[] = [{
    type: "update-text",
    target: existingBlock(current.id),
    text: current.text + next.text,
  }];
  appendChildMoves(index, next.id, current.id, intents, new Set([next.id]));
  intents.push({ type: "delete-subtree", target: existingBlock(next.id) });
  return { intents, focus: focusAt(existingBlock(current.id), current.text.length) };
}

function appendChildMoves(
  index: SnapshotIndex,
  sourceId: string,
  targetId: string,
  intents: SemanticEditIntent[],
  excludedTargetChildren: ReadonlySet<string> = new Set(),
): void {
  let after = index.lastChild(targetId, excludedTargetChildren);
  for (const child of index.children.get(sourceId) ?? []) {
    intents.push({
      type: "move-block",
      target: existingBlock(child.id),
      parent: existingBlock(targetId),
      after: after ? existingBlock(after.id) : null,
    });
    after = child;
  }
}

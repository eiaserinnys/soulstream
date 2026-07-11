import { normalizedRange, SnapshotIndex, type SiblingGroup } from "./snapshot.js";
import { parentReference, placementBeforeGroup } from "./tree-operations.js";
import {
  existingBlock,
  focusAt,
  noopPlan,
  temporaryBlock,
  type BlockReference,
  type EditorBlockSnapshot,
  type EditorOperationPlan,
  type ParsedClipboard,
  type ParsedClipboardBlock,
  type SemanticEditIntent,
  type TextRange,
} from "./types.js";

export function planPaste(
  index: SnapshotIndex,
  blockId: string,
  selection: TextRange,
  payload: ParsedClipboard,
  tempIdPrefix = `${blockId}-paste`,
): EditorOperationPlan {
  if (payload.kind === "unsupported") return noopPlan(payload.reason);
  const block = index.require(blockId);
  const range = normalizedRange(selection.anchor, selection.focus, block.text.length);
  const prefix = block.text.slice(0, range.start);
  const suffix = block.text.slice(range.end);
  if (payload.kind === "plain-text") {
    return {
      intents: [{ type: "update-text", target: existingBlock(block.id), text: prefix + payload.text + suffix }],
      focus: focusAt(existingBlock(block.id), prefix.length + payload.text.length),
    };
  }
  if (payload.blocks.length === 0) return noopPlan("empty-clipboard");
  return buildTreePaste(block, payload.blocks, prefix, suffix, tempIdPrefix);
}

export function planPasteOverSelection(
  index: SnapshotIndex,
  blockIds: readonly string[],
  placeholderTempId: string,
  payload: ParsedClipboard,
  tempIdPrefix = `${placeholderTempId}-paste`,
): EditorOperationPlan {
  if (payload.kind === "unsupported") return noopPlan(payload.reason);
  const group = index.siblingGroup(blockIds);
  if (!group) return noopPlan("invalid-group");
  const first = group.blocks[0]!;
  const placement = placementBeforeGroup(index, group);
  const placeholderText = payload.kind === "plain-text"
    ? payload.text
    : payload.blocks[0]?.text ?? "";
  const intents: SemanticEditIntent[] = [{
    type: "create-block",
    tempId: placeholderTempId,
    ...placement,
    blockType: first.type,
    text: placeholderText,
    properties: {},
    collapsed: false,
  }];
  intents.push(...deleteGroupIntents(group));
  if (payload.kind === "plain-text") {
    return { intents, focus: focusAt(temporaryBlock(placeholderTempId), payload.text.length) };
  }
  if (payload.blocks.length === 0) return noopPlan("empty-clipboard");

  const builder = new PasteTreeBuilder(tempIdPrefix, intents);
  const roots = payload.blocks;
  builder.appendChildren(temporaryBlock(placeholderTempId), roots[0]!.children);
  let after: BlockReference = temporaryBlock(placeholderTempId);
  for (const root of roots.slice(1)) {
    after = builder.appendBlock(placement.parent, after, root);
  }
  return { intents, focus: focusAt(after, roots[roots.length - 1]!.text.length) };
}

function buildTreePaste(
  block: EditorBlockSnapshot,
  roots: readonly ParsedClipboardBlock[],
  prefix: string,
  suffix: string,
  tempIdPrefix: string,
): EditorOperationPlan {
  const intents: SemanticEditIntent[] = [];
  const first = roots[0]!;
  const firstIsLast = roots.length === 1;
  intents.push({
    type: "update-text",
    target: existingBlock(block.id),
    text: prefix + first.text + (firstIsLast ? suffix : ""),
  });
  const builder = new PasteTreeBuilder(tempIdPrefix, intents);
  builder.appendChildren(existingBlock(block.id), first.children);
  let last: BlockReference = existingBlock(block.id);
  for (const [index, root] of roots.slice(1).entries()) {
    const isLast = index === roots.length - 2;
    last = builder.appendBlock(parentReference(block), last, {
      ...root,
      text: root.text + (isLast ? suffix : ""),
    });
  }
  const focusOffset = roots.length === 1
    ? prefix.length + first.text.length
    : (roots[roots.length - 1]?.text ?? "").length;
  return { intents, focus: focusAt(last, focusOffset) };
}

class PasteTreeBuilder {
  private nextId = 1;

  constructor(
    private readonly prefix: string,
    private readonly intents: SemanticEditIntent[],
  ) {}

  appendChildren(parent: BlockReference, blocks: readonly ParsedClipboardBlock[]): void {
    let after: BlockReference | null = null;
    for (const block of blocks) after = this.appendBlock(parent, after, block);
  }

  appendBlock(
    parent: BlockReference | null,
    after: BlockReference | null,
    block: ParsedClipboardBlock,
  ): BlockReference {
    const tempId = `${this.prefix}-${this.nextId}`;
    this.nextId += 1;
    const target = temporaryBlock(tempId);
    this.intents.push({
      type: "create-block",
      tempId,
      parent,
      after,
      blockType: "paragraph",
      text: block.text,
      properties: {},
      collapsed: false,
    });
    this.appendChildren(target, block.children);
    return target;
  }
}

function deleteGroupIntents(group: SiblingGroup): SemanticEditIntent[] {
  return group.blocks.map((block) => ({
    type: "delete-subtree" as const,
    target: existingBlock(block.id),
  }));
}

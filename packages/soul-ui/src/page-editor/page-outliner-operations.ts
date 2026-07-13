import {
  decideHorizontalEdgeNavigation,
  decideVerticalEdgeNavigation,
  existingBlock,
  type EditorOperation,
  type FocusResult,
} from "@soulstream/page-editor-core";

import type { PageDocumentBlock } from "../page";
import type { PageBlockEditorKeyInput } from "./PageBlockEditor";
import { measureTextareaCaretLines } from "./page-editor-caret-geometry";

export function structuralOperation(
  input: PageBlockEditorKeyInput,
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  selectedIds: readonly string[],
): EditorOperation | null {
  const range = { anchor: input.anchor, focus: input.focus };
  if (event.key === "Enter") return { type: "splitBlock", blockId: input.block.id, selection: range, newBlockTempId: uniqueTempId("split"), isComposing: input.isComposing };
  if (event.key === "Tab") {
    return {
      type: event.shiftKey ? "outdent" : "indent",
      blockIds: selectedIds,
      focus: { blockId: input.block.id, selection: range },
    };
  }
  if (event.key === "Backspace") {
    if (selectedIds.length > 1) return { type: "deleteSelection", blockIds: selectedIds };
    return input.anchor === input.focus && input.focus === 0
      ? { type: "mergePrevious", blockId: input.block.id, selection: range, isComposing: input.isComposing }
      : null;
  }
  if (event.key === "Delete") {
    if (selectedIds.length > 1) return { type: "deleteSelection", blockIds: selectedIds };
    return input.anchor === input.focus && input.focus === input.block.textValue.length
      ? { type: "mergeNext", blockId: input.block.id, selection: range, isComposing: input.isComposing }
      : null;
  }
  return null;
}

export function handleArrowNavigation(
  input: PageBlockEditorKeyInput,
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  blocks: readonly PageDocumentBlock[],
  queueFocus: (focus: { blockId: string; anchor: number; focus: number } | null) => void,
): boolean {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || event.shiftKey) return false;
  const index = blocks.findIndex((block) => block.id === input.block.id);
  const previous = blocks[index - 1];
  const next = blocks[index + 1];
  const adjacent = (block: PageDocumentBlock | undefined) => block
    ? { target: existingBlock(block.id), textLength: block.textValue.length }
    : null;
  const selection = { anchor: input.anchor, focus: input.focus };
  const decision = event.key === "ArrowLeft" || event.key === "ArrowRight"
    ? decideHorizontalEdgeNavigation({
        direction: event.key === "ArrowLeft" ? "left" : "right",
        selection,
        textLength: input.block.textValue.length,
        previousBlock: adjacent(previous),
        nextBlock: adjacent(next),
      })
    : decideVerticalEdgeNavigation({
        direction: event.key === "ArrowUp" ? "up" : "down",
        selection,
        metrics: measureTextareaCaretLines(input.element, input.focus),
        previousBlock: adjacent(previous),
        nextBlock: adjacent(next),
      });
  if (decision.kind === "native") return false;
  event.preventDefault();
  const target = decision.focus.target;
  queueFocus({
    blockId: target.kind === "existing" ? target.blockId : target.tempId,
    anchor: decision.focus.selection.anchor,
    focus: decision.focus.selection.focus,
  });
  return true;
}

export function crossesVerticalBlockEdge(
  input: PageBlockEditorKeyInput,
  key: "ArrowUp" | "ArrowDown",
  blocks: readonly PageDocumentBlock[],
): boolean {
  const index = blocks.findIndex((block) => block.id === input.block.id);
  const adjacent = key === "ArrowUp" ? blocks[index - 1] : blocks[index + 1];
  if (!adjacent) return false;
  return decideVerticalEdgeNavigation({
    direction: key === "ArrowUp" ? "up" : "down",
    selection: { anchor: input.anchor, focus: input.focus },
    metrics: measureTextareaCaretLines(input.element, input.focus),
    previousBlock: key === "ArrowUp" ? { target: existingBlock(adjacent.id), textLength: adjacent.textValue.length } : null,
    nextBlock: key === "ArrowDown" ? { target: existingBlock(adjacent.id), textLength: adjacent.textValue.length } : null,
  }).kind === "focus";
}

export function outlineDepths(blocks: readonly PageDocumentBlock[]): ReadonlyMap<string, number> {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const depths = new Map<string, number>();
  for (const block of blocks) {
    let depth = 0;
    let parentId = block.parentId;
    const visited = new Set<string>([block.id]);
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    depths.set(block.id, depth);
  }
  return depths;
}

export function visibleOutlineBlocks(
  blocks: readonly PageDocumentBlock[],
): readonly PageDocumentBlock[] {
  const hiddenParents = new Set<string>();
  const visible: PageDocumentBlock[] = [];
  for (const block of blocks) {
    if (block.parentId !== null && hiddenParents.has(block.parentId)) {
      hiddenParents.add(block.id);
      continue;
    }
    visible.push(block);
    if (block.collapsed) hiddenParents.add(block.id);
  }
  return visible;
}

export function toCoreFocus(focus: { blockId: string; anchor: number; focus: number }): FocusResult {
  return { target: existingBlock(focus.blockId), selection: { anchor: focus.anchor, focus: focus.focus } };
}

export function uniqueTempId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

export function cssEscape(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

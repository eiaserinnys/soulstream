import { isMarkdownRepresentableBlockType } from "@soulstream/page-model";
import * as Y from "yjs";

import {
  BLOCKS_MAP,
  PAGE_META_MAP,
  createPageYText,
  readPageYDocReplica,
  type PageYjsBlockInput,
} from "./page_yjs_model.js";
import { yMapFromRecord } from "./page_mutation_helpers.js";
import {
  PageMutationValidationError,
  validateBlockProperties,
  validateBoundary,
} from "./page_mutation_validation.js";

export function replacePageMarkdownBlocks(
  doc: Y.Doc,
  inputs: readonly PageYjsBlockInput[],
): void {
  for (const input of inputs) validateMarkdownInput(input);

  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  const preservedBlocks = [...blocks.values()].filter((block) => (
    !isMarkdownRepresentableBlockType(blockType(block))
  ));
  for (const [id, block] of [...blocks.entries()]) {
    if (isMarkdownRepresentableBlockType(blockType(block))) blocks.delete(id);
  }
  for (const input of inputs) createMarkdownBlock(blocks, input);
  for (const block of preservedBlocks) {
    const parentId = blockParent(block);
    if (parentId !== null && !blocks.has(parentId)) block.set("parentId", null);
  }

  const pageId = requireString(doc.getMap(PAGE_META_MAP).get("id"), "page id");
  readPageYDocReplica(pageId, doc);
}

function validateMarkdownInput(input: PageYjsBlockInput): void {
  if (!isMarkdownRepresentableBlockType(input.type)) {
    throw new PageMutationValidationError(
      `replace_page_markdown cannot create structural block type: ${input.type}`,
    );
  }
  validateBoundary(input.id, "block id");
  validateBoundary(input.positionKey, "block position key");
  if (input.parentId !== null) validateBoundary(input.parentId, "block parent id");
  validateBlockProperties(input.type, input.properties);
}

function createMarkdownBlock(
  blocks: Y.Map<Y.Map<unknown>>,
  input: PageYjsBlockInput,
): void {
  if (blocks.has(input.id)) {
    throw new PageMutationValidationError(`block already exists: ${input.id}`);
  }
  if (input.parentId !== null && !blocks.has(input.parentId)) {
    throw new PageMutationValidationError(`block not found in page: ${input.parentId}`);
  }
  const block = new Y.Map<unknown>();
  block.set("id", input.id);
  block.set("parentId", input.parentId);
  block.set("positionKey", input.positionKey);
  block.set("type", input.type);
  block.set("text", createPageYText(input));
  block.set("properties", yMapFromRecord(input.properties));
  block.set("collapsed", input.collapsed);
  blocks.set(input.id, block);
}

function blockType(block: Y.Map<unknown>): string {
  return requireString(block.get("type"), "block type");
}

function blockParent(block: Y.Map<unknown>): string | null {
  const value = block.get("parentId");
  return value === null ? null : requireString(value, "block parent id");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

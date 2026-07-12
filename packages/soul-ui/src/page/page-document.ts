import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";
import * as Y from "yjs";

export const PAGE_META_MAP = "pageMeta";
export const BLOCKS_MAP = "blocks";
export const PAGE_YJS_SCHEMA_VERSION = 1;

export interface PageDocumentMeta {
  readonly id: string;
  readonly title: string;
  readonly dailyDate: string | null;
  readonly mutationVersion: number;
  readonly archived: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PageDocumentBlock {
  readonly id: string;
  readonly parentId: string | null;
  readonly positionKey: string;
  readonly type: string;
  readonly text: Y.Text;
  readonly textValue: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly collapsed: boolean;
}

export interface PageDocumentSnapshot {
  readonly page: PageDocumentMeta;
  readonly blocks: readonly PageDocumentBlock[];
}

export interface PageDocumentProjection {
  getSnapshot(): PageDocumentSnapshot;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export function createPageDocumentProjection(doc: Y.Doc, pageId: string): PageDocumentProjection {
  const pageMeta = doc.getMap<unknown>(PAGE_META_MAP);
  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  const listeners = new Set<() => void>();
  let destroyed = false;
  let snapshot = readPageDocument(doc, pageId);
  const refresh = () => {
    if (destroyed) return;
    snapshot = readPageDocument(doc, pageId);
    for (const listener of listeners) listener();
  };
  pageMeta.observeDeep(refresh);
  blocks.observeDeep(refresh);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (destroyed) throw new Error("page document projection is destroyed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      pageMeta.unobserveDeep(refresh);
      blocks.unobserveDeep(refresh);
    },
  };
}

export function readPageDocument(doc: Y.Doc, expectedPageId: string): PageDocumentSnapshot {
  const meta = doc.getMap<unknown>(PAGE_META_MAP);
  const schemaVersion = integer(meta.get("schemaVersion"), "pageMeta.schemaVersion");
  if (schemaVersion !== PAGE_YJS_SCHEMA_VERSION) {
    throw new Error(`unsupported page Y.Doc schema version: ${schemaVersion}`);
  }
  const id = identifier(meta.get("id"), "pageMeta.id");
  if (id !== expectedPageId) {
    throw new Error(`page id mismatch: expected ${expectedPageId}, received ${id}`);
  }
  const page: PageDocumentMeta = Object.freeze({
    id,
    title: nonEmptyString(meta.get("title"), "pageMeta.title"),
    dailyDate: dailyDate(meta.get("dailyDate")),
    mutationVersion: positiveInteger(meta.get("mutationVersion"), "pageMeta.mutationVersion"),
    archived: boolean(meta.get("archived"), "pageMeta.archived"),
    metadata: Object.freeze(record(meta.get("metadata"), "pageMeta.metadata")),
  });
  const blockMap = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  const byId = new Map<string, PageDocumentBlock>();
  for (const [mapKey, value] of blockMap.entries()) {
    if (!(value instanceof Y.Map)) throw new Error(`block ${mapKey} must be a Y.Map`);
    const blockId = identifier(value.get("id"), `block ${mapKey}.id`);
    if (blockId !== mapKey) throw new Error(`block id mismatch: key ${mapKey}, value ${blockId}`);
    const text = value.get("text");
    if (!(text instanceof Y.Text)) throw new Error(`block ${blockId}.text must be a Y.Text`);
    const properties = value.get("properties");
    if (!(properties instanceof Y.Map)) throw new Error(`block ${blockId}.properties must be a Y.Map`);
    byId.set(blockId, Object.freeze({
      id: blockId,
      parentId: nullableIdentifier(value.get("parentId"), `block ${blockId}.parentId`),
      positionKey: nonEmptyString(value.get("positionKey"), `block ${blockId}.positionKey`),
      type: nonEmptyString(value.get("type"), `block ${blockId}.type`),
      text,
      textValue: text.toString(),
      properties: Object.freeze(record(properties.toJSON(), `block ${blockId}.properties`)),
      collapsed: boolean(value.get("collapsed"), `block ${blockId}.collapsed`),
    }));
  }
  validateParents(byId);
  return Object.freeze({ page, blocks: Object.freeze(orderBlocks(byId)) });
}

export function getPageBlockText(doc: Y.Doc, blockId: string): Y.Text {
  const block = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP).get(blockId);
  if (!(block instanceof Y.Map)) throw new Error(`page block not found: ${blockId}`);
  const text = block.get("text");
  if (!(text instanceof Y.Text)) throw new Error(`block ${blockId}.text must be a Y.Text`);
  return text;
}

function orderBlocks(blocks: ReadonlyMap<string, PageDocumentBlock>): PageDocumentBlock[] {
  const children = new Map<string | null, PageDocumentBlock[]>();
  for (const block of blocks.values()) {
    const siblings = children.get(block.parentId) ?? [];
    siblings.push(block);
    children.set(block.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => comparePositionKeys(a.positionKey, b.positionKey) || compareLexicographically(a.id, b.id));
  }
  const ordered: PageDocumentBlock[] = [];
  const stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const block = stack.pop();
    if (!block) break;
    ordered.push(block);
    const descendants = children.get(block.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push(descendants[index]!);
    }
  }
  return ordered;
}

function validateParents(blocks: ReadonlyMap<string, PageDocumentBlock>): void {
  for (const block of blocks.values()) {
    if (block.parentId === block.id) throw new Error(`block cycle: ${block.id} is its own parent`);
    if (block.parentId !== null && !blocks.has(block.parentId)) {
      throw new Error(`block ${block.id} parent does not exist: ${block.parentId}`);
    }
    const seen = new Set<string>([block.id]);
    let parentId = block.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error(`block cycle detected at ${parentId}`);
      seen.add(parentId);
      parentId = blocks.get(parentId)?.parentId ?? null;
    }
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function dailyDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("pageMeta.dailyDate must be YYYY-MM-DD or null");
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return { ...(value as Record<string, unknown>) };
}

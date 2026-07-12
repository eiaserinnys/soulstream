import { compareLexicographically, comparePositionKeys } from "@soulstream/fractional-position";
import * as Y from "yjs";

export const PAGE_YJS_PREFIX = "page:";
export const PAGE_META_MAP = "pageMeta";
export const BLOCKS_MAP = "blocks";
export const PAGE_YJS_SCHEMA_VERSION = 1;

export interface PageYjsPageReplica {
  id: string;
  title: string;
  dailyDate: string | null;
  mutationVersion: number;
  archived: boolean;
  metadata: Record<string, unknown>;
}

export interface PageYjsTextDelta {
  insert: string;
  attributes?: Record<string, unknown>;
}

export interface PageYjsBlockInput {
  id: string;
  parentId: string | null;
  positionKey: string;
  type: string;
  text: string;
  textDelta?: readonly PageYjsTextDelta[];
  properties: Record<string, unknown>;
  collapsed: boolean;
}

export interface PageYjsBlockReplica extends PageYjsBlockInput {
  textDelta: PageYjsTextDelta[];
}

export interface PageYjsReplica {
  page: PageYjsPageReplica;
  blocks: PageYjsBlockReplica[];
}

export function getPageYjsDocumentName(pageId: string): string {
  assertIdentifier(pageId, "pageId");
  return `${PAGE_YJS_PREFIX}${pageId}`;
}

export function parsePageYjsDocumentName(documentName: string): string | null {
  if (!documentName.startsWith(PAGE_YJS_PREFIX)) return null;
  const pageId = documentName.slice(PAGE_YJS_PREFIX.length);
  return isIdentifier(pageId) ? pageId : null;
}

export function createPageYDocSnapshot(input: {
  page: PageYjsPageReplica;
  blocks: readonly PageYjsBlockInput[];
}): Uint8Array {
  const doc = new Y.Doc();
  const pageMeta = doc.getMap<unknown>(PAGE_META_MAP);
  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);

  doc.transact(() => {
    pageMeta.set("schemaVersion", PAGE_YJS_SCHEMA_VERSION);
    pageMeta.set("id", input.page.id);
    pageMeta.set("title", input.page.title);
    pageMeta.set("dailyDate", input.page.dailyDate);
    pageMeta.set("mutationVersion", input.page.mutationVersion);
    pageMeta.set("archived", input.page.archived);
    pageMeta.set("metadata", cloneRecord(input.page.metadata));

    for (const block of input.blocks) {
      if (blocks.has(block.id)) throw new Error(`duplicate block id: ${block.id}`);
      const value = new Y.Map<unknown>();
      value.set("id", block.id);
      value.set("parentId", block.parentId);
      value.set("positionKey", block.positionKey);
      value.set("type", block.type);
      value.set("text", createYText(block));
      value.set("properties", createYMap(block.properties));
      value.set("collapsed", block.collapsed);
      blocks.set(block.id, value);
    }
  });

  readPageYDocReplica(input.page.id, doc);
  return Y.encodeStateAsUpdate(doc);
}

export function readPageYDocReplica(expectedPageId: string, doc: Y.Doc): PageYjsReplica {
  assertIdentifier(expectedPageId, "pageId");
  const pageMeta = doc.getMap<unknown>(PAGE_META_MAP);
  const schemaVersion = requireInteger(pageMeta.get("schemaVersion"), "pageMeta.schemaVersion");
  if (schemaVersion !== PAGE_YJS_SCHEMA_VERSION) {
    throw new Error(`unsupported page Y.Doc schema version: ${schemaVersion}`);
  }
  const pageId = requireIdentifier(pageMeta.get("id"), "pageMeta.id");
  if (pageId !== expectedPageId) {
    throw new Error(`page id mismatch: expected ${expectedPageId}, received ${pageId}`);
  }
  const title = requireNonEmptyString(pageMeta.get("title"), "pageMeta.title");
  const dailyDate = requireDailyDate(pageMeta.get("dailyDate"));
  const mutationVersion = requireInteger(
    pageMeta.get("mutationVersion"),
    "pageMeta.mutationVersion",
  );
  if (mutationVersion < 1) throw new Error("pageMeta.mutationVersion must be positive");
  const archived = requireBoolean(pageMeta.get("archived"), "pageMeta.archived");
  const metadata = requireRecord(pageMeta.get("metadata"), "pageMeta.metadata");

  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  const byId = new Map<string, PageYjsBlockReplica>();
  for (const [mapKey, value] of blocks.entries()) {
    if (!(value instanceof Y.Map)) throw new Error(`block ${mapKey} must be a Y.Map`);
    const id = requireIdentifier(value.get("id"), `block ${mapKey}.id`);
    if (id !== mapKey) throw new Error(`block id mismatch: key ${mapKey}, value ${id}`);
    if (byId.has(id)) throw new Error(`duplicate block id: ${id}`);
    const parentId = requireNullableIdentifier(value.get("parentId"), `block ${id}.parentId`);
    const positionKey = requireNonEmptyString(value.get("positionKey"), `block ${id}.positionKey`);
    if (!positionKey.trim()) throw new Error(`block ${id}.positionKey must be non-empty`);
    const type = requireNonEmptyString(value.get("type"), `block ${id}.type`);
    const text = value.get("text");
    if (!(text instanceof Y.Text)) throw new Error(`block ${id}.text must be a Y.Text`);
    const properties = value.get("properties");
    if (!(properties instanceof Y.Map)) {
      throw new Error(`block ${id}.properties must be a Y.Map`);
    }
    byId.set(id, {
      id,
      parentId,
      positionKey,
      type,
      text: text.toString(),
      textDelta: normalizeTextDelta(text.toDelta()),
      properties: requireRecord(properties.toJSON(), `block ${id}.properties`),
      collapsed: requireBoolean(value.get("collapsed"), `block ${id}.collapsed`),
    });
  }

  validateBlockTree(byId);
  return {
    page: { id: pageId, title, dailyDate, mutationVersion, archived, metadata },
    blocks: orderBlocks(byId),
  };
}

function createYText(block: PageYjsBlockInput): Y.Text {
  const text = new Y.Text();
  if (block.textDelta) {
    const plain = block.textDelta.map((part) => part.insert).join("");
    if (plain !== block.text) {
      throw new Error(`block ${block.id}.textDelta does not match text`);
    }
    text.applyDelta(block.textDelta.map((part) => ({
      insert: part.insert,
      ...(part.attributes ? { attributes: cloneRecord(part.attributes) } : {}),
    })));
  } else if (block.text.length > 0) {
    text.insert(0, block.text);
  }
  return text;
}

function createYMap(input: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(input)) map.set(key, cloneJsonValue(value));
  return map;
}

function validateBlockTree(blocks: ReadonlyMap<string, PageYjsBlockReplica>): void {
  for (const block of blocks.values()) {
    if (block.parentId === block.id) throw new Error(`block cycle: ${block.id} is its own parent`);
    if (block.parentId !== null && !blocks.has(block.parentId)) {
      throw new Error(`block ${block.id} parent does not exist: ${block.parentId}`);
    }
  }

  const visited = new Set<string>();
  for (const startId of blocks.keys()) {
    if (visited.has(startId)) continue;
    const path = new Set<string>();
    const chain: string[] = [];
    let currentId: string | null = startId;
    while (currentId !== null && !visited.has(currentId)) {
      if (path.has(currentId)) throw new Error(`block cycle detected at ${currentId}`);
      path.add(currentId);
      chain.push(currentId);
      currentId = blocks.get(currentId)?.parentId ?? null;
    }
    for (const id of chain) visited.add(id);
  }
}

function orderBlocks(blocks: ReadonlyMap<string, PageYjsBlockReplica>): PageYjsBlockReplica[] {
  const children = new Map<string | null, PageYjsBlockReplica[]>();
  for (const block of blocks.values()) {
    const siblings = children.get(block.parentId) ?? [];
    siblings.push(block);
    children.set(block.parentId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => comparePositionKeys(a.positionKey, b.positionKey) || compareLexicographically(a.id, b.id));
  }
  const result: PageYjsBlockReplica[] = [];
  const stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const block = stack.pop();
    if (!block) break;
    result.push(block);
    const descendants = children.get(block.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push(descendants[index]!);
    }
  }
  return result;
}

function normalizeTextDelta(delta: readonly Record<string, unknown>[]): PageYjsTextDelta[] {
  return delta.map((part) => {
    if (typeof part.insert !== "string") throw new Error("page block text delta must insert strings");
    const attributes = part.attributes;
    return {
      insert: part.insert,
      ...(attributes === undefined
        ? {}
        : { attributes: requireRecord(attributes, "page block text delta attributes") }),
    };
  });
}

function requireDailyDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("pageMeta.dailyDate must be YYYY-MM-DD or null");
  }
  return value;
}

function requireNullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : requireIdentifier(value, label);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  assertIdentifier(value, label);
  return value;
}

function assertIdentifier(value: string, label: string): void {
  if (!isIdentifier(value)) throw new Error(`${label} must be a non-empty trimmed string`);
}

function isIdentifier(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return cloneRecord(value as Record<string, unknown>);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]),
  );
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("page Y.Doc JSON values must be plain objects");
    }
    return cloneRecord(value as Record<string, unknown>);
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("page Y.Doc values must be JSON-compatible");
}

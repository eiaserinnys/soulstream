import { randomUUID } from "node:crypto";

import { generateKeyBetween } from "@soulstream/fractional-position";
import type { PageActorKind, PageOperationType } from "@soulstream/page-model";
import * as Y from "yjs";

import {
  BLOCKS_MAP,
  PAGE_META_MAP,
  createPageYDocSnapshot,
  readPageYDocReplica,
  type PageYjsBlockInput,
  type PageYjsReplica,
} from "./page_yjs_model.js";
import {
  PageMutationValidationError,
  validateActor,
  validateBlockProperties,
  validateBoundary,
  validateIdempotencyKey,
  validateTitle,
} from "./page_mutation_validation.js";

export { PageMutationValidationError } from "./page_mutation_validation.js";

export interface PageMutationActor {
  actorKind: PageActorKind;
  actorSessionId?: string | null;
  actorUserId?: string | null;
}

export type PageBatchOperation =
  | ({ op: "create_block"; tempId: string } & PageBlockPlacement & PageBlockContent)
  | { op: "update_block_text"; blockId: string; text: string }
  | {
      op: "update_block_type_and_properties";
      blockId: string;
      blockType: string;
      properties: Record<string, unknown>;
    }
  | ({ op: "move_block"; blockId: string } & PageBlockPlacement)
  | { op: "delete_block_subtree"; blockId: string }
  | { op: "set_check_state"; blockId: string; checked: boolean }
  | { op: "rename_page"; title: string }
  | { op: "set_page_archived"; archived: boolean };

export type PageMutationCommand =
  | { type: "rename_page"; title: string }
  | { type: "archive_page" }
  | { type: "unarchive_page" }
  | ({ type: "create_block"; id?: string } & PageBlockPlacement & PageBlockContent)
  | { type: "update_block_text"; blockId: string; text: string }
  | {
      type: "update_block_type_and_properties";
      blockId: string;
      blockType: string;
      properties: Record<string, unknown>;
    }
  | ({ type: "move_block"; blockId: string } & PageBlockPlacement)
  | { type: "delete_block_subtree"; blockId: string }
  | { type: "set_check_state"; blockId: string; checked: boolean }
  | { type: "replace_page_markdown"; blocks: readonly PageYjsBlockInput[] }
  | { type: "batch_operations"; operations: readonly PageBatchOperation[] };

interface PageBlockPlacement {
  parentId: string | null;
  parentTempId?: string | null;
  afterBlockId: string | null;
  afterTempId?: string | null;
}

interface PageBlockContent {
  blockType: string;
  text: string;
  properties: Record<string, unknown>;
  collapsed?: boolean;
}

export interface PageMutationInput {
  pageId: string;
  expectedVersion: number;
  command: PageMutationCommand;
  actor: PageMutationActor;
  idempotencyKey: string;
  reason?: string | null;
}

export interface CreatePageMutationInput {
  page: {
    id: string;
    title: string;
    dailyDate: string | null;
    metadata?: Record<string, unknown>;
  };
  actor: PageMutationActor;
  idempotencyKey: string;
  reason?: string | null;
  initialCommand?: Extract<PageMutationCommand,
    { type: "batch_operations" } | { type: "replace_page_markdown" }>;
}

export interface PageMutationApplication {
  document: Y.Doc;
  snapshot: Uint8Array;
  update: Uint8Array;
  replica: PageYjsReplica;
  operationType: PageOperationType;
  targetBlockId: string | null;
  expectedVersion: number;
  resultVersion: number;
  actor: PageMutationActor;
  idempotencyKey: string;
  reason: string | null;
  payload: Record<string, unknown>;
  tempIdMapping: Record<string, string>;
}

export class PageMutationVersionConflictError extends Error {
  readonly code = "PAGE_MUTATION_VERSION_CONFLICT";

  constructor(
    readonly pageId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`page ${pageId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
  }
}

export class PageMutationCore {
  private readonly createId: () => string;

  constructor(options: { createId?: () => string } = {}) {
    this.createId = options.createId ?? randomUUID;
  }

  createPage(input: CreatePageMutationInput): PageMutationApplication {
    validateBoundary(input.page.id, "page id");
    validateTitle(input.page.title);
    validateActor(input.actor);
    validateIdempotencyKey(input.idempotencyKey);
    const snapshot = createPageYDocSnapshot({
      page: {
        id: input.page.id,
        title: input.page.title.trim(),
        dailyDate: input.page.dailyDate,
        mutationVersion: 1,
        archived: false,
        metadata: input.page.metadata ?? {},
      },
      blocks: [],
    });
    const document = docFromUpdate(snapshot);
    const applied = input.initialCommand
      ? this.applyCommand(document, input.initialCommand)
      : appliedCreatePage();
    return this.buildApplication(document, new Uint8Array(), {
      ...applied,
      expectedVersion: 0,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      payload: input.initialCommand
        ? { page: input.page, ...commandPayload(input.initialCommand) }
        : { page: input.page },
    });
  }

  mutate(source: Y.Doc, input: PageMutationInput): PageMutationApplication {
    validateBoundary(input.pageId, "page id");
    validateActor(input.actor);
    validateIdempotencyKey(input.idempotencyKey);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new PageMutationValidationError("expected version must be a positive integer");
    }
    const sourceReplica = readPageYDocReplica(input.pageId, source);
    if (sourceReplica.page.mutationVersion !== input.expectedVersion) {
      throw new PageMutationVersionConflictError(
        input.pageId,
        input.expectedVersion,
        sourceReplica.page.mutationVersion,
      );
    }

    const beforeVector = Y.encodeStateVector(source);
    const document = docFromUpdate(Y.encodeStateAsUpdate(source));
    const applied = this.applyCommand(document, input.command);
    document.getMap(PAGE_META_MAP).set("mutationVersion", input.expectedVersion + 1);
    const update = Y.encodeStateAsUpdate(document, beforeVector);
    return this.buildApplication(document, update, {
      ...applied,
      expectedVersion: input.expectedVersion,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
      payload: commandPayload(input.command),
    });
  }

  private applyCommand(
    doc: Y.Doc,
    command: PageMutationCommand,
  ): Pick<PageMutationApplication, "operationType" | "targetBlockId" | "tempIdMapping"> {
    switch (command.type) {
      case "rename_page":
        validateTitle(command.title);
        doc.getMap(PAGE_META_MAP).set("title", command.title.trim());
        return applied("rename_page");
      case "archive_page":
      case "unarchive_page":
        doc.getMap(PAGE_META_MAP).set("archived", command.type === "archive_page");
        return applied(command.type);
      case "create_block": {
        const id = command.id ?? this.createId();
        createBlock(doc, id, command, command.parentId, command.afterBlockId);
        return applied("create_block", id);
      }
      case "update_block_text":
        replaceText(requireBlock(doc, command.blockId), command.text);
        return applied("update_block_text", command.blockId);
      case "update_block_type_and_properties":
        validateBlockProperties(command.blockType, command.properties);
        updateTypeAndProperties(requireBlock(doc, command.blockId), command);
        return applied("update_block_type_and_properties", command.blockId);
      case "move_block":
        moveBlock(doc, command.blockId, command.parentId, command.afterBlockId);
        return applied("move_block", command.blockId);
      case "delete_block_subtree":
        deleteSubtree(doc, command.blockId);
        return applied("delete_block_subtree");
      case "set_check_state":
        setCheckState(requireBlock(doc, command.blockId), command.checked);
        return applied("set_check_state", command.blockId);
      case "replace_page_markdown":
        replaceBlocks(doc, command.blocks);
        return applied("replace_page_markdown");
      case "batch_operations":
        return { ...this.applyBatch(doc, command.operations), operationType: "batch_operations" };
    }
  }

  private applyBatch(doc: Y.Doc, operations: readonly PageBatchOperation[]) {
    if (operations.length === 0) {
      throw new PageMutationValidationError("batch operations must not be empty");
    }
    const declaredTemps = new Set<string>();
    for (const operation of operations) {
      if (operation.op !== "create_block") continue;
      validateBoundary(operation.tempId, "temp id");
      if (declaredTemps.has(operation.tempId)) {
        throw new PageMutationValidationError(`duplicate temp id: ${operation.tempId}`);
      }
      declaredTemps.add(operation.tempId);
    }
    const mapping: Record<string, string> = {};
    const resolve = (value: string): string => {
      if (!declaredTemps.has(value)) return value;
      const resolved = mapping[value];
      if (!resolved) throw new PageMutationValidationError(`forward temp id reference: ${value}`);
      return resolved;
    };

    for (const operation of operations) {
      if (operation.op === "create_block") {
        const id = this.createId();
        const parentId = resolvePlacement(operation.parentId, operation.parentTempId, resolve);
        const afterId = resolvePlacement(operation.afterBlockId, operation.afterTempId, resolve);
        createBlock(doc, id, operation, parentId, afterId);
        mapping[operation.tempId] = id;
      } else if (operation.op === "rename_page") {
        validateTitle(operation.title);
        doc.getMap(PAGE_META_MAP).set("title", operation.title.trim());
      } else if (operation.op === "set_page_archived") {
        doc.getMap(PAGE_META_MAP).set("archived", operation.archived);
      } else if (operation.op === "update_block_text") {
        replaceText(requireBlock(doc, resolve(operation.blockId)), operation.text);
      } else if (operation.op === "update_block_type_and_properties") {
        validateBlockProperties(operation.blockType, operation.properties);
        updateTypeAndProperties(requireBlock(doc, resolve(operation.blockId)), operation);
      } else if (operation.op === "move_block") {
        moveBlock(
          doc,
          resolve(operation.blockId),
          resolvePlacement(operation.parentId, operation.parentTempId, resolve),
          resolvePlacement(operation.afterBlockId, operation.afterTempId, resolve),
        );
      } else if (operation.op === "delete_block_subtree") {
        deleteSubtree(doc, resolve(operation.blockId));
      } else {
        setCheckState(requireBlock(doc, resolve(operation.blockId)), operation.checked);
      }
    }
    return { targetBlockId: null, tempIdMapping: mapping };
  }

  private buildApplication(
    document: Y.Doc,
    update: Uint8Array,
    input: Omit<PageMutationApplication, "document" | "snapshot" | "update" | "replica" | "resultVersion" | "reason"> & {
      reason?: string | null;
    },
  ): PageMutationApplication {
    const replica = readPageYDocReplica(input.payload.page && input.operationType === "create_page"
      ? (input.payload.page as { id: string }).id
      : requireString(document.getMap(PAGE_META_MAP).get("id"), "page id"), document);
    return {
      ...input,
      reason: input.reason ?? null,
      document,
      snapshot: Y.encodeStateAsUpdate(document),
      update,
      replica,
      resultVersion: replica.page.mutationVersion,
    };
  }
}

function applied(operationType: PageOperationType, targetBlockId: string | null = null) {
  return { operationType, targetBlockId, tempIdMapping: {} };
}

function appliedCreatePage() {
  return applied("create_page");
}

function createBlock(
  doc: Y.Doc,
  id: string,
  content: PageBlockContent,
  parentId: string | null,
  afterBlockId: string | null,
): void {
  validateBoundary(id, "block id");
  validateBlockProperties(content.blockType, content.properties);
  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  if (blocks.has(id)) throw new PageMutationValidationError(`block already exists: ${id}`);
  if (parentId !== null) requireBlock(doc, parentId);
  const block = new Y.Map<unknown>();
  block.set("id", id);
  block.set("parentId", parentId);
  block.set("positionKey", positionAfter(doc, parentId, afterBlockId));
  block.set("type", content.blockType);
  const text = new Y.Text();
  if (content.text) text.insert(0, content.text);
  block.set("text", text);
  block.set("properties", yMapFromRecord(content.properties));
  block.set("collapsed", content.collapsed ?? false);
  blocks.set(id, block);
}

function moveBlock(
  doc: Y.Doc,
  blockId: string,
  parentId: string | null,
  afterBlockId: string | null,
): void {
  const block = requireBlock(doc, blockId);
  if (parentId === blockId) throw new PageMutationValidationError("cannot move block under itself");
  let ancestor = parentId;
  while (ancestor !== null) {
    if (ancestor === blockId) {
      throw new PageMutationValidationError("cannot move block under its descendant");
    }
    ancestor = blockParent(requireBlock(doc, ancestor));
  }
  block.set("parentId", parentId);
  block.set("positionKey", positionAfter(doc, parentId, afterBlockId, blockId));
}

function positionAfter(
  doc: Y.Doc,
  parentId: string | null,
  afterBlockId: string | null,
  excludeId?: string,
): string {
  const siblings = [...doc.getMap<Y.Map<unknown>>(BLOCKS_MAP).values()]
    .filter((block) => blockParent(block) === parentId && block.get("id") !== excludeId)
    .sort((a, b) => blockPosition(a).localeCompare(blockPosition(b)) || blockId(a).localeCompare(blockId(b)));
  if (afterBlockId === excludeId) {
    throw new PageMutationValidationError("after block cannot be the moved block");
  }
  if (afterBlockId === null) return generateKeyBetween(null, siblings[0] ? blockPosition(siblings[0]) : null);
  const after = requireBlock(doc, afterBlockId);
  if (blockParent(after) !== parentId) {
    throw new PageMutationValidationError("after block must have the target parent");
  }
  const lower = blockPosition(after);
  const upper = siblings.map(blockPosition).find((position) => position > lower) ?? null;
  return generateKeyBetween(lower, upper);
}

function deleteSubtree(doc: Y.Doc, blockIdValue: string): void {
  requireBlock(doc, blockIdValue);
  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  const pending = [blockIdValue];
  const deleted = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (deleted.has(current)) continue;
    deleted.add(current);
    for (const block of blocks.values()) if (blockParent(block) === current) pending.push(blockId(block));
  }
  for (const id of deleted) blocks.delete(id);
}

function replaceBlocks(doc: Y.Doc, inputs: readonly PageYjsBlockInput[]): void {
  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP);
  blocks.clear();
  for (const input of inputs) {
    createBlock(doc, input.id, {
      blockType: input.type,
      text: input.text,
      properties: input.properties,
      collapsed: input.collapsed,
    }, input.parentId, null);
    requireBlock(doc, input.id).set("positionKey", input.positionKey);
  }
  readPageYDocReplica(requireString(doc.getMap(PAGE_META_MAP).get("id"), "page id"), doc);
}

function updateTypeAndProperties(
  block: Y.Map<unknown>,
  input: { blockType: string; properties: Record<string, unknown> },
): void {
  block.set("type", input.blockType);
  block.set("properties", yMapFromRecord(input.properties));
}

function setCheckState(block: Y.Map<unknown>, checked: boolean): void {
  if (block.get("type") !== "checklist") {
    throw new PageMutationValidationError("set_check_state requires a checklist block");
  }
  const properties = block.get("properties");
  if (!(properties instanceof Y.Map)) throw new PageMutationValidationError("block properties invalid");
  properties.set("checked", checked);
}

function replaceText(block: Y.Map<unknown>, value: string): void {
  const text = block.get("text");
  if (!(text instanceof Y.Text)) throw new PageMutationValidationError("block text invalid");
  text.delete(0, text.length);
  if (value) text.insert(0, value);
}

function requireBlock(doc: Y.Doc, id: string): Y.Map<unknown> {
  validateBoundary(id, "block id");
  const block = doc.getMap<Y.Map<unknown>>(BLOCKS_MAP).get(id);
  if (!(block instanceof Y.Map)) throw new PageMutationValidationError(`block not found in page: ${id}`);
  return block;
}

function blockId(block: Y.Map<unknown>): string {
  return requireString(block.get("id"), "block id");
}

function blockParent(block: Y.Map<unknown>): string | null {
  const value = block.get("parentId");
  if (value === null) return null;
  return requireString(value, "block parent id");
}

function blockPosition(block: Y.Map<unknown>): string {
  return requireString(block.get("positionKey"), "block position key");
}

function resolvePlacement(
  direct: string | null,
  temp: string | null | undefined,
  resolve: (value: string) => string,
): string | null {
  if (direct !== null && temp) {
    throw new PageMutationValidationError("direct id and temp id are mutually exclusive");
  }
  return temp ? resolve(temp) : direct === null ? null : resolve(direct);
}

function yMapFromRecord(input: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(input)) map.set(key, structuredClone(value));
  return map;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new PageMutationValidationError(`${label} must be a string`);
  return value;
}

function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

function commandPayload(command: PageMutationCommand): Record<string, unknown> {
  return structuredClone(command) as unknown as Record<string, unknown>;
}

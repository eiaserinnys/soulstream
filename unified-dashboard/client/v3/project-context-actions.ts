import { FolderMessageError } from "./folder-messages";
import type { BlockDto } from "../../../packages/page-model/src/types";
import type {
  PageApiClient,
  PageMutationResponse,
} from "@seosoyoung/soul-ui/page";
import type { PageStructureOperation } from "@seosoyoung/soul-ui/page/page-structure-operation";
import { operationId } from "./folder-star-actions";

export type ContextOperationIdFactory = (prefix: string) => string;

export async function saveProjectGuidance(
  api: PageApiClient,
  pageId: string,
  input: { blockId: string | null; text: string },
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  const text = input.text.trim();
  if (!text) throw new FolderMessageError("folders.errors.requireGuidance");
  return await mutate(api, pageId, idFactory, "v3 project guidance save", (blocks) => (
    input.blockId
      ? [{ op: "update_block_text", block_id: input.blockId, text }]
      : [createBlock(blocks, idFactory("guidance-block"), "guidance", text, {
        enabled: true,
        scope: "project",
      })]
  ));
}

export async function savePageAtomReference(
  api: PageApiClient,
  pageId: string,
  input: {
    blockId: string | null;
    nodeId: string;
    nodeTitle: string;
    depth: number;
    titlesOnly: boolean;
    limit?: number | null;
    mode?: "full" | "index" | "titles";
    instance?: string;
  },
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  return await mutate(api, pageId, idFactory, "v3 page atom reference save", (blocks) => {
    const properties = projectAtomProperties(input, blocks);
    return input.blockId
      ? [{ op: "update_block_type_and_properties", block_id: input.blockId, block_type: "atom_ref", properties }]
      : [createBlock(blocks, idFactory("atom-reference-block"), "atom_ref", "", properties)];
  });
}

export const saveProjectAtomReference = savePageAtomReference;

export async function saveProjectSessionDefaults(
  api: PageApiClient,
  pageId: string,
  input: {
    blockId: string | null;
    agentId: string | null;
    nodeId: string | null;
    modelPreset: string | null;
  },
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  const properties = {
    agentId: input.agentId?.trim() || null,
    nodeId: input.nodeId?.trim() || null,
    ...(input.modelPreset?.trim()
      ? { modelPreset: input.modelPreset.trim() }
      : {}),
    scope: "project",
  };
  return await mutate(api, pageId, idFactory, "v3 project session defaults save", (blocks) => (
    input.blockId
      ? [{
        op: "update_block_type_and_properties",
        block_id: input.blockId,
        block_type: "session_defaults",
        properties,
      }]
      : [createBlock(blocks, idFactory("session-defaults-block"), "session_defaults", "", properties)]
  ));
}

export async function deletePageContextBlock(
  api: PageApiClient,
  pageId: string,
  blockId: string,
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  return await mutate(api, pageId, idFactory, "v3 page context delete", () => ([{
    op: "delete_block_subtree",
    block_id: blockId,
  }]));
}

export const deleteProjectContextBlock = deletePageContextBlock;

async function mutate(
  api: PageApiClient,
  pageId: string,
  idFactory: ContextOperationIdFactory,
  reason: string,
  buildOperations: (blocks: readonly BlockDto[]) => PageStructureOperation[],
): Promise<PageMutationResponse> {
  const current = await api.getPage(pageId);
  return await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeStateVector(current.state_vector),
    idempotencyKey: `v3-project-context:browser:${idFactory("request")}`,
    reason,
    operations: buildOperations(current.blocks),
  });
}

function createBlock(
  blocks: readonly BlockDto[],
  tempId: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown>,
): PageStructureOperation {
  return {
    op: "create_block",
    temp_id: tempId,
    parent_id: null,
    after_block_id: blocks.filter((block) => block.parent_id === null).at(-1)?.id ?? null,
    block_type: blockType,
    text,
    properties,
    collapsed: false,
  };
}

export function decodeStateVector(value: string): Uint8Array {
  if (typeof globalThis.atob !== "function") throw new FolderMessageError("folders.errors.decodeState");
  return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
}

export function projectAtomProperties(input: Parameters<typeof savePageAtomReference>[2], blocks: readonly BlockDto[]): Record<string, unknown> {
  const nodeId = input.nodeId.trim();
  if (!nodeId) throw new FolderMessageError("folders.errors.chooseAtom");
  if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 5) {
    throw new FolderMessageError("folders.errors.atomDepth");
  }
  if (input.limit != null && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new FolderMessageError("folders.errors.atomRecentCount");
  }
    const previous = input.blockId
      ? blocks.find((block) => block.id === input.blockId)?.properties ?? {}
      : {};
    const properties: Record<string, unknown> = {
      ...previous,
      instance: input.instance?.trim() || "atom",
      nodeId,
      nodeTitle: input.nodeTitle.trim() || nodeId,
      depth: input.depth,
      titlesOnly: input.titlesOnly,
      ...(input.limit != null ? { limit: input.limit } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
    };
    if (input.limit == null) delete properties.limit;
    if (input.mode === undefined) delete properties.mode;
    return properties;
}

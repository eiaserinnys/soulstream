import type {
  BlockDto,
  PageApiClient,
  PageMutationResponse,
  PageStructureOperation,
} from "@seosoyoung/soul-ui/page";

export type ContextOperationIdFactory = (prefix: string) => string;

export async function saveProjectGuidance(
  api: PageApiClient,
  pageId: string,
  input: { blockId: string | null; text: string },
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  const text = input.text.trim();
  if (!text) throw new Error("프로젝트 지침을 입력해야 합니다");
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
    instance?: string;
  },
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  const nodeId = input.nodeId.trim();
  if (!nodeId) throw new Error("atom 노드를 선택해야 합니다");
  if (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 5) {
    throw new Error("atom 깊이는 1~5여야 합니다");
  }
  return await mutate(api, pageId, idFactory, "v3 page atom reference save", (blocks) => {
    const previous = input.blockId
      ? blocks.find((block) => block.id === input.blockId)?.properties ?? {}
      : {};
    const properties = {
      ...previous,
      instance: input.instance?.trim() || "atom",
      nodeId,
      nodeTitle: input.nodeTitle.trim() || nodeId,
      depth: input.depth,
      titlesOnly: input.titlesOnly,
    };
    return input.blockId
      ? [{
        op: "update_block_type_and_properties",
        block_id: input.blockId,
        block_type: "atom_ref",
        properties,
      }]
      : [createBlock(blocks, idFactory("atom-reference-block"), "atom_ref", "", properties)];
  });
}

export const saveProjectAtomReference = savePageAtomReference;

export async function saveProjectSessionDefaults(
  api: PageApiClient,
  pageId: string,
  input: { blockId: string | null; agentId: string | null; nodeId: string | null },
  idFactory: ContextOperationIdFactory = operationId,
): Promise<PageMutationResponse> {
  const properties = {
    agentId: input.agentId?.trim() || null,
    nodeId: input.nodeId?.trim() || null,
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

function decodeStateVector(value: string): Uint8Array {
  if (typeof globalThis.atob !== "function") throw new Error("state vector를 디코딩할 수 없습니다");
  return Uint8Array.from(globalThis.atob(value), (character) => character.charCodeAt(0));
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

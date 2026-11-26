import type { PageDto } from "../../../packages/page-model/src/types";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import type { PageStructureOperation } from "@seosoyoung/soul-ui/page/page-structure-operation";

import { buildDescriptionMutation } from "./folder-workspace-run-model";
import type { SessionPageAnchor } from "./session-succession-model";

export interface PageSessionDefaults {
  agentId: string | null;
  nodeId: string | null;
  modelPreset?: string | null;
  sourcePageId: string;
  sourceBlockId: string;
}

export type FolderSessionDefaultsIdFactory = (prefix: string) => string;

export async function renameFolderPageTitle(
  api: PageApiClient,
  pageId: string,
  titleValue: string,
  idFactory: () => string = () => `v3-folder-title-${crypto.randomUUID()}`,
): Promise<PageDto> {
  const title = titleValue.trim();
  if (!title) throw new Error("폴더 제목을 입력해야 합니다");
  const current = await api.getPage(pageId);
  if (title === current.page.title) return current.page;
  const result = await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: idFactory(),
    reason: "v3 folder page title rename",
    operations: [{ op: "rename_page", title }],
  });
  return result.page;
}

export async function fetchPageSessionDefaults(
  pageId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<PageSessionDefaults | null> {
  const response = await fetchImplementation(
    `/api/pages/${encodeURIComponent(pageId)}/session-defaults`,
    { credentials: "same-origin", headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`실행 기본값을 불러오지 못했습니다 (${response.status})`);
  return await response.json() as PageSessionDefaults | null;
}

export async function saveFolderSessionDefaults(
  api: PageApiClient,
  pageId: string,
  input: {
    blockId: string | null;
    agentId: string | null;
    nodeId: string | null;
    modelPreset: string | null;
  },
  idFactory: FolderSessionDefaultsIdFactory = (prefix) => `${prefix}-${crypto.randomUUID()}`,
): Promise<{ blocks: Awaited<ReturnType<PageApiClient["getPage"]>>["blocks"] }> {
  const properties = {
    agentId: input.agentId?.trim() || null,
    nodeId: input.nodeId?.trim() || null,
    ...(input.modelPreset?.trim()
      ? { modelPreset: input.modelPreset.trim() }
      : {}),
    scope: "session",
  };
  if (!properties.agentId && !properties.nodeId) {
    throw new Error("에이전트 또는 노드를 선택해야 합니다");
  }
  const current = await api.getPage(pageId);
  const operation: PageStructureOperation = input.blockId
    ? {
        op: "update_block_type_and_properties",
        block_id: input.blockId,
        block_type: "session_defaults",
        properties,
      }
    : {
        op: "create_block",
        temp_id: idFactory("session-defaults-block"),
        parent_id: null,
        after_block_id: [...current.blocks].reverse()
          .find((block) => block.parent_id === null)?.id ?? null,
        block_type: "session_defaults",
        text: "",
        properties,
        collapsed: false,
      };
  const result = await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: idFactory("session-defaults-save"),
    reason: "v3 folder session defaults save",
    operations: [operation],
  });
  return { blocks: result.blocks };
}

export async function saveFolderDescription(
  api: PageApiClient,
  pageId: string,
  markdown: string,
): Promise<void> {
  const current = await api.getPage(pageId);
  let tempSequence = 0;
  const mutation = buildDescriptionMutation({
    page: current.page,
    blocks: current.blocks,
    markdown,
    createTempId: () => `v3-description-${++tempSequence}-${crypto.randomUUID()}`,
  });
  if (mutation.operations.length === 0) return;
  await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: `v3-description-${crypto.randomUUID()}`,
    reason: "v3 folder description edit",
    operations: mutation.operations,
  });
}

export async function createFolderPageAnchor(
  api: PageApiClient,
  pageId: string,
): Promise<SessionPageAnchor> {
  const current = await api.getPage(pageId);
  const tempId = `v3-session-anchor-${crypto.randomUUID()}`;
  const result = await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: `v3-session-anchor-create-${crypto.randomUUID()}`,
    reason: "v3 successor session page anchor",
    operations: [{
      op: "create_block",
      temp_id: tempId,
      parent_id: null,
      after_block_id: [...current.blocks].reverse().find((block) => block.parent_id === null)?.id ?? null,
      block_type: "paragraph",
      text: "",
      properties: {},
      collapsed: false,
    }],
  });
  const blockId = result.temp_id_mapping[tempId];
  if (!blockId) throw new Error("새 세션 page anchor 블록 ID를 받지 못했습니다");
  return { pageId, blockId, expectedVersion: result.page.version };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

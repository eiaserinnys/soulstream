import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  buildContextBlockOperations,
  type ContextPickerSelection,
} from "./context-picker-model";
import { buildDescriptionMutation } from "./task-workspace-model";
import type { SessionPageAnchor } from "./session-succession-model";

export interface PageSessionDefaults {
  agentId: string | null;
  nodeId: string | null;
  sourcePageId: string;
  sourceBlockId: string;
}

export async function renameTaskTitle(
  api: PageApiClient,
  pageId: string,
  titleValue: string,
  idFactory: () => string = () => `v3-task-title-${crypto.randomUUID()}`,
): Promise<PageDto> {
  const title = titleValue.trim();
  if (!title) throw new Error("업무 제목을 입력해야 합니다");
  const current = await api.getPage(pageId);
  if (title === current.page.title) return current.page;
  const result = await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: idFactory(),
    reason: "v3 task identity title rename",
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

export async function saveTaskDescription(
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
    reason: "v3 task description edit",
    operations: mutation.operations,
  });
}

export async function addTaskContextBlocks(
  api: PageApiClient,
  pageId: string,
  selections: readonly ContextPickerSelection[],
): Promise<{ blocks: Awaited<ReturnType<PageApiClient["getPage"]>>["blocks"] }> {
  const current = await api.getPage(pageId);
  const operations = buildContextBlockOperations({
    selections,
    afterBlockId: [...current.blocks].reverse().find((block) => block.parent_id === null)?.id ?? null,
    createTempId: () => `v3-context-${crypto.randomUUID()}`,
  });
  if (operations.length === 0) {
    return { blocks: current.blocks };
  }
  const result = await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: `v3-context-apply-${crypto.randomUUID()}`,
    reason: "v3 task context picker apply",
    operations,
  });
  return { blocks: result.blocks };
}

export async function createTaskPageAnchor(
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

export async function promoteMountedDocument(
  api: PageApiClient,
  taskPageId: string,
  projectPageId: string,
  mountBlockId: string,
): Promise<void> {
  const [task, project] = await Promise.all([
    api.getPage(taskPageId),
    api.getPage(projectPageId),
  ]);
  if (!task.blocks.some((block) => block.id === mountBlockId)) {
    throw new Error("승격할 문서 마운트를 찾을 수 없습니다");
  }
  const lastProjectRoot = [...project.blocks]
    .reverse()
    .find((block) => block.parent_id === null)?.id ?? null;
  // This uses the same transferBlocks primitive as usePageBlockTransfers.extractExisting.
  // extractExisting itself always adds a source mount; promotion must remove the task mount
  // instead of replacing it with a mount back to the project page.
  await api.transferBlocks({
    source: {
      pageId: taskPageId,
      expectedVersion: task.page.version,
      expectedStateVector: decodeBase64(task.state_vector),
      blockIds: [mountBlockId],
    },
    target: {
      kind: "existing",
      pageId: projectPageId,
      expectedVersion: project.page.version,
      expectedStateVector: decodeBase64(project.state_vector),
      parentId: null,
      afterBlockId: lastProjectRoot,
    },
    idempotencyKey: `v3-promote-document-${crypto.randomUUID()}`,
    reason: "promote task document to project",
  });
}

export async function unmountTaskDocument(
  api: PageApiClient,
  taskPageId: string,
  mountBlockId: string,
  idFactory: () => string = () => `v3-document-unmount-${crypto.randomUUID()}`,
): Promise<void> {
  const current = await api.getPage(taskPageId);
  if (!current.blocks.some((block) => block.id === mountBlockId)) {
    throw new Error("해제할 문서 마운트를 찾을 수 없습니다");
  }
  await api.applyOperations(taskPageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeBase64(current.state_vector),
    idempotencyKey: idFactory(),
    reason: "v3 task document unmount",
    operations: [{ op: "delete_block_subtree", block_id: mountBlockId }],
  });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { buildDescriptionMutation } from "./task-workspace-model";

export interface PageSessionDefaults {
  agentId: string | null;
  nodeId: string | null;
  sourcePageId: string;
  sourceBlockId: string;
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

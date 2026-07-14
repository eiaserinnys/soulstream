import type {
  BlockDto,
  PageApiClient,
  PageDto,
} from "@seosoyoung/soul-ui/page";

export type ProjectOperationIdFactory = (prefix: string) => string;

export async function renameProjectPage(
  api: PageApiClient,
  pageId: string,
  titleValue: string,
  idFactory: ProjectOperationIdFactory = operationId,
): Promise<PageDto> {
  const title = titleValue.trim();
  if (!title) throw new Error("프로젝트 제목을 입력해야 합니다");
  const current = await api.getPage(pageId);
  if (current.page.title === title) return current.page;
  const updated = await api.applyOperations(pageId, {
    expectedVersion: current.page.version,
    expectedStateVector: decodeStateVector(current.state_vector),
    idempotencyKey: idFactory("project-rename"),
    reason: "v3 planner project rename",
    operations: [{ op: "rename_page", title }],
  });
  return updated.page;
}

export async function setProjectStarred(
  api: PageApiClient,
  pageId: string,
  starred: boolean,
  idFactory: ProjectOperationIdFactory = operationId,
): Promise<PageDto> {
  const current = await api.getPage(pageId);
  const updated = await api.setStarred(pageId, {
    starred,
    expectedVersion: current.page.version,
    idempotencyKey: idFactory("project-star"),
    reason: "v3 planner project star toggle",
  });
  return updated.page;
}

export async function createStarredProject(
  api: PageApiClient,
  input: { title: string; date: string },
  idFactory: ProjectOperationIdFactory = operationId,
): Promise<PageDto> {
  const title = input.title.trim();
  if (!title) throw new Error("프로젝트 제목을 입력해야 합니다");

  const daily = await api.getDailyPage(input.date);
  const source = await api.getPage(daily.page.id);
  const seedTempId = idFactory("project-seed");
  const seeded = await api.applyOperations(source.page.id, {
    expectedVersion: source.page.version,
    expectedStateVector: decodeStateVector(source.state_vector),
    idempotencyKey: idFactory("project-seed-create"),
    reason: "v3 planner standalone project seed",
    operations: [{
      op: "create_block",
      temp_id: seedTempId,
      parent_id: null,
      after_block_id: lastRootBlockId(source.blocks),
      block_type: "paragraph",
      text: "",
      properties: {},
      collapsed: false,
    }],
  });
  const seedBlockId = seeded.temp_id_mapping[seedTempId];
  if (!seedBlockId) throw new Error("새 프로젝트 seed 블록 ID를 받지 못했습니다");

  const currentSource = await api.getPage(source.page.id);
  const created = await api.transferBlocks({
    source: {
      pageId: currentSource.page.id,
      expectedVersion: currentSource.page.version,
      expectedStateVector: decodeStateVector(currentSource.state_vector),
      blockIds: [seedBlockId],
    },
    target: {
      kind: "new",
      pageId: idFactory("project"),
      title,
    },
    idempotencyKey: idFactory("project-create"),
    reason: "v3 planner standalone project creation",
  });
  if (!created.target_created) throw new Error("새 프로젝트가 생성되지 않았습니다");

  const starred = await api.setStarred(created.target.page.id, {
    starred: true,
    expectedVersion: created.target.page.version,
    idempotencyKey: idFactory("project-star"),
    reason: "v3 planner project creation",
  });
  return starred.page;
}

function lastRootBlockId(blocks: readonly BlockDto[]): string | null {
  return blocks.filter((block) => block.parent_id === null).at(-1)?.id ?? null;
}

function decodeStateVector(value: string): Uint8Array {
  if (typeof globalThis.atob !== "function") {
    throw new Error("브라우저가 페이지 state vector 디코딩을 지원하지 않습니다");
  }
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

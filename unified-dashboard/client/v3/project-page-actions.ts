import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { BlockDto, PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import { classifyMountedPage } from "./planner-model";

export type ProjectOperationIdFactory = (prefix: string) => string;

export function normalizeProjectTitle(value: string): string {
  return value
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ko-KR");
}

export async function findExistingProjectPage(
  api: PageApiClient,
  folder: CatalogFolder,
  knownPages: readonly PageDto[],
): Promise<PageDto | null> {
  const explicit = knownPages.find((page) => (
    page.metadata.folderId === folder.id || page.metadata.folder_id === folder.id
  ));
  if (explicit) return explicit;

  const title = normalizeProjectTitle(folder.name);
  const known = knownPages.find((page) => isPageCandidate(page, title));
  if (known) {
    const snapshot = await api.getPage(known.id);
    if (classifyMountedPage(snapshot.blocks).kind === "document") return snapshot.page;
  }

  const queries = [...new Set([folder.name.trim(), title].filter(Boolean))];
  const searches = await Promise.all(queries.map(async (query) => await api.searchPages(query, 50)));
  const pageIds = [...new Set(searches.flatMap((result) => (
    result.items.map((item) => item.pageId)
  )))];
  for (const pageId of pageIds) {
    const snapshot = await api.getPage(pageId);
    if (!isPageCandidate(snapshot.page, title)) continue;
    if (classifyMountedPage(snapshot.blocks).kind === "document") return snapshot.page;
  }
  return null;
}

export async function createProjectPage(
  api: PageApiClient,
  input: { title: string; folderId: string },
  idFactory: ProjectOperationIdFactory = operationId,
): Promise<PageDto> {
  const title = input.title.trim();
  if (!title) throw new Error("프로젝트 제목을 입력해야 합니다");
  const daily = await api.getDailyPage();
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
      folderId: input.folderId,
    },
    idempotencyKey: idFactory("project-create"),
    reason: "v3 planner standalone project creation",
  });
  if (!created.target_created) throw new Error("새 프로젝트가 생성되지 않았습니다");
  return created.target.page;
}

export async function resolveOrCreateProjectPage(
  api: PageApiClient,
  folder: CatalogFolder,
  knownPages: readonly PageDto[],
): Promise<PageDto> {
  return await findExistingProjectPage(api, folder, knownPages)
    ?? await createProjectPage(api, { title: folder.name, folderId: folder.id });
}

function isPageCandidate(page: PageDto, normalizedTitle: string): boolean {
  return !page.archived
    && page.daily_date === null
    && normalizeProjectTitle(page.title) === normalizedTitle;
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

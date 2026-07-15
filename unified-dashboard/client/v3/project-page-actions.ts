import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

export async function resolveProjectPage(
  api: PageApiClient,
  folder: CatalogFolder,
  knownPages: readonly PageDto[],
): Promise<PageDto> {
  const pageId = folder.projectPageId;
  if (!pageId) throw new Error(`프로젝트 페이지 바인딩이 없습니다: ${folder.id}`);
  if (pageId !== folder.id) {
    const legacy = knownPages.find((page) => page.id === pageId);
    return legacy ?? (await api.getPage(pageId)).page;
  }
  return knownPages.find((page) => page.id === pageId)
    ?? (await api.getPage(pageId)).page;
}

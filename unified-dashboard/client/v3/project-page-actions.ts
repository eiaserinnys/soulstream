import type { CatalogFolder } from "@seosoyoung/soul-ui";
import type { PageDto } from "../../../packages/page-model/src/types";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

export async function resolveProjectPage(
  api: PageApiClient,
  folder: CatalogFolder,
  knownPages: readonly PageDto[],
): Promise<PageDto | null> {
  const pageId = folder.projectPageId;
  if (!pageId) return null;
  return knownPages.find((page) => page.id === pageId)
    ?? (await api.getPage(pageId)).page;
}

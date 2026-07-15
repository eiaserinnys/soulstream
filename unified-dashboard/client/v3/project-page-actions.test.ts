import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import { resolveProjectPage } from "./project-page-actions";

describe("project page identity", () => {
  it("opens the bound same-ID page without search or lazy creation", async () => {
    const bound = page("folder-project", "프로젝트");
    const api = { getPage: vi.fn() } as unknown as PageApiClient;
    const folder = {
      id: bound.id,
      name: bound.title,
      sortOrder: 0,
      parentFolderId: null,
      projectPageId: bound.id,
    } satisfies CatalogFolder;

    await expect(resolveProjectPage(api, folder, [bound])).resolves.toEqual(bound);
    expect(api.getPage).not.toHaveBeenCalled();
  });

  it("fetches a stale-list binding by ID and treats legacy NULL as unconnected", async () => {
    const bound = page("folder-project", "프로젝트");
    const api = {
      getPage: vi.fn(async () => ({ page: bound, blocks: [], state_vector: "AA==" })),
    } as unknown as PageApiClient;

    await expect(resolveProjectPage(api, {
      id: bound.id,
      name: bound.title,
      sortOrder: 0,
      projectPageId: bound.id,
    }, [])).resolves.toEqual(bound);
    await expect(resolveProjectPage(api, {
      id: "legacy",
      name: "레거시",
      sortOrder: 0,
      projectPageId: null,
    }, [])).resolves.toBeNull();
  });
});

function page(id: string, title: string): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

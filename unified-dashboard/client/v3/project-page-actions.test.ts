import { describe, expect, it, vi } from "vitest";
import type {
  PageApiClient,
  PageDto,
  PageMutationResponse,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";
import type { CatalogFolder } from "@seosoyoung/soul-ui";

import {
  createProjectPage,
  findExistingProjectPage,
  normalizeProjectTitle,
} from "./project-page-actions";

describe("project page bridge", () => {
  it("normalizes leading emoji so ✨ 소울스트림 resolves to 소울스트림", () => {
    expect(normalizeProjectTitle("✨ 소울스트림")).toBe("소울스트림");
    expect(normalizeProjectTitle("  소울스트림  ")).toBe("소울스트림");
  });

  it("prefers explicit folder metadata over title matches", async () => {
    const explicit = page("explicit", "다른 제목", { folderId: "folder-1" });
    const api = { searchPages: vi.fn(), getPage: vi.fn() } as unknown as PageApiClient;

    await expect(findExistingProjectPage(api, folder("folder-1", "프로젝트"), [explicit]))
      .resolves.toEqual(explicit);
    expect(api.searchPages).not.toHaveBeenCalled();
  });

  it("reuses an emoji-normalized non-task page instead of creating a duplicate", async () => {
    const existing = page("soulstream-page", "소울스트림");
    const api = {
      searchPages: vi.fn(async () => ({ items: [{ pageId: existing.id, title: existing.title }] })),
      getPage: vi.fn(async () => pageRead(existing, [block("paragraph", {})])),
    } as unknown as PageApiClient;

    await expect(findExistingProjectPage(api, folder("folder-soul", "✨ 소울스트림"), []))
      .resolves.toEqual(existing);
  });

  it("creates an unstarred project page through the existing block-transfer path", async () => {
    const daily = page("daily", "2026-07-15");
    const source = pageRead(daily, []);
    const created = page("created", "새 프로젝트");
    const api = {
      getDailyPage: vi.fn(async () => ({ page: daily, created: false })),
      getPage: vi.fn()
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce({ ...source, page: { ...daily, version: 2 } }),
      applyOperations: vi.fn(async () => ({
        ...mutation({ ...daily, version: 2 }),
        temp_id_mapping: { "project-seed-id": "seed-block" },
      })),
      transferBlocks: vi.fn(async () => ({
        source: mutation({ ...daily, version: 3 }),
        target: mutation(created),
        target_created: true,
      })),
      setStarred: vi.fn(),
    } as unknown as PageApiClient;

    await expect(createProjectPage(
      api,
      { title: "새 프로젝트", folderId: "folder-project" },
      () => "project-seed-id",
    ))
      .resolves.toEqual(created);
    expect(api.setStarred).not.toHaveBeenCalled();
    expect(api.transferBlocks).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: "new",
        pageId: "project-seed-id",
        title: "새 프로젝트",
        folderId: "folder-project",
      },
    }));
  });
});

function folder(id: string, name: string): CatalogFolder {
  return { id, name, sortOrder: 0, parentFolderId: null };
}

function page(id: string, title: string, metadata: Record<string, unknown> = {}): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata,
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

function pageRead(value: PageDto, blocks: ReturnType<typeof block>[] = []): PageReadResponse {
  return { page: value, blocks, state_vector: "AA==" };
}

function block(blockType: string, properties: Record<string, unknown>) {
  return {
    id: `block-${blockType}`,
    page_id: "page",
    parent_id: null,
    position_key: "a0",
    block_type: blockType,
    text: "",
    properties,
    collapsed: false,
  };
}

function mutation(value: PageDto): PageMutationResponse {
  return { page: value, blocks: [], operation: { id: "op" }, temp_id_mapping: {} };
}

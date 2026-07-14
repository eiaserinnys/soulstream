import { describe, expect, it, vi } from "vitest";
import {
  createPageApiClient,
  type PageApiClient,
  type PageDto,
  type PageMutationResponse,
  type PageReadResponse,
} from "@seosoyoung/soul-ui/page";

import {
  createStarredProject,
  renameProjectPage,
  setProjectStarred,
} from "./project-star-actions";
import {
  applyProjectStarChanges,
  resolveSelectedProject,
  type ProjectStarChange,
} from "./project-star-store";

describe("project star actions", () => {
  it("reads the current page version before sending the starred CAS mutation", async () => {
    const current = pageRead(page("project-1", "Project", 7));
    const updated = mutation(page("project-1", "Project", 8, { starred: false }));
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(current))
      .mockResolvedValueOnce(jsonResponse(updated));
    const api = createPageApiClient({ fetch });

    await expect(setProjectStarred(api, "project-1", false, () => "star-cas-1"))
      .resolves.toEqual(updated.page);

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/pages/project-1", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/pages/project-1/starred", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        starred: false,
        expected_version: 7,
        idempotency_key: "star-cas-1",
        reason: "v3 planner project star toggle",
      }),
    }));
  });

  it("creates a standalone page and stars it with the creation response version", async () => {
    const calls: string[] = [];
    const daily = page("daily-1", "2026-07-14", 3);
    const sourceBefore = pageRead(daily, "AA==");
    const sourceAfterSeed = pageRead(page(daily.id, daily.title, 4), "AQ==");
    const created = page("project-created", "새 프로젝트", 9);
    const starred = page("project-created", "새 프로젝트", 10, { starred: true });
    const api = {
      getDailyPage: vi.fn(async () => {
        calls.push("daily");
        return { page: daily, created: false };
      }),
      getPage: vi.fn()
        .mockImplementationOnce(async () => {
          calls.push("source-before");
          return sourceBefore;
        })
        .mockImplementationOnce(async () => {
          calls.push("source-after");
          return sourceAfterSeed;
        }),
      applyOperations: vi.fn(async () => {
        calls.push("seed");
        return {
          ...mutation(sourceAfterSeed.page),
          temp_id_mapping: { "project-seed-id": "seed-block" },
        };
      }),
      transferBlocks: vi.fn(async () => {
        calls.push("create-page");
        return {
          source: mutation(page(daily.id, daily.title, 5)),
          target: mutation(created),
          target_created: true,
        };
      }),
      setStarred: vi.fn(async () => {
        calls.push("star-created");
        return mutation(starred);
      }),
    } as unknown as PageApiClient;

    await expect(createStarredProject(api, {
      title: "새 프로젝트",
      date: "2026-07-14",
    }, (prefix) => `${prefix}-id`)).resolves.toEqual(starred);

    expect(calls).toEqual([
      "daily",
      "source-before",
      "seed",
      "source-after",
      "create-page",
      "star-created",
    ]);
    expect(api.transferBlocks).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ blockIds: ["seed-block"] }),
      target: {
        kind: "new",
        pageId: "project-id",
        title: "새 프로젝트",
      },
    }));
    expect(api.setStarred).toHaveBeenCalledWith("project-created", {
      starred: true,
      expectedVersion: 9,
      idempotencyKey: "project-star-id",
      reason: "v3 planner project creation",
    });
  });

  it("renames a project through the page operation CAS contract", async () => {
    const current = pageRead(page("project-1", "Before", 7), "AQ==");
    const updated = mutation(page("project-1", "After", 8));
    const api = {
      getPage: vi.fn(async () => current),
      applyOperations: vi.fn(async () => updated),
    } as unknown as PageApiClient;

    await expect(renameProjectPage(api, "project-1", "  After  ", () => "rename-1"))
      .resolves.toEqual(updated.page);

    expect(api.applyOperations).toHaveBeenCalledWith("project-1", {
      expectedVersion: 7,
      expectedStateVector: new Uint8Array([1]),
      idempotencyKey: "rename-1",
      reason: "v3 planner project rename",
      operations: [{ op: "rename_page", title: "After" }],
    });
  });
});

describe("project star navigation projection", () => {
  it("removes a project immediately when its star is cleared", () => {
    const first = page("project-1", "First", 1, { starred: true });
    const second = page("project-2", "Second", 1, { starred: true });
    const changes: ProjectStarChange[] = [{ page: first, starred: false }];

    expect(applyProjectStarChanges([first, second], changes)).toEqual([second]);
    expect(resolveSelectedProject([first, second], changes, first.id)).toEqual(first);
  });
});

function page(
  id: string,
  title: string,
  version: number,
  metadata: Record<string, unknown> = {},
): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version,
    archived: false,
    metadata,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}

function pageRead(value: PageDto, stateVector = "AA=="): PageReadResponse {
  return { page: value, blocks: [], state_vector: stateVector };
}

function mutation(value: PageDto): PageMutationResponse {
  return {
    page: value,
    blocks: [],
    operation: { id: `operation-${value.id}` },
    temp_id_mapping: {},
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

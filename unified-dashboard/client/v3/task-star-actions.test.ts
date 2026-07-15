import { describe, expect, it, vi } from "vitest";
import type {
  PageApiClient,
  PageDto,
  PageMutationResponse,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";

import { setTaskStarred } from "./task-star-actions";

describe("task star actions", () => {
  it("reads the current task page version before sending the starred CAS mutation", async () => {
    const current = pageRead(page("task-1", 7));
    const updated = mutation(page("task-1", 8, { starred: true }));
    const api = {
      getPage: vi.fn(async () => current),
      setStarred: vi.fn(async () => updated),
    } as unknown as PageApiClient;

    await expect(setTaskStarred(api, "task-1", true, () => "task-star-1"))
      .resolves.toEqual(updated.page);

    expect(api.setStarred).toHaveBeenCalledWith("task-1", {
      starred: true,
      expectedVersion: 7,
      idempotencyKey: "task-star-1",
      reason: "v3 planner task star toggle",
    });
  });
});

function page(id: string, version: number, metadata: Record<string, unknown> = {}): PageDto {
  return {
    id,
    title: id,
    daily_date: null,
    version,
    archived: false,
    metadata,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}

function pageRead(value: PageDto): PageReadResponse {
  return { page: value, blocks: [], state_vector: "AA==" };
}

function mutation(value: PageDto): PageMutationResponse {
  return {
    page: value,
    blocks: [],
    operation: { id: `operation-${value.id}` },
    temp_id_mapping: {},
  };
}

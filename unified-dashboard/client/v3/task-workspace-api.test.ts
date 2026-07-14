import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import { unmountTaskDocument } from "./task-workspace-api";

describe("unmountTaskDocument", () => {
  it("deletes the mounted document block through the page CAS contract", async () => {
    const taskPage = page("task-a", "업무 A", 5);
    const api = {
      getPage: vi.fn(async () => ({
        page: taskPage,
        state_vector: "AQ==",
        blocks: [{
          id: "mount-doc",
          page_id: taskPage.id,
          parent_id: null,
          position_key: "A",
          block_type: "paragraph",
          text: "[[문서 A]]",
          properties: {},
          collapsed: false,
        }],
      })),
      applyOperations: vi.fn(async () => ({
        page: { ...taskPage, version: 6 },
        blocks: [],
        operation: { id: "delete-mount" },
        temp_id_mapping: {},
      })),
    } as unknown as PageApiClient;

    await unmountTaskDocument(api, taskPage.id, "mount-doc", () => "unmount-1");

    expect(api.applyOperations).toHaveBeenCalledWith(taskPage.id, {
      expectedVersion: 5,
      expectedStateVector: new Uint8Array([1]),
      idempotencyKey: "unmount-1",
      reason: "v3 task document unmount",
      operations: [{ op: "delete_block_subtree", block_id: "mount-doc" }],
    });
  });
});

function page(id: string, title: string, version: number): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version,
    archived: false,
    metadata: {},
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}

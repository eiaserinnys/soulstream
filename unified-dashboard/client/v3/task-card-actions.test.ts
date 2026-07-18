import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto, PageReadResponse } from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";
import { completePlannerTask, togglePlannerTaskToday } from "./task-card-actions";

describe("planner task card actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses the ritual mount path when the task is absent from today", async () => {
    const daily = page("daily-today", "2026-07-14", 4);
    const api = {
      getDailyPage: vi.fn(async () => ({ page: daily, created: false })),
      getPage: vi.fn(async () => pageRead(daily, [])),
      applyOperations: vi.fn(async () => ({
        page: { ...daily, version: 5 },
        blocks: [],
        operation: { id: "mount" },
        temp_id_mapping: {},
      })),
    } as unknown as PageApiClient;

    await expect(togglePlannerTaskToday(task(), api, () => "toggle-id"))
      .resolves.toBe("added");

    expect(api.applyOperations).toHaveBeenCalledWith("daily-today", expect.objectContaining({
      reason: "v3 planner append block",
      operations: [expect.objectContaining({ text: "[[업무 A]]" })],
    }));
  });

  it("removes the existing daily mount with the page CAS contract", async () => {
    const daily = page("daily-today", "2026-07-14", 4);
    const api = {
      getDailyPage: vi.fn(async () => ({ page: daily, created: false })),
      getPage: vi.fn(async () => pageRead(daily, [{
        id: "mount-task-a",
        page_id: daily.id,
        parent_id: null,
        position_key: "A",
        block_type: "paragraph",
        text: "[[업무 A]]",
        properties: {},
        collapsed: false,
      }])),
      applyOperations: vi.fn(async () => ({
        page: { ...daily, version: 5 },
        blocks: [],
        operation: { id: "unmount" },
        temp_id_mapping: {},
      })),
    } as unknown as PageApiClient;

    await expect(togglePlannerTaskToday(task(), api, () => "toggle-id"))
      .resolves.toBe("removed");

    expect(api.applyOperations).toHaveBeenCalledWith("daily-today", {
      expectedVersion: 4,
      expectedStateVector: new Uint8Array([0]),
      idempotencyKey: "toggle-id",
      reason: "v3 planner daily task unmount",
      operations: [{ op: "delete_block_subtree", block_id: "mount-task-a" }],
    });
  });

  it("reuses the ritual completion path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await completePlannerTask(task());

    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/rb-task-a/status", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"status":"completed"'),
    }));
  });
});

function task(): PlannerTask {
  return {
    page: page("task-a", "업무 A", 2),
    blocks: [],
    stateVector: "AA==",
    taskId: "rb-task-a",
    task: {
      task: {
        id: "rb-task-a",
        board_item_id: "task:rb-task-a",
        title: "업무 A",
        status: "open",
        archived: false,
        version: 7,
        created_session_id: null,
        created_event_id: null,
        created_at: "2026-07-14T00:00:00.000Z",
        updated_at: "2026-07-14T00:00:00.000Z",
      },
      sections: [],
      items: [],
    },
    status: "open",
    assignee: "로젤린",
    contextCount: 0,
    progress: null,
    projectPageId: "project-a",
    sessionIds: [],
    mountedDocuments: [],
  };
}

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

function pageRead(value: PageDto, blocks: PageReadResponse["blocks"]): PageReadResponse {
  return { page: value, blocks, state_vector: "AA==" };
}

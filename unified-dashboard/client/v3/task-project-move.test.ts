import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto, PageReadResponse } from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";
import {
  executeTaskProjectMove,
  prepareTaskProjectMove,
  runOptimisticTaskProjectMove,
  type TaskProjectMoveBoardPort,
} from "./task-project-move";

describe("task project move", () => {
  it("delegates the whole identity move to the server without client page writes", async () => {
    const fixture = moveFixture();
    const plan = await prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-target",
      projectPageId: fixture.target.page.id,
    });

    await executeTaskProjectMove(fixture.api, fixture.board, plan, () => "move-id");

    expect(fixture.board.moveBoardItemToContainer).toHaveBeenCalledWith({
      boardItemId: "runbook-board-item",
      container: { kind: "folder", id: "folder-target" },
      idempotencyKey: "move-id",
    });
    expect(fixture.api.transferBlocks).not.toHaveBeenCalled();
    expect(fixture.api.applyOperations).not.toHaveBeenCalled();
    expect(fixture.api.getBacklinks).not.toHaveBeenCalled();
  });

  it("keeps the optimistic projection but restores the old project after server failure", async () => {
    const fixture = moveFixture();
    fixture.board.moveBoardItemToContainer = vi.fn(async () => {
      throw new Error("board unavailable");
    });
    const projected: string[] = [];
    const project = vi.fn((task: PlannerTask, target: PageDto) => {
      projected.push(`${task.projectPageId}->${target.id}`);
    });

    await expect(runOptimisticTaskProjectMove({
      api: fixture.api,
      board: fixture.board,
      task: fixture.task,
      target: { folderId: "folder-target", projectPageId: fixture.target.page.id },
      project,
      idFactory: () => "move-id",
    })).rejects.toThrow("board unavailable");

    expect(projected).toEqual([
      "project-source->project-target",
      "project-target->project-source",
    ]);
    expect(fixture.api.transferBlocks).not.toHaveBeenCalled();
    expect(fixture.api.applyOperations).not.toHaveBeenCalled();
  });

  it("rejects a no-op project move before issuing a write", async () => {
    const fixture = moveFixture();
    await expect(prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-source",
      projectPageId: "project-source",
    })).rejects.toThrow("이미 이 프로젝트에 속한 업무입니다");
    expect(fixture.board.moveBoardItemToContainer).not.toHaveBeenCalled();
  });
});

function moveFixture() {
  const source = pageRead("project-source", "기존 프로젝트");
  const target = pageRead("project-target", "새 프로젝트");
  const api = {
    getPage: vi.fn(async (pageId: string) => pageId === source.page.id ? source : target),
    getBacklinks: vi.fn(),
    transferBlocks: vi.fn(),
    applyOperations: vi.fn(),
  } as unknown as PageApiClient;
  const board: TaskProjectMoveBoardPort = {
    moveBoardItemToContainer: vi.fn(async () => undefined),
  };
  return { api, board, source, target, task: task() };
}

function task(): PlannerTask {
  return {
    page: page("task-a", "업무 A"),
    blocks: [],
    stateVector: "AA==",
    runbookId: "task-a",
    runbook: {
      runbook: {
        id: "task-a",
        board_item_id: "runbook-board-item",
        title: "업무 A",
        status: "open",
        archived: false,
        version: 2,
        created_session_id: null,
        created_event_id: null,
        created_at: "2026-07-17T00:00:00Z",
        updated_at: "2026-07-17T00:00:00Z",
      },
      sections: [],
      items: [],
    },
    status: "open",
    assignee: "",
    contextCount: 0,
    progress: null,
    projectPageId: "project-source",
    sessionIds: [],
    mountedDocuments: [],
  };
}

function pageRead(id: string, title: string): PageReadResponse {
  return {
    page: page(id, title),
    blocks: [],
    state_vector: "AA==",
  };
}

function page(id: string, title: string): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
  };
}

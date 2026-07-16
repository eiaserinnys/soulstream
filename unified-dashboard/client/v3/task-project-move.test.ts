import { describe, expect, it, vi } from "vitest";
import type {
  PageApiClient,
  PageDto,
  PageMutationResponse,
  PageReadResponse,
  TransferPageBlocksResponse,
} from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";
import {
  executeTaskProjectMove,
  prepareTaskProjectMove,
  runOptimisticTaskProjectMove,
  type TaskProjectMoveBoardPort,
} from "./task-project-move";

describe("task project move", () => {
  it("moves the exact project mount atomically before moving the board container", async () => {
    const fixture = moveFixture();
    const sequence: string[] = [];
    fixture.api.transferBlocks = vi.fn(async () => {
      sequence.push("project-pages");
      return transferResult(fixture.source, fixture.target);
    });
    fixture.board.moveBoardItemToContainer = vi.fn(async () => {
      sequence.push("board");
    });

    const plan = await prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-target",
      projectPageId: fixture.target.page.id,
    });
    await executeTaskProjectMove(fixture.api, fixture.board, plan, () => "move-id");

    expect(sequence).toEqual(["project-pages", "board"]);
    expect(fixture.api.transferBlocks).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        pageId: "project-source",
        blockIds: ["source-mount"],
      }),
      target: expect.objectContaining({
        kind: "existing",
        pageId: "project-target",
      }),
      reason: "v3 task project mount move",
    }));
    expect(fixture.board.moveBoardItemToContainer).toHaveBeenCalledWith({
      boardItemId: "runbook-board-item",
      container: { kind: "folder", id: "folder-target" },
      idempotencyKey: "move-id",
    });
    expect(fixture.api.getPage).not.toHaveBeenCalledWith("daily-page");
  });

  it("restores the project mount if the board move fails", async () => {
    const fixture = moveFixture();
    fixture.api.transferBlocks = vi
      .fn()
      .mockResolvedValueOnce(transferResult(fixture.source, fixture.target))
      .mockResolvedValueOnce(transferResult(fixture.target, fixture.source));
    fixture.board.moveBoardItemToContainer = vi.fn(async () => {
      throw new Error("board unavailable");
    });

    const plan = await prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-target",
      projectPageId: fixture.target.page.id,
    });

    await expect(executeTaskProjectMove(fixture.api, fixture.board, plan, () => "move-id"))
      .rejects.toThrow("board unavailable");
    expect(fixture.api.transferBlocks).toHaveBeenCalledTimes(2);
    expect(fixture.api.transferBlocks).toHaveBeenLastCalledWith(expect.objectContaining({
      source: expect.objectContaining({ pageId: "project-target", blockIds: ["source-mount"] }),
      target: expect.objectContaining({ kind: "existing", pageId: "project-source" }),
      reason: "v3 task project mount rollback",
    }));
  });

  it("finds the project mounts after paginating past daily backlinks", async () => {
    const fixture = moveFixture();
    fixture.api.getBacklinks = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{
          id: "daily-link",
          sourcePageId: "daily-page",
          sourcePageTitle: "오늘",
          sourceBlockId: "daily-mount",
          sourceTextPreview: "[[업무 A]]",
          linkKind: "mount",
          targetPageId: "task-a",
          targetBlockId: null,
          sourceStart: 0,
          sourceEnd: 8,
        }],
        nextCursor: "next-backlinks",
      })
      .mockResolvedValueOnce({
        items: [{
          id: "project-link",
          sourcePageId: fixture.source.page.id,
          sourcePageTitle: fixture.source.page.title,
          sourceBlockId: "source-mount",
          sourceTextPreview: "[[업무 A]]",
          linkKind: "mount",
          targetPageId: "task-a",
          targetBlockId: null,
          sourceStart: 0,
          sourceEnd: 8,
        }],
        nextCursor: null,
      });

    const plan = await prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-target",
      projectPageId: fixture.target.page.id,
    });

    expect(plan.sourceMount?.id).toBe("source-mount");
    expect(fixture.api.getBacklinks).toHaveBeenNthCalledWith(2, "task-a", {
      kinds: ["mount"],
      limit: 100,
      cursor: "next-backlinks",
    });
  });

  it("restores a removed duplicate mount after its original sibling", async () => {
    const fixture = moveFixture();
    const before = block("before-mount", "project-source", "설명");
    const sourceMount = mountBlock();
    const targetMount = block("target-mount", "project-target", "[[업무 A]]");
    fixture.source.blocks = [before, sourceMount];
    fixture.target.blocks = [targetMount];
    fixture.api.getBacklinks = vi.fn(async () => ({
      items: [
        backlink("source-link", fixture.source, sourceMount),
        backlink("target-link", fixture.target, targetMount),
      ],
      nextCursor: null,
    }));
    fixture.api.getPage = vi
      .fn(async (pageId: string) => pageId === fixture.source.page.id ? fixture.source : fixture.target)
      .mockResolvedValueOnce(fixture.source)
      .mockResolvedValueOnce(fixture.target)
      .mockResolvedValueOnce({ ...fixture.source, blocks: [before] })
      .mockResolvedValueOnce(fixture.target);
    fixture.api.applyOperations = vi.fn(async () => mutationResult(
      fixture.source,
      { "move-id": "restored-mount" },
    ));
    fixture.board.moveBoardItemToContainer = vi.fn(async () => {
      throw new Error("board unavailable");
    });

    const plan = await prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-target",
      projectPageId: fixture.target.page.id,
    });
    await expect(executeTaskProjectMove(fixture.api, fixture.board, plan, () => "move-id"))
      .rejects.toThrow("board unavailable");

    expect(fixture.api.applyOperations).toHaveBeenLastCalledWith("project-source", expect.objectContaining({
      operations: [expect.objectContaining({
        op: "create_block",
        after_block_id: "before-mount",
        text: "[[업무 A]]",
      })],
    }));
  });

  it("creates the missing target mount without touching the daily mount", async () => {
    const fixture = moveFixture({ sourceMount: false });
    fixture.api.applyOperations = vi.fn(async (_pageId, input) => mutationResult(
      fixture.target,
      { [String((input.operations[0] as { temp_id?: string }).temp_id)]: "created-target-mount" },
    ));

    const plan = await prepareTaskProjectMove(fixture.api, fixture.task, {
      folderId: "folder-target",
      projectPageId: fixture.target.page.id,
    });
    await executeTaskProjectMove(fixture.api, fixture.board, plan, () => "move-id");

    expect(fixture.api.applyOperations).toHaveBeenCalledWith("project-target", expect.objectContaining({
      reason: "v3 task project mount create",
      operations: [expect.objectContaining({ text: "[[업무 A]]" })],
    }));
    expect(fixture.api.applyOperations).not.toHaveBeenCalledWith("daily-page", expect.anything());
  });

  it("projects before writes and restores the old project after failure", async () => {
    const fixture = moveFixture();
    const sequence: string[] = [];
    fixture.api.transferBlocks = vi.fn(async () => {
      sequence.push("page-write");
      return transferResult(fixture.source, fixture.target);
    });
    fixture.board.moveBoardItemToContainer = vi.fn(async () => {
      throw new Error("board unavailable");
    });
    const project = vi.fn((task: PlannerTask, target: PageDto) => {
      sequence.push(`project:${task.projectPageId}->${target.id}`);
    });

    await expect(runOptimisticTaskProjectMove({
      api: fixture.api,
      board: fixture.board,
      task: fixture.task,
      target: { folderId: "folder-target", projectPageId: fixture.target.page.id },
      project,
      idFactory: () => "move-id",
    })).rejects.toThrow("board unavailable");

    expect(sequence).toEqual([
      "project:project-source->project-target",
      "page-write",
      "page-write",
      "project:project-target->project-source",
    ]);
  });
});

function moveFixture(options: { sourceMount?: boolean } = {}) {
  const source = pageRead("project-source", "기존 프로젝트", options.sourceMount === false ? [] : [mountBlock()]);
  const target = pageRead("project-target", "새 프로젝트", []);
  const backlinks = options.sourceMount === false ? [] : [{
    id: "link-source",
    sourcePageId: source.page.id,
    sourcePageTitle: source.page.title,
    sourceBlockId: "source-mount",
    sourceTextPreview: "[[업무 A]]",
    linkKind: "mount" as const,
    targetPageId: "task-a",
    targetBlockId: null,
    sourceStart: 0,
    sourceEnd: 8,
  }];
  const api = {
    getBacklinks: vi.fn(async () => ({ items: backlinks, nextCursor: null })),
    getPage: vi.fn(async (pageId: string) => pageId === source.page.id ? source : target),
    transferBlocks: vi.fn(async () => transferResult(source, target)),
    applyOperations: vi.fn(async () => mutationResult(target)),
  } as unknown as PageApiClient;
  const board: TaskProjectMoveBoardPort = {
    moveBoardItemToContainer: vi.fn(async () => undefined),
  };
  return { api, board, source, target, task: task() };
}

function task(): PlannerTask {
  return {
    page: page("task-a", "업무 A", 3),
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

function pageRead(id: string, title: string, blocks: PageReadResponse["blocks"]): PageReadResponse {
  return { page: page(id, title, 4), blocks, state_vector: "AA==" };
}

function page(id: string, title: string, version: number): PageDto {
  return {
    id,
    title,
    daily_date: null,
    version,
    archived: false,
    metadata: {},
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
  };
}

function mountBlock(): PageReadResponse["blocks"][number] {
  return block("source-mount", "project-source", "[[업무 A]]");
}

function block(id: string, pageId: string, text: string): PageReadResponse["blocks"][number] {
  return {
    id,
    page_id: pageId,
    parent_id: null,
    position_key: "A",
    block_type: "paragraph",
    text,
    properties: {},
    collapsed: false,
  };
}

function backlink(
  id: string,
  pageSnapshot: PageReadResponse,
  sourceBlock: PageReadResponse["blocks"][number],
) {
  return {
    id,
    sourcePageId: pageSnapshot.page.id,
    sourcePageTitle: pageSnapshot.page.title,
    sourceBlockId: sourceBlock.id,
    sourceTextPreview: sourceBlock.text,
    linkKind: "mount" as const,
    targetPageId: "task-a",
    targetBlockId: null,
    sourceStart: 0,
    sourceEnd: sourceBlock.text.length,
  };
}

function transferResult(source: PageReadResponse, target: PageReadResponse): TransferPageBlocksResponse {
  return {
    source: mutationResult(source),
    target: mutationResult(target),
    target_created: false,
  };
}

function mutationResult(
  snapshot: PageReadResponse,
  tempIdMapping: Record<string, string> = {},
): PageMutationResponse {
  return {
    page: { ...snapshot.page, version: snapshot.page.version + 1 },
    blocks: snapshot.blocks,
    operation: { id: "operation" },
    temp_id_mapping: tempIdMapping,
  };
}

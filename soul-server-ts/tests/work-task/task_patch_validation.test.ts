import { describe, expect, it, vi } from "vitest";

import type { TaskRepository } from "../../src/work-task/task_repository.js";
import { TaskService } from "../../src/work-task/task_service.js";
import type { TaskDbPort } from "../../src/work-task/task_service_models.js";

describe("TaskService patch validation", () => {
  it.each([
    {
      targetKind: "task",
      mutate: (service: TaskService) => service.patchTask({
        taskId: "task-1",
        expectedVersion: 1,
        actorSessionId: null,
      }),
    },
    {
      targetKind: "section",
      mutate: (service: TaskService) => service.patchSection({
        taskId: "task-1",
        sectionId: "section-1",
        expectedVersion: 1,
        actorSessionId: null,
      }),
    },
    {
      targetKind: "item",
      mutate: (service: TaskService) => service.patchItem({
        taskId: "task-1",
        itemId: "item-1",
        expectedVersion: 1,
        actorSessionId: null,
      }),
    },
  ])("rejects an empty $targetKind patch before opening a transaction", async ({
    targetKind,
    mutate,
  }) => {
    const { service, transaction } = createService();

    await expect(mutate(service)).rejects.toThrow(
      `task ${targetKind} patch requires at least one field to update`,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "title only",
      patch: { title: "Renamed" },
      expected: { title: "Renamed", how_to: undefined, archived: undefined },
    },
    {
      label: "body only",
      patch: { howTo: "New steps" },
      expected: { title: undefined, how_to: "New steps", archived: undefined },
    },
    {
      label: "title and body",
      patch: { title: "Renamed", howTo: "New steps" },
      expected: { title: "Renamed", how_to: "New steps", archived: undefined },
    },
  ])("keeps a normal item patch working: $label", async ({ patch, expected }) => {
    const { service, repo } = createService();

    await expect(service.patchItem({
      taskId: "task-1",
      itemId: "item-1",
      expectedVersion: 1,
      actorSessionId: null,
      ...patch,
    })).resolves.toMatchObject({
      snapshot: { task: { id: "task-1" } },
    });
    expect(repo.patchItemTx).toHaveBeenCalledWith(
      expect.anything(),
      "item-1",
      expected,
      1,
      null,
      null,
    );
  });

  it.each([
    {
      label: "archived false",
      mutate: (service: TaskService) => service.patchTask({
        taskId: "task-1",
        expectedVersion: 1,
        actorSessionId: null,
        archived: false,
      }),
    },
    {
      label: "section assignee clear",
      mutate: (service: TaskService) => service.patchSection({
        taskId: "task-1",
        sectionId: "section-1",
        expectedVersion: 1,
        actorSessionId: null,
        assignee: null,
      }),
    },
    {
      label: "item assignee clear",
      mutate: (service: TaskService) => service.patchItem({
        taskId: "task-1",
        itemId: "item-1",
        expectedVersion: 1,
        actorSessionId: null,
        assignee: null,
      }),
    },
  ])("preserves a defined patch value: $label", async ({ mutate }) => {
    const { service, transaction } = createService();

    await expect(mutate(service)).resolves.toMatchObject({
      snapshot: { task: { id: "task-1" } },
    });
    expect(transaction).toHaveBeenCalledOnce();
  });
});

function createService() {
  const transaction = vi.fn(async (
    callback: (sql: never) => Promise<unknown>,
  ) => await callback({} as never));
  const repo = {
    transaction,
    assertTaskVersionTx: vi.fn(async () => undefined),
    assertSectionBelongsToTaskTx: vi.fn(async () => undefined),
    assertSectionVersionTx: vi.fn(async () => undefined),
    assertItemBelongsToTaskTx: vi.fn(async () => undefined),
    assertItemVersionTx: vi.fn(async () => undefined),
    patchTaskTx: vi.fn(async () => undefined),
    patchSectionTx: vi.fn(async () => undefined),
    patchItemTx: vi.fn(async () => undefined),
    appendOperationTx: vi.fn(async (_sql, params) => ({
      ...params,
      actor_event_id: null,
    })),
    getSnapshot: vi.fn(async () => ({
      task: {
        id: "task-1",
        board_item_id: "task:task-1",
      },
      sections: [],
      items: [],
      operations: [],
    })),
  } as unknown as TaskRepository;
  const db = {
    tasks: () => repo,
  } as unknown as TaskDbPort;
  const service = new TaskService(
    db,
    undefined,
    {
      upsertTaskBoardItem: vi.fn(),
      removeTaskBoardItem: vi.fn(),
    },
  );
  return { service, repo, transaction };
}

import { describe, expect, it, vi } from "vitest";

import type {
  TaskItemRow,
  TaskSnapshot,
} from "../../src/db/session_db_types.js";
import {
  ChecklistTaskAdapter,
  checklistItemId,
  checklistTaskId,
  checklistSectionId,
  type ChecklistTaskPort,
  type ChecklistTaskIdentityPort,
} from "../../src/page/checklist_task_adapter.js";
import { TaskVersionConflict } from "../../src/work-task/task_models.js";
import type { TaskMutationResult } from "../../src/work-task/task_service_models.js";

const actor = {
  actorKind: "agent" as const,
  actorSessionId: "sess-actor",
};

function legacyInput(checked: boolean, overrides: Record<string, unknown> = {}) {
  return {
    page: {
      id: "page-1",
      title: "프로젝트",
      metadata: { legacyFolderId: "folder-1" },
    },
    block: {
      id: "block-1",
      text: "배포 확인",
      properties: { checked },
    },
    actor,
    ...overrides,
  };
}

function mutation(snapshot: TaskSnapshot): TaskMutationResult {
  return {
    snapshot,
    eventId: 1,
    operation: {
      id: "op-1",
      task_id: snapshot.task.id,
      target_kind: "item",
      target_id: "target",
      operation_type: "test",
      actor_kind: "agent",
      actor_session_id: actor.actorSessionId,
      actor_event_id: 1,
      actor_user_id: null,
      idempotency_key: null,
      payload_json: {},
      reason: null,
      created_at: new Date(0),
    },
  };
}

function harness() {
  let snapshot: TaskSnapshot | null = null;
  let failCreateSectionOnce = false;
  let conflictStatusOnce = false;
  const statusResults = new Map<string, TaskMutationResult>();

  const taskIdentities = {
    promoteExistingPage: vi.fn(async (params) => {
      snapshot ??= {
        task: {
          id: params.pageId,
          board_item_id: `task:${params.pageId}`,
          title: params.title,
          status: "open",
          archived: false,
          version: 1,
          created_session_id: params.actorSessionId,
          created_event_id: 1,
          completed_kind: null,
          completed_session_id: null,
          completed_event_id: null,
          completed_user_id: null,
          completed_at: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
        sections: [],
        items: [],
      };
      return { id: params.pageId, pageId: params.pageId, taskId: params.pageId } as never;
    }),
  } satisfies ChecklistTaskIdentityPort;
  const port = {
    getTask: vi.fn(async () => snapshot),
    createSection: vi.fn(async (params) => {
      if (failCreateSectionOnce) {
        failCreateSectionOnce = false;
        throw new Error("temporary section failure");
      }
      if (!snapshot) throw new Error("task missing");
      if (!snapshot.sections.some((section) => section.id === params.sectionId)) {
        snapshot.sections.push({
          id: params.sectionId!,
          task_id: params.taskId,
          position_key: "a",
          title: params.title,
          archived: false,
          version: 1,
          created_session_id: params.actorSessionId,
          created_event_id: 1,
          updated_session_id: params.actorSessionId,
          updated_event_id: 1,
          created_at: new Date(0),
          updated_at: new Date(0),
          assignee_kind: null,
          assignee_agent_id: null,
          assignee_session_id: null,
          assignee_user_id: null,
        });
      }
      return mutation(snapshot);
    }),
    createItem: vi.fn(async (params) => {
      if (!snapshot) throw new Error("task missing");
      if (!snapshot.items.some((item) => item.id === params.itemId)) {
        snapshot.items.push(item({
          id: params.itemId!,
          section_id: params.sectionId,
          title: params.title,
        }));
      }
      return mutation(snapshot);
    }),
    patchItem: vi.fn(async (params) => {
      const current = snapshot?.items.find((candidate) => candidate.id === params.itemId);
      if (!snapshot || !current) throw new Error("item missing");
      if (current.version !== params.expectedVersion) {
        throw new TaskVersionConflict("item", current.id, params.expectedVersion, current.version);
      }
      if (params.title !== undefined) current.title = params.title;
      if (params.archived !== undefined) current.archived = params.archived;
      current.version += 1;
      return mutation(snapshot);
    }),
    setItemStatus: vi.fn(async (params) => {
      const idempotent = params.idempotencyKey
        ? statusResults.get(params.idempotencyKey)
        : undefined;
      if (idempotent) return { ...idempotent, idempotent: true };
      const current = snapshot?.items.find((candidate) => candidate.id === params.itemId);
      if (!snapshot || !current) throw new Error("item missing");
      if (conflictStatusOnce) {
        conflictStatusOnce = false;
        current.version += 1;
        throw new TaskVersionConflict("item", current.id, params.expectedVersion, current.version);
      }
      if (current.version !== params.expectedVersion) {
        throw new TaskVersionConflict("item", current.id, params.expectedVersion, current.version);
      }
      current.status = params.status;
      current.version += 1;
      const result = mutation(snapshot);
      if (params.idempotencyKey) statusResults.set(params.idempotencyKey, result);
      return result;
    }),
  } satisfies ChecklistTaskPort;

  return {
    port,
    taskIdentities,
    adapter: new ChecklistTaskAdapter(port, taskIdentities),
    snapshot: () => snapshot,
    failNextSectionCreate: () => { failCreateSectionOnce = true; },
    conflictNextStatus: () => { conflictStatusOnce = true; },
  };
}

function item(overrides: Partial<TaskItemRow> = {}): TaskItemRow {
  return {
    id: "checklist:block-1",
    section_id: "page-section:page-1",
    position_key: "a",
    title: "배포 확인",
    how_to: "",
    status: "pending",
    archived: false,
    version: 1,
    created_session_id: actor.actorSessionId,
    created_event_id: 1,
    updated_session_id: actor.actorSessionId,
    updated_event_id: 1,
    completed_kind: null,
    completed_session_id: null,
    completed_event_id: null,
    completed_user_id: null,
    completed_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
    ...overrides,
  };
}

describe("ChecklistTaskAdapter", () => {
  it("adopts legacy checked state into deterministic Task objects", async () => {
    const h = harness();
    const result = await h.adapter.reconcile(legacyInput(true));

    expect(result).toEqual({
      properties: { taskId: "page-1", itemId: "checklist:block-1" },
      status: "completed",
      checked: true,
    });
    expect(h.taskIdentities.promoteExistingPage).toHaveBeenCalledWith(expect.objectContaining({
      pageId: checklistTaskId("page-1"),
      folderId: "folder-1",
    }));
    expect(h.port.createSection).toHaveBeenCalledWith(expect.objectContaining({
      sectionId: checklistSectionId("page-1"),
    }));
    expect(h.port.createItem).toHaveBeenCalledWith(expect.objectContaining({
      itemId: checklistItemId("block-1"),
      title: "배포 확인",
    }));
    expect(h.port.setItemStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
    }));
  });

  it("uses the existing Claude default folder when page metadata has no legacyFolderId", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(false, {
      page: { id: "page-1", title: "프로젝트", metadata: {} },
    }));

    expect(h.taskIdentities.promoteExistingPage).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "claude" }),
    );
  });

  it("treats a bound reference as canonical and ignores a leftover legacy checked value", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(true));
    await h.port.setItemStatus({
      ...actor,
      itemId: "checklist:block-1",
      expectedVersion: 2,
      status: "pending",
      idempotencyKey: "test:block:reset",
    });
    vi.mocked(h.port.setItemStatus).mockClear();

    const result = await h.adapter.reconcile({
      ...legacyInput(true),
      block: {
        id: "block-1",
        text: "배포 확인",
        properties: {
          taskId: "page-task:page-1",
          itemId: "checklist:block-1",
          checked: true,
        } as never,
      },
    });

    expect(result.checked).toBe(false);
    expect(h.port.setItemStatus).not.toHaveBeenCalled();
  });

  it("resumes deterministic creation after a partial failure and a process restart", async () => {
    const h = harness();
    h.failNextSectionCreate();
    await expect(h.adapter.reconcile(legacyInput(false))).rejects.toThrow("temporary section failure");

    const restarted = new ChecklistTaskAdapter(h.port, h.taskIdentities);
    const result = await restarted.reconcile(legacyInput(false));
    await restarted.reconcile(legacyInput(false));

    expect(result.properties).toEqual({
      taskId: "page-1",
      itemId: "checklist:block-1",
    });
    expect(h.snapshot()?.sections).toHaveLength(1);
    expect(h.snapshot()?.items).toHaveLength(1);
    expect(h.taskIdentities.promoteExistingPage).toHaveBeenCalledTimes(1);
    expect(h.port.createItem).toHaveBeenCalledTimes(1);
  });

  it("projects title changes and archives then restores the deterministic item", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(true));
    await h.adapter.reconcile({
      ...legacyInput(true),
      block: {
        id: "block-1",
        text: "운영 배포 확인",
        properties: { taskId: "page-1", itemId: "checklist:block-1" },
      },
    });
    await h.adapter.archive({ pageId: "page-1", blockId: "block-1", actor });
    expect(h.snapshot()?.items[0]).toMatchObject({ title: "운영 배포 확인", archived: true });

    const restored = await h.adapter.reconcile({
      ...legacyInput(false),
      block: {
        id: "block-1",
        text: "재생성된 확인",
        properties: { checked: false },
      },
    });

    expect(restored.properties.itemId).toBe("checklist:block-1");
    expect(h.snapshot()?.items[0]).toMatchObject({
      title: "재생성된 확인",
      archived: false,
      status: "pending",
    });
  });

  it("serializes concurrent toggles so two actions are both preserved", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(false));

    const [first, second] = await Promise.all([
      h.adapter.toggle({
        taskId: "page-1",
        itemId: "checklist:block-1",
        actor,
        idempotencyKey: "checklist-toggle:browser:one",
      }),
      h.adapter.toggle({
        taskId: "page-1",
        itemId: "checklist:block-1",
        actor,
        idempotencyKey: "checklist-toggle:browser:two",
      }),
    ]);

    expect([first.checked, second.checked]).toEqual([true, false]);
    expect(h.snapshot()?.items[0]?.status).toBe("pending");
  });

  it("routes an explicit checked value through one versioned Task mutation", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(false));

    const result = await h.adapter.setChecked({
      taskId: "page-1",
      itemId: "checklist:block-1",
      checked: true,
      expectedVersion: 1,
      actor,
      reason: "dashboard toggle",
      idempotencyKey: "checklist-set:browser:one",
    });

    expect(h.port.setItemStatus).toHaveBeenCalledWith({
      ...actor,
      itemId: "checklist:block-1",
      expectedVersion: 1,
      status: "completed",
      reason: "dashboard toggle",
      idempotencyKey: "checklist-set:browser:one",
    });
    expect(result.projection).toEqual({
      properties: {
        taskId: "page-1",
        itemId: "checklist:block-1",
      },
      status: "completed",
      checked: true,
    });
  });

  it("does not apply the same toggle idempotency key twice", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(false));
    const input = {
      taskId: "page-1",
      itemId: "checklist:block-1",
      actor,
      idempotencyKey: "checklist-toggle:browser:retry",
    };

    const first = await h.adapter.toggle(input);
    const retry = await h.adapter.toggle(input);

    expect(first.checked).toBe(true);
    expect(retry.checked).toBe(true);
    expect(h.snapshot()?.items[0]?.status).toBe("completed");
  });

  it("repeats the same legacy adoption across later delete/recreate cycles", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(false));

    for (const suffix of ["first", "second"]) {
      await h.adapter.toggle({
        taskId: "page-1",
        itemId: "checklist:block-1",
        actor,
        idempotencyKey: `checklist-toggle:browser:${suffix}`,
      });
      await h.adapter.archive({ pageId: "page-1", blockId: "block-1", actor });
      const restored = await h.adapter.reconcile(legacyInput(false));
      expect(restored.checked).toBe(false);
    }

    expect(h.snapshot()?.items[0]).toMatchObject({ status: "pending", archived: false });
  });

  it("re-reads and retries a CAS conflict without bypassing TaskService", async () => {
    const h = harness();
    await h.adapter.reconcile(legacyInput(false));
    h.conflictNextStatus();

    const result = await h.adapter.toggle({
      taskId: "page-1",
      itemId: "checklist:block-1",
      actor,
      idempotencyKey: "checklist-toggle:browser:conflict",
    });

    expect(result.checked).toBe(true);
    expect(h.port.setItemStatus).toHaveBeenCalledTimes(2);
  });
});

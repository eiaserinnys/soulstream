import { describe, expect, it } from "vitest";

import type {
  TaskAssigneeFields,
  TaskItemRow,
  TaskSnapshot,
} from "./task-store";
import { applyTaskMutationOptimistically } from "./task-mutations";

describe("applyTaskMutationOptimistically", () => {
  it("creates and edits one section without mutating the input snapshot", () => {
    const before = snapshot();
    const created = applyTaskMutationOptimistically(before, {
      kind: "create_section",
      taskId: "rb-1",
      sectionId: "sec-3",
      title: "새 섹션",
      afterSectionId: "sec-2",
      idempotencyKey: "create-section",
    }, "2026-07-17T00:00:01Z");
    const edited = applyTaskMutationOptimistically(created, {
      kind: "update_section",
      taskId: "rb-1",
      sectionId: "sec-3",
      expectedVersion: 1,
      title: "바뀐 섹션",
      idempotencyKey: "update-section",
    }, "2026-07-17T00:00:02Z");

    expect(before.sections.map((section) => section.id)).toEqual(["sec-1", "sec-2"]);
    expect(edited.sections.map((section) => section.id)).toEqual(["sec-1", "sec-2", "sec-3"]);
    expect(edited.sections[2]).toMatchObject({ title: "바뀐 섹션", version: 2 });
  });

  it("moves sections and items using the requested sibling bounds", () => {
    const before = snapshot();
    before.sections.reverse();
    before.items.reverse();
    const movedSection = applyTaskMutationOptimistically(before, {
      kind: "move_section",
      taskId: "rb-1",
      sectionId: "sec-2",
      expectedVersion: 1,
      beforeSectionId: "sec-1",
      idempotencyKey: "move-section",
    });
    const movedItem = applyTaskMutationOptimistically(movedSection, {
      kind: "move_item",
      taskId: "rb-1",
      itemId: "item-2",
      sectionId: "sec-1",
      expectedVersion: 1,
      beforeItemId: "item-1",
      idempotencyKey: "move-item",
    });

    expect(movedSection.sections.map((section) => section.id)).toEqual(["sec-2", "sec-1"]);
    expect(
      movedItem.items
        .filter((item) => item.section_id === "sec-1")
        .map((item) => item.id),
    ).toEqual(["item-2", "item-1"]);
  });

  it("creates and edits item title and how_to together", () => {
    const before = snapshot();
    const created = applyTaskMutationOptimistically(before, {
      kind: "create_item",
      taskId: "rb-1",
      sectionId: "sec-2",
      itemId: "item-3",
      title: "New item",
      howTo: "First steps",
      idempotencyKey: "create-item",
    });
    const edited = applyTaskMutationOptimistically(created, {
      kind: "update_item",
      taskId: "rb-1",
      itemId: "item-3",
      expectedVersion: 1,
      title: "Edited item",
      howTo: "",
      idempotencyKey: "update-item",
    });

    expect(before.items).toHaveLength(2);
    expect(edited.items.find((item) => item.id === "item-3")).toMatchObject({
      section_id: "sec-2",
      title: "Edited item",
      how_to: "",
      version: 2,
    });
  });

  it("archives only the requested target and preserves sibling rows", () => {
    const before = snapshot();
    const withoutItem = applyTaskMutationOptimistically(before, {
      kind: "archive_item",
      taskId: "rb-1",
      itemId: "item-1",
      expectedVersion: 1,
      idempotencyKey: "archive-item",
    });
    const withoutSection = applyTaskMutationOptimistically(withoutItem, {
      kind: "archive_section",
      taskId: "rb-1",
      sectionId: "sec-2",
      expectedVersion: 1,
      idempotencyKey: "archive-section",
    });

    expect(withoutItem.items.map((item) => item.id)).toEqual(["item-2"]);
    expect(withoutSection.sections.map((section) => section.id)).toEqual(["sec-1"]);
    expect(withoutSection.items.map((item) => item.id)).toEqual(["item-2"]);
  });
});

function snapshot(): TaskSnapshot {
  const common = {
    archived: false,
    version: 1,
    created_session_id: "sess-1",
    created_event_id: 1,
    updated_session_id: null,
    updated_event_id: null,
    created_at: "2026-07-17T00:00:00Z",
    updated_at: "2026-07-17T00:00:00Z",
  };
  const assignee = {
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
  };
  return {
    task: {
      id: "rb-1",
      board_item_id: "task:rb-1",
      folder_id: "folder-1",
      title: "Work",
      archived: false,
      version: 1,
      created_session_id: "sess-1",
      created_event_id: 1,
      created_at: common.created_at,
      updated_at: common.updated_at,
    },
    sections: [
      { ...common, ...assignee, id: "sec-1", task_id: "rb-1", position_key: "a", title: "One" },
      { ...common, ...assignee, id: "sec-2", task_id: "rb-1", position_key: "b", title: "Two" },
    ],
    items: [
      item("item-1", "sec-1", "a", common, assignee),
      item("item-2", "sec-1", "b", common, assignee),
    ],
  };
}

function item(
  id: string,
  sectionId: string,
  positionKey: string,
  common: Pick<
    TaskItemRow,
    | "archived"
    | "version"
    | "created_session_id"
    | "created_event_id"
    | "updated_session_id"
    | "updated_event_id"
    | "created_at"
    | "updated_at"
  >,
  assignee: TaskAssigneeFields,
): TaskItemRow {
  return {
    ...common,
    ...assignee,
    id,
    section_id: sectionId,
    position_key: positionKey,
    title: id,
    how_to: "",
    status: "pending" as const,
    completed_kind: null,
    completed_session_id: null,
    completed_event_id: null,
    completed_user_id: null,
    completed_at: null,
  };
}

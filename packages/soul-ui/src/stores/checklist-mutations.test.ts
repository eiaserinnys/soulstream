import { describe, expect, it } from "vitest";

import type {
  ChecklistAssigneeFields,
  ChecklistItemRow,
  FolderSnapshot,
} from "./folder-checklist-store";
import { applyChecklistMutationOptimistically } from "./checklist-mutations";

describe("applyChecklistMutationOptimistically", () => {
  it("creates and edits one section without mutating the input snapshot", () => {
    const before = snapshot();
    const created = applyChecklistMutationOptimistically(before, {
      kind: "create_section",
      folderId: "folder-1",
      sectionId: "sec-3",
      title: "새 섹션",
      afterSectionId: "sec-2",
      idempotencyKey: "create-section",
    }, "2026-07-17T00:00:01Z");
    const edited = applyChecklistMutationOptimistically(created, {
      kind: "update_section",
      folderId: "folder-1",
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
    const movedSection = applyChecklistMutationOptimistically(before, {
      kind: "move_section",
      folderId: "folder-1",
      sectionId: "sec-2",
      expectedVersion: 1,
      beforeSectionId: "sec-1",
      idempotencyKey: "move-section",
    });
    const movedItem = applyChecklistMutationOptimistically(movedSection, {
      kind: "move_item",
      folderId: "folder-1",
      itemId: "item-2",
      sectionId: "sec-1",
      expectedVersion: 1,
      beforeItemId: "item-1",
      idempotencyKey: "move-item",
    });

    expect(movedSection.sections.map((section) => section.id)).toEqual(["sec-2", "sec-1"]);
    expect(
      movedItem.items
        .filter((item) => item.sectionId === "sec-1")
        .map((item) => item.id),
    ).toEqual(["item-2", "item-1"]);
  });

  it("creates and edits item title and howTo together", () => {
    const before = snapshot();
    const created = applyChecklistMutationOptimistically(before, {
      kind: "create_item",
      folderId: "folder-1",
      sectionId: "sec-2",
      itemId: "item-3",
      title: "New item",
      howTo: "First steps",
      idempotencyKey: "create-item",
    });
    const edited = applyChecklistMutationOptimistically(created, {
      kind: "update_item",
      folderId: "folder-1",
      itemId: "item-3",
      expectedVersion: 1,
      title: "Edited item",
      howTo: "",
      idempotencyKey: "update-item",
    });

    expect(before.items).toHaveLength(2);
    expect(edited.items.find((item) => item.id === "item-3")).toMatchObject({
      sectionId: "sec-2",
      title: "Edited item",
      howTo: "",
      version: 2,
    });
  });

  it("archives only the requested target and preserves sibling rows", () => {
    const before = snapshot();
    const withoutItem = applyChecklistMutationOptimistically(before, {
      kind: "archive_item",
      folderId: "folder-1",
      itemId: "item-1",
      expectedVersion: 1,
      idempotencyKey: "archive-item",
    });
    const withoutSection = applyChecklistMutationOptimistically(withoutItem, {
      kind: "archive_section",
      folderId: "folder-1",
      sectionId: "sec-2",
      expectedVersion: 1,
      idempotencyKey: "archive-section",
    });

    expect(withoutItem.items.map((item) => item.id)).toEqual(["item-2"]);
    expect(withoutSection.sections.map((section) => section.id)).toEqual(["sec-1"]);
    expect(withoutSection.items.map((item) => item.id)).toEqual(["item-2"]);
  });
});

function snapshot(): FolderSnapshot {
  const common = {
    archived: false,
    version: 1,
    createdSessionId: "sess-1",
    createdEventId: 1,
    updatedSessionId: null,
    updatedEventId: null,
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:00Z",
  };
  const assignee = {
    assigneeKind: null,
    assigneeAgentId: null,
    assigneeSessionId: null,
    assigneeUserId: null,
  };
  return {
    folder: {
      id: "folder-1",
      name: "Work",
      parentFolderId: null,
      projectPageId: "page-1",
      checklistEnabled: true,
      status: "open",
      completedKind: null,
      completedSessionId: null,
      completedEventId: null,
      completedUserId: null,
      completedAt: null,
      archived: false,
      version: 1,
      createdSessionId: "sess-1",
      createdEventId: 1,
      createdAt: common.createdAt,
      updatedAt: common.updatedAt,
    },
    sections: [
      { ...common, ...assignee, id: "sec-1", folderId: "folder-1", positionKey: "a", title: "One" },
      { ...common, ...assignee, id: "sec-2", folderId: "folder-1", positionKey: "b", title: "Two" },
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
    ChecklistItemRow,
    | "archived"
    | "version"
    | "createdSessionId"
    | "createdEventId"
    | "updatedSessionId"
    | "updatedEventId"
    | "createdAt"
    | "updatedAt"
  >,
  assignee: ChecklistAssigneeFields,
): ChecklistItemRow {
  return {
    ...common,
    ...assignee,
    id,
    sectionId: sectionId,
    positionKey: positionKey,
    title: id,
    howTo: "",
    status: "pending" as const,
    completedKind: null,
    completedSessionId: null,
    completedEventId: null,
    completedUserId: null,
    completedAt: null,
  };
}

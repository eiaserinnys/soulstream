import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { transformFolderStorageSnapshot } from "../src/folders/folder_storage_migration.js";
import { createPageYDocSnapshot, readPageYDocReplica } from "../src/page/page_yjs_model.js";

describe("folder storage migration", () => {
  it("preserves board identity, contents and coordinates while changing ownership vocabulary", () => {
    const before = new Y.Doc();
    before.getMap("boardItems").set("task:child", {
      item_type: "task", item_id: "child", x: 42, y: 19,
      source_task_item_id: "checklist-item", metadata: { title: "문서", extra: 3 },
    });
    const text = new Y.Text("본문 보존");
    before.getMap("markdownBodies").set("document", text);
    const result = transformFolderStorageSnapshot("board:task:parent", Y.encodeStateAsUpdate(before));
    expect(result.name).toBe("board-folder:parent");
    expect(result.changed).toBe(true);
    const after = new Y.Doc();
    Y.applyUpdate(after, result.snapshot);
    expect(after.getMap("boardItems").get("task:child")).toEqual({
      item_type: "subfolder", item_id: "child", x: 42, y: 19,
      source_checklist_item_id: "checklist-item", metadata: { title: "문서", extra: 3 },
    });
    expect(after.getMap<Y.Text>("markdownBodies").get("document")?.toString()).toBe("본문 보존");
    expect(transformFolderStorageSnapshot(result.name, result.snapshot).changed).toBe(false);
    before.destroy(); after.destroy();
  });

  it("changes a page link in its Y.Doc without deleting blocks or their text", () => {
    const snapshot = createPageYDocSnapshot({
      page: { id: "p", title: "폴더", dailyDate: null, mutationVersion: 3, archived: false,
        metadata: { taskIdentity: true, starred: true } },
      blocks: [
        { id: "ref", parentId: null, positionKey: "a0", type: "task_ref", text: "보존",
          properties: { taskId: "folder", primary: true }, collapsed: true },
        { id: "check", parentId: null, positionKey: "a1", type: "checklist", text: "확인",
          properties: { taskId: "folder", itemId: "item", checked: true }, collapsed: false },
      ],
    });
    const result = transformFolderStorageSnapshot("page:p", snapshot);
    const after = new Y.Doc(); Y.applyUpdate(after, result.snapshot);
    const replica = readPageYDocReplica("p", after);
    expect(replica.page.metadata).toEqual({ starred: true });
    expect(replica.page.mutationVersion).toBe(4);
    expect(replica.blocks.map(({ id, type, properties, text }) => ({ id, type, properties, text }))).toEqual([
      { id: "ref", type: "folder_ref", properties: { folderId: "folder", primary: true }, text: "보존" },
      { id: "check", type: "checklist", properties: { folderId: "folder", itemId: "item", checked: true }, text: "확인" },
    ]);
    expect(transformFolderStorageSnapshot(result.name, result.snapshot).changed).toBe(false);
    after.destroy();
  });
});

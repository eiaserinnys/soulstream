import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import {
  PageMutationCore,
  PageMutationValidationError,
  PageMutationVersionConflictError,
} from "../../src/page/page_mutation_core.js";
import { readPageYDocReplica } from "../../src/page/page_yjs_model.js";

function createCore(): PageMutationCore {
  let nextId = 0;
  return new PageMutationCore({ createId: () => `generated-${++nextId}` });
}

function createPage(core = createCore()) {
  return core.createPage({
    page: { id: "page-1", title: "Original", dailyDate: null, metadata: {} },
    actor: { actorKind: "agent", actorSessionId: "session-1" },
    idempotencyKey: "create_page:session-1:request-1",
  });
}

describe("PageMutationCore", () => {
  it("creates version 1 and applies each command as one page-level CAS increment", () => {
    const core = createCore();
    const created = createPage(core);
    expect(created.expectedVersion).toBe(0);
    expect(created.resultVersion).toBe(1);
    expect(created.operationType).toBe("create_page");

    const source = created.document;
    const renamed = core.mutate(source, {
      pageId: "page-1",
      expectedVersion: 1,
      command: { type: "rename_page", title: "Renamed" },
      actor: { actorKind: "user", actorUserId: "user-1" },
      idempotencyKey: "rename_page:user-1:request-1",
    });
    expect(renamed.resultVersion).toBe(2);
    expect(renamed.replica.page.title).toBe("Renamed");
    expect(readPageYDocReplica("page-1", source).page).toMatchObject({
      title: "Original",
      mutationVersion: 1,
    });

    expect(() => core.mutate(source, {
      pageId: "page-1",
      expectedVersion: 2,
      command: { type: "archive_page" },
      actor: { actorKind: "system" },
      idempotencyKey: "archive_page:system:request-1",
    })).toThrow(PageMutationVersionConflictError);
  });

  it("applies a temp-id batch atomically and increments the page once", () => {
    const core = createCore();
    const created = createPage(core);
    const batch = core.mutate(created.document, {
      pageId: "page-1",
      expectedVersion: 1,
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      idempotencyKey: "batch_page_operations:session-1:request-2",
      command: {
        type: "batch_operations",
        operations: [
          {
            op: "create_block",
            tempId: "root",
            parentId: null,
            parentTempId: null,
            afterBlockId: null,
            afterTempId: null,
            blockType: "paragraph",
            text: "Root",
            properties: {},
          },
          {
            op: "create_block",
            tempId: "child",
            parentId: null,
            parentTempId: "root",
            afterBlockId: null,
            afterTempId: null,
            blockType: "checklist",
            text: "Child",
            properties: { checked: false },
          },
          { op: "set_check_state", blockId: "child", checked: true },
          { op: "update_block_text", blockId: "root", text: "Updated root" },
        ],
      },
    });

    expect(batch.resultVersion).toBe(2);
    expect(batch.tempIdMapping).toEqual({
      root: "generated-1",
      child: "generated-2",
    });
    expect(batch.replica.blocks).toEqual([
      expect.objectContaining({ id: "generated-1", text: "Updated root", parentId: null }),
      expect.objectContaining({
        id: "generated-2",
        parentId: "generated-1",
        type: "checklist",
        properties: { checked: true },
      }),
    ]);
    expect(readPageYDocReplica("page-1", created.document).blocks).toEqual([]);
  });

  it.each([
    {
      name: "duplicate temp ids",
      operations: [
        createBlock("same"),
        createBlock("same"),
      ],
      message: "duplicate temp id",
    },
    {
      name: "forward parent temp refs",
      operations: [
        { ...createBlock("child"), parentTempId: "parent" },
        createBlock("parent"),
      ],
      message: "forward temp id",
    },
    {
      name: "forward block refs",
      operations: [
        { op: "update_block_text" as const, blockId: "later", text: "bad" },
        createBlock("later"),
      ],
      message: "forward temp id",
    },
    {
      name: "blocks outside the page",
      operations: [
        { op: "update_block_text" as const, blockId: "other-page-block", text: "bad" },
      ],
      message: "block not found in page",
    },
  ])("rejects $name without changing the source document", ({ operations, message }) => {
    const core = createCore();
    const created = createPage(core);
    expect(() => core.mutate(created.document, {
      pageId: "page-1",
      expectedVersion: 1,
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      idempotencyKey: `batch_page_operations:session-1:${message}`,
      command: { type: "batch_operations", operations },
    })).toThrow(message);
    expect(readPageYDocReplica("page-1", created.document).page.mutationVersion).toBe(1);
  });

  it("rejects self/descendant moves and non-checklist check state", () => {
    const core = createCore();
    const seeded = core.mutate(createPage(core).document, {
      pageId: "page-1",
      expectedVersion: 1,
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      idempotencyKey: "batch_page_operations:session-1:seed",
      command: {
        type: "batch_operations",
        operations: [
          createBlock("root"),
          { ...createBlock("child"), parentTempId: "root" },
          createBlock("paragraph"),
        ],
      },
    });
    const { root, child, paragraph } = seeded.tempIdMapping;

    expect(() => core.mutate(seeded.document, {
      pageId: "page-1",
      expectedVersion: 2,
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      idempotencyKey: "move_block:session-1:cycle",
      command: { type: "move_block", blockId: root!, parentId: child!, afterBlockId: null },
    })).toThrow("descendant");
    expect(() => core.mutate(seeded.document, {
      pageId: "page-1",
      expectedVersion: 2,
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      idempotencyKey: "set_check_state:session-1:paragraph",
      command: { type: "set_check_state", blockId: paragraph!, checked: true },
    })).toThrow("checklist");
  });

  it("deletes a complete subtree and supports the remaining operation inventory", () => {
    const core = createCore();
    const seeded = core.mutate(createPage(core).document, {
      pageId: "page-1",
      expectedVersion: 1,
      actor: { actorKind: "agent", actorSessionId: "session-1" },
      idempotencyKey: "batch_page_operations:session-1:inventory-seed",
      command: {
        type: "batch_operations",
        operations: [
          createBlock("root"),
          { ...createBlock("child"), parentTempId: "root" },
        ],
      },
    });
    const root = seeded.tempIdMapping.root!;
    const child = seeded.tempIdMapping.child!;

    const typed = core.mutate(seeded.document, mutation(2, {
      type: "update_block_type_and_properties",
      blockId: child,
      blockType: "checklist",
      properties: { checked: false },
    }, "type"));
    const checked = core.mutate(typed.document, mutation(3, {
      type: "set_check_state",
      blockId: child,
      checked: true,
    }, "check"));
    const moved = core.mutate(checked.document, mutation(4, {
      type: "move_block",
      blockId: child,
      parentId: null,
      afterBlockId: root,
    }, "move"));
    const replaced = core.mutate(moved.document, mutation(5, {
      type: "replace_page_markdown",
      blocks: [{
        id: "replacement",
        parentId: null,
        positionKey: "a0",
        type: "paragraph",
        text: "Replacement",
        properties: {},
        collapsed: false,
      }],
    }, "replace"));
    const archived = core.mutate(replaced.document, mutation(6, {
      type: "archive_page",
    }, "archive"));
    const unarchived = core.mutate(archived.document, mutation(7, {
      type: "unarchive_page",
    }, "unarchive"));
    const deleted = core.mutate(unarchived.document, mutation(8, {
      type: "delete_block_subtree",
      blockId: "replacement",
    }, "delete"));

    expect(deleted.resultVersion).toBe(9);
    expect(deleted.replica.blocks).toEqual([]);
    expect(deleted.replica.page.archived).toBe(false);
  });

  it("requires valid actor provenance and idempotency keys", () => {
    const core = createCore();
    expect(() => core.createPage({
      page: { id: "page-1", title: "Page", dailyDate: null, metadata: {} },
      actor: { actorKind: "agent", actorSessionId: "" },
      idempotencyKey: "create_page:missing:actor",
    })).toThrow(PageMutationValidationError);
    expect(() => core.createPage({
      page: { id: "page-1", title: "Page", dailyDate: null, metadata: {} },
      actor: { actorKind: "user", actorUserId: "user-1" },
      idempotencyKey: "",
    })).toThrow("idempotency");
  });
});

function createBlock(tempId: string) {
  return {
    op: "create_block" as const,
    tempId,
    parentId: null,
    parentTempId: null,
    afterBlockId: null,
    afterTempId: null,
    blockType: "paragraph",
    text: tempId,
    properties: {},
  };
}

function mutation(
  expectedVersion: number,
  command: Parameters<PageMutationCore["mutate"]>[1]["command"],
  request: string,
): Parameters<PageMutationCore["mutate"]>[1] {
  return {
    pageId: "page-1",
    expectedVersion,
    command,
    actor: { actorKind: "agent", actorSessionId: "session-1" },
    idempotencyKey: `${command.type}:session-1:${request}`,
  };
}

import { describe, expect, it } from "vitest";

import { planPageBlockTransfer } from "../../src/page/page_block_transfer.js";
import { PageMutationCore } from "../../src/page/page_mutation_core.js";
import type { PageYjsReplica } from "../../src/page/page_yjs_model.js";

describe("page block transfer planning", () => {
  it("moves a mixed block forest across pages without changing identity or content", () => {
    const source = replica("source", [
      block("before", null, "a", "paragraph", "Before"),
      block("session", null, "b", "session_ref", "", { sessionId: "sess-1", primary: true }),
      block("child", "session", "a", "checklist", "Task", { checked: true }, true),
      block("after", null, "c", "paragraph", "After"),
    ]);
    const target = replica("target", [block("target-anchor", null, "a", "paragraph", "Target")]);

    const plan = planPageBlockTransfer({
      source,
      target,
      selectedBlockIds: ["session"],
      targetPlacement: { parentId: null, afterBlockId: "target-anchor" },
    });

    expect(plan.sourceOperations).toEqual([
      { op: "delete_block_subtree", blockId: "session" },
    ]);
    expect(plan.targetOperations).toEqual([
      expect.objectContaining({
        op: "create_block",
        id: "session",
        tempId: "transfer-session",
        parentId: null,
        afterBlockId: "target-anchor",
        blockType: "session_ref",
        properties: { sessionId: "sess-1", primary: true },
      }),
      expect.objectContaining({
        op: "create_block",
        id: "child",
        tempId: "transfer-child",
        parentId: "session",
        afterBlockId: null,
        blockType: "checklist",
        text: "Task",
        properties: { checked: true },
        collapsed: true,
      }),
    ]);
    expect(plan.primarySessionIds).toEqual(["sess-1"]);
  });

  it("replaces an extracted forest with one exact page mount at the original position", () => {
    const source = replica("source", [
      block("before", null, "a", "paragraph", "Before"),
      block("first", null, "b", "paragraph", "First"),
      block("second", null, "c", "paragraph", "Second"),
    ]);

    const plan = planPageBlockTransfer({
      source,
      target: null,
      selectedBlockIds: ["first", "second"],
      targetPlacement: { parentId: null, afterBlockId: null },
      sourceMount: { title: "Extracted page", tempId: "extract-mount" },
    });

    expect(plan.sourceOperations).toEqual([
      expect.objectContaining({
        op: "create_block",
        tempId: "extract-mount",
        parentId: null,
        afterBlockId: "before",
        blockType: "paragraph",
        text: "[[Extracted page]]",
      }),
      { op: "delete_block_subtree", blockId: "first" },
      { op: "delete_block_subtree", blockId: "second" },
    ]);
  });

  it("uses move operations for a same-page cut and keeps the selected root order", () => {
    const page = replica("page", [
      block("target", null, "a", "paragraph", "Target"),
      block("first", null, "b", "paragraph", "First"),
      block("second", null, "c", "session_ref", "", { sessionId: "sess-2", primary: false }),
    ]);

    const plan = planPageBlockTransfer({
      source: page,
      target: page,
      selectedBlockIds: ["first", "second"],
      targetPlacement: { parentId: "target", afterBlockId: null },
    });

    expect(plan.sourceOperations).toEqual([
      { op: "move_block", blockId: "first", parentId: "target", afterBlockId: null },
      { op: "move_block", blockId: "second", parentId: "target", afterBlockId: "first" },
    ]);
    expect(plan.targetOperations).toEqual([]);
  });

  it("moves a contiguous outline range that starts inside one subtree and ends at a root", () => {
    const source = replica("source", [
      block("parent", null, "a", "paragraph", "Parent"),
      block("child", "parent", "a", "paragraph", "Child"),
      block("next-root", null, "b", "session_ref", "", { sessionId: "sess-3", primary: false }),
      block("after", null, "c", "paragraph", "After"),
    ]);

    const plan = planPageBlockTransfer({
      source,
      target: replica("target", []),
      selectedBlockIds: ["child", "next-root"],
      targetPlacement: { parentId: null, afterBlockId: null },
    });

    expect(plan.sourceOperations).toEqual([
      { op: "delete_block_subtree", blockId: "child" },
      { op: "delete_block_subtree", blockId: "next-root" },
    ]);
    expect(plan.targetOperations.map((operation) => (
      operation.op === "create_block" ? [operation.id, operation.parentId] : null
    ))).toEqual([["child", null], ["next-root", null]]);
  });

  it("round-trips attributed Y.Text deltas without losing the page-ref target identity", () => {
    const attributed = {
      ...block("rich", null, "a", "paragraph", "[[Stable target]]"),
      textDelta: [{
        insert: "[[Stable target]]",
        attributes: { ref: { kind: "page", targetId: "stable-page-id" } },
      }],
    };
    const plan = planPageBlockTransfer({
      source: replica("source", [attributed]),
      target: null,
      selectedBlockIds: ["rich"],
      targetPlacement: { parentId: null, afterBlockId: null },
    });
    const application = new PageMutationCore().createPage({
      page: { id: "target", title: "Target", dailyDate: null, metadata: {} },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "page-transfer:test:delta-round-trip",
      initialCommand: { type: "batch_operations", operations: plan.targetOperations },
    });

    expect(plan.targetOperations[0]).toMatchObject({
      op: "create_block",
      textDelta: attributed.textDelta,
    });
    expect(application.replica.blocks[0]).toMatchObject({
      id: "rich",
      text: "[[Stable target]]",
      textDelta: attributed.textDelta,
    });
  });

  it("rejects an extract mount that does not identify the exact target page", () => {
    const source = replica("source", [block("selected", null, "a", "paragraph", "Selected")]);
    const target = replica("target", []);

    expect(() => planPageBlockTransfer({
      source,
      target,
      selectedBlockIds: ["selected"],
      targetPlacement: { parentId: null, afterBlockId: null },
      sourceMount: { title: "Different", tempId: "mount" },
    })).toThrow("must match the target page title");
    expect(() => planPageBlockTransfer({
      source,
      target: null,
      selectedBlockIds: ["selected"],
      targetPlacement: { parentId: null, afterBlockId: null },
      sourceMount: { title: "Bad ]] title", tempId: "mount" },
    })).toThrow("exact page mount");
  });
});

function replica(pageId: string, blocks: PageYjsReplica["blocks"]): PageYjsReplica {
  return {
    page: {
      id: pageId,
      title: pageId,
      dailyDate: null,
      mutationVersion: 3,
      archived: false,
      metadata: {},
    },
    blocks,
  };
}

function block(
  id: string,
  parentId: string | null,
  positionKey: string,
  type: string,
  text: string,
  properties: Record<string, unknown> = {},
  collapsed = false,
): PageYjsReplica["blocks"][number] {
  return { id, parentId, positionKey, type, text, textDelta: text ? [{ insert: text }] : [], properties, collapsed };
}

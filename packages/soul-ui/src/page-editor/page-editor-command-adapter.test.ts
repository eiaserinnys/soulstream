import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { PageApiError, type ApplyPageOperationsInput, type PageApiClient } from "../page/page-api";
import {
  executePageEditorOperation,
  mapEditorPlanToPageOperations,
} from "./page-editor-command-adapter";

const blocks = [
  { id: "a", pageId: "page-1", parentId: null, positionKey: "a0", collapsed: false, type: "paragraph", text: "Alpha", properties: {} },
  { id: "b", pageId: "page-1", parentId: null, positionKey: "a1", collapsed: false, type: "paragraph", text: "Beta", properties: {} },
] as const;

describe("page editor command adapter", () => {
  it("maps editor-core split intent to one HTTP batch with live CAS inputs", async () => {
    const doc = new Y.Doc();
    doc.getText("clock").insert(0, "live");
    const api = createApi();

    const result = await executePageEditorOperation({
      apiClient: api,
      pageId: "page-1",
      doc,
      mutationVersion: 4,
      blocks,
      operation: {
        type: "splitBlock",
        blockId: "a",
        selection: { anchor: 2, focus: 2 },
        newBlockTempId: "split-1",
      },
      idempotencyKey: "editor-op-1",
    });

    expect(api.applyOperations).toHaveBeenCalledTimes(1);
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", {
      expectedVersion: 4,
      expectedStateVector: Y.encodeStateVector(doc),
      idempotencyKey: "editor-op-1",
      operations: [
        { op: "update_block_text", block_id: "a", text: "Al" },
        {
          op: "create_block",
          temp_id: "split-1",
          parent_id: null,
          after_block_id: "a",
          block_type: "paragraph",
          text: "pha",
          properties: {},
          collapsed: false,
        },
      ],
    });
    expect(result.focus).toEqual({ blockId: "created-1", anchor: 0, focus: 0 });
  });

  it("maps temporary parent and sibling references without exposing them as persisted ids", () => {
    expect(mapEditorPlanToPageOperations({
      intents: [
        {
          type: "create-block",
          tempId: "parent",
          parent: null,
          after: null,
          blockType: "paragraph",
          text: "Parent",
          properties: {},
          collapsed: false,
        },
        {
          type: "create-block",
          tempId: "child",
          parent: { kind: "temporary", tempId: "parent" },
          after: { kind: "temporary", tempId: "sibling" },
          blockType: "paragraph",
          text: "Child",
          properties: {},
          collapsed: false,
        },
      ],
      focus: null,
    })).toEqual([
      expect.objectContaining({ temp_id: "parent", parent_id: null, after_block_id: null }),
      expect.objectContaining({
        temp_id: "child",
        parent_id: null,
        parent_temp_id: "parent",
        after_block_id: null,
        after_temp_id: "sibling",
      }),
    ]);
  });

  it("surfaces a 409 conflict without retrying the stale intent", async () => {
    const api = createApi({
      applyOperations: vi.fn(async () => {
        throw new PageApiError("state vector conflict", 409, "conflict");
      }),
    });
    await expect(executePageEditorOperation({
      apiClient: api,
      pageId: "page-1",
      doc: new Y.Doc(),
      mutationVersion: 4,
      blocks,
      operation: { type: "indent", blockIds: ["b"] },
      idempotencyKey: "editor-op-conflict",
    })).rejects.toMatchObject({ kind: "conflict" });
    expect(api.applyOperations).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "merge previous",
      { type: "mergePrevious", blockId: "b", selection: { anchor: 0, focus: 0 } } as const,
      [
        { op: "update_block_text", block_id: "a", text: "AlphaBeta" },
        { op: "delete_block_subtree", block_id: "b" },
      ],
    ],
    [
      "merge next",
      { type: "mergeNext", blockId: "a", selection: { anchor: 5, focus: 5 } } as const,
      [
        { op: "update_block_text", block_id: "a", text: "AlphaBeta" },
        { op: "delete_block_subtree", block_id: "b" },
      ],
    ],
    [
      "delete selection",
      { type: "deleteSelection", blockIds: ["a", "b"] } as const,
      [
        { op: "delete_block_subtree", block_id: "a" },
        { op: "delete_block_subtree", block_id: "b" },
      ],
    ],
    [
      "paste",
      { type: "paste", blockId: "a", selection: { anchor: 5, focus: 5 }, payload: { kind: "block-tree", blocks: [{ text: "One", children: [] }, { text: "Two", children: [] }] }, tempIdPrefix: "paste" } as const,
      [
        { op: "update_block_text", block_id: "a", text: "AlphaOne" },
        expect.objectContaining({ op: "create_block", temp_id: "paste-1", after_block_id: "a", text: "Two" }),
      ],
    ],
  ])("maps %s through the core plan into one HTTP payload", async (_name, operation, expectedOperations) => {
    const api = createApi();
    await executePageEditorOperation({
      apiClient: api,
      pageId: "page-1",
      doc: new Y.Doc(),
      mutationVersion: 4,
      blocks,
      operation,
      idempotencyKey: `editor-op-${_name}`,
    });
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: expectedOperations,
    }));
  });
});

function createApi(overrides: Partial<PageApiClient> = {}): PageApiClient {
  return {
    listPages: vi.fn(),
    getPage: vi.fn(),
    getDailyPage: vi.fn(),
    setStarred: vi.fn(),
    applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => ({
      page: { id: "page-1", title: "Page", daily_date: null, version: 5, archived: false, metadata: {}, created_at: "", updated_at: "" },
      blocks: [],
      operation: { id: "operation-1" },
      temp_id_mapping: Object.fromEntries(input.operations.flatMap((operation) =>
        operation.op === "create_block" ? [[operation.temp_id, `created-${operation.temp_id === "split-1" ? "1" : operation.temp_id}`]] : [])),
    })),
    ...overrides,
  } as PageApiClient;
}

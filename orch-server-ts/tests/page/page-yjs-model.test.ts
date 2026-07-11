import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { parseBoardYjsDocumentName } from "../../src/board-yjs/board_yjs_model.js";
import {
  BLOCKS_MAP,
  PAGE_META_MAP,
  createPageYDocSnapshot,
  getPageYjsDocumentName,
  parsePageYjsDocumentName,
  readPageYDocReplica,
} from "../../src/page/page_yjs_model.js";

const page = {
  id: "page-1",
  title: "Daily notes",
  dailyDate: "2026-07-11",
  mutationVersion: 3,
  archived: false,
  metadata: { source: "test" },
};

describe("orch page Yjs model", () => {
  it("isolates page and board document namespaces", () => {
    expect(getPageYjsDocumentName("page-1")).toBe("page:page-1");
    expect(parsePageYjsDocumentName("page:page-1")).toBe("page-1");
    expect(parsePageYjsDocumentName("page:")).toBeNull();
    expect(parsePageYjsDocumentName("board:runbook:rb-1")).toBeNull();
    expect(parsePageYjsDocumentName("board-folder:folder-1")).toBeNull();
    expect(parseBoardYjsDocumentName("page:page-1")).toBeNull();
  });

  it("round-trips flat blocks, Y.Text ref attributes, and Y.Map properties", () => {
    const snapshot = createPageYDocSnapshot({
      page,
      blocks: [
        {
          id: "child",
          parentId: "root",
          positionKey: "b",
          type: "checklist",
          text: "See Page",
          textDelta: [
            { insert: "See " },
            {
              insert: "Page",
              attributes: { ref: { kind: "page", targetId: "page-2" } },
            },
          ],
          properties: { checked: false },
          collapsed: true,
        },
        {
          id: "root",
          parentId: null,
          positionKey: "a",
          type: "paragraph",
          text: "Root",
          properties: {},
          collapsed: false,
        },
      ],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot);

    expect(doc.getMap(PAGE_META_MAP).toJSON()).toEqual({
      schemaVersion: 1,
      id: "page-1",
      title: "Daily notes",
      dailyDate: "2026-07-11",
      mutationVersion: 3,
      archived: false,
      metadata: { source: "test" },
    });
    expect(doc.getMap(BLOCKS_MAP).get("child")).toBeInstanceOf(Y.Map);
    expect(readPageYDocReplica("page-1", doc)).toEqual({
      page,
      blocks: [
        expect.objectContaining({ id: "root", parentId: null, text: "Root" }),
        expect.objectContaining({
          id: "child",
          parentId: "root",
          text: "See Page",
          textDelta: [
            { insert: "See " },
            {
              insert: "Page",
              attributes: { ref: { kind: "page", targetId: "page-2" } },
            },
          ],
          properties: { checked: false },
        }),
      ],
    });
  });

  it.each([
    {
      name: "missing parent",
      blocks: [{ id: "a", parentId: "missing", positionKey: "a" }],
      message: "parent",
    },
    {
      name: "self cycle",
      blocks: [{ id: "a", parentId: "a", positionKey: "a" }],
      message: "cycle",
    },
    {
      name: "long cycle",
      blocks: [
        { id: "a", parentId: "c", positionKey: "a" },
        { id: "b", parentId: "a", positionKey: "b" },
        { id: "c", parentId: "b", positionKey: "c" },
      ],
      message: "cycle",
    },
    {
      name: "empty position",
      blocks: [{ id: "a", parentId: null, positionKey: "  " }],
      message: "positionKey",
    },
  ])("rejects $name", ({ blocks, message }) => {
    expect(() => createPageYDocSnapshot({
      page,
      blocks: blocks.map((block) => ({
        ...block,
        type: "paragraph",
        text: "",
        properties: {},
        collapsed: false,
      })),
    })).toThrow(message);
  });

  it("rejects a document whose pageMeta belongs to another page", () => {
    const doc = new Y.Doc();
    doc.getMap(PAGE_META_MAP).set("schemaVersion", 1);
    doc.getMap(PAGE_META_MAP).set("id", "page-2");
    doc.getMap(PAGE_META_MAP).set("title", "Other");
    doc.getMap(PAGE_META_MAP).set("dailyDate", null);
    doc.getMap(PAGE_META_MAP).set("mutationVersion", 1);
    doc.getMap(PAGE_META_MAP).set("archived", false);
    doc.getMap(PAGE_META_MAP).set("metadata", {});

    expect(() => readPageYDocReplica("page-1", doc)).toThrow("page id");
  });

  it("rejects duplicate block identities before encoding", () => {
    const block = {
      id: "same",
      parentId: null,
      positionKey: "a",
      type: "paragraph",
      text: "",
      properties: {},
      collapsed: false,
    };
    expect(() => createPageYDocSnapshot({ page, blocks: [block, block] }))
      .toThrow("duplicate block id");
  });
});

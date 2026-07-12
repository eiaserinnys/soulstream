import { describe, expect, it } from "vitest";

import {
  decodeStructuredClipboard,
  EditorOperationUnavailableError,
  encodeStructuredClipboard,
  parseClipboard,
  planEditorOperation,
  serializeBlockSelection,
  StaleEditorTargetError,
} from "../src/index.js";
import { createSnapshot, existing, project, temporary } from "./contract-fixtures.js";

describe("Serendipity-homologous indent/outdent fixtures", () => {
  it("T-01 no-ops indent on the first sibling", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b" }]);
    expect(planEditorOperation(snapshot, { type: "indent", blockIds: ["a"] }).intents).toEqual([]);
  });

  it("T-02 indents under the previous sibling as its last child", () => {
    const snapshot = createSnapshot([
      { id: "a" }, { id: "a-child", parentId: "a" }, { id: "b", text: "hello" }, { id: "c" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "indent",
      blockIds: ["b"],
      focus: { blockId: "b", selection: { anchor: 2, focus: 4 } },
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds("a")).toEqual(["a-child", "b"]);
    expect(state.childIds()).toEqual(["a", "c"]);
    expect(result.focus).toEqual({
      target: existing("b"),
      selection: { anchor: 2, focus: 4 },
    });
  });

  it("T-03 no-ops outdent on a root block", () => {
    const snapshot = createSnapshot([{ id: "a" }]);
    expect(planEditorOperation(snapshot, { type: "outdent", blockIds: ["a"] }).intents).toEqual([]);
  });

  it("T-04 outdents a child immediately after its parent", () => {
    const snapshot = createSnapshot([
      { id: "parent" }, { id: "after" }, { id: "a", parentId: "parent" },
      { id: "b", parentId: "parent" },
    ]);
    const result = planEditorOperation(snapshot, { type: "outdent", blockIds: ["a"] });
    const state = project(snapshot, result.intents);
    expect(state.childIds()).toEqual(["parent", "a", "after"]);
    expect(state.childIds("parent")).toEqual(["b"]);
  });

  it("T-05 indents a contiguous selected sibling group in relative order", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    const result = planEditorOperation(snapshot, {
      type: "indent",
      blockIds: ["b", "c"],
      focus: { blockId: "c", selection: { anchor: 10, focus: 10 } },
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds("a")).toEqual(["b", "c"]);
    expect(result.focus).toEqual({ target: existing("c"), selection: { anchor: 0, focus: 0 } });
  });

  it("T-06 no-ops a non-contiguous selected group", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    expect(() => planEditorOperation(snapshot, { type: "indent", blockIds: ["b", "d"] }))
      .toThrow(EditorOperationUnavailableError);
  });

  it("T-07 outdents a valid nested group in relative order", () => {
    const snapshot = createSnapshot([
      { id: "parent" }, { id: "after" },
      { id: "a", parentId: "parent" }, { id: "b", parentId: "parent" },
      { id: "c", parentId: "parent" },
    ]);
    const result = planEditorOperation(snapshot, { type: "outdent", blockIds: ["a", "b"] });
    const state = project(snapshot, result.intents);
    expect(state.childIds()).toEqual(["parent", "a", "b", "after"]);
    expect(state.childIds("parent")).toEqual(["c"]);
  });

  it("T-08 rejects a mixed-parent outdent group explicitly", () => {
    const snapshot = createSnapshot([{ id: "parent" }, { id: "a", parentId: "parent" }]);
    expect(() => planEditorOperation(snapshot, { type: "outdent", blockIds: ["parent", "a"] }))
      .toThrow(EditorOperationUnavailableError);
  });
});

describe("Serendipity-homologous clipboard/paste fixtures", () => {
  it("P-01 inserts single-line plain text into the selected range", () => {
    const snapshot = createSnapshot([{ id: "a", text: "hello world" }]);
    const result = planEditorOperation(snapshot, {
      type: "paste", blockId: "a", selection: { anchor: 6, focus: 11 },
      payload: parseClipboard({ plainText: "there" }),
    });
    expect(project(snapshot, result.intents).text("a")).toBe("hello there");
  });

  it("P-02 replaces an empty placeholder with multiline roots", () => {
    const snapshot = createSnapshot([{ id: "before" }, { id: "placeholder" }, { id: "after" }]);
    const result = planEditorOperation(snapshot, {
      type: "paste", blockId: "placeholder", selection: { anchor: 0, focus: 0 },
      payload: parseClipboard({ plainText: "a\nb\nc" }), tempIdPrefix: "p",
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds()).toEqual(["before", "placeholder", "p-1", "p-2", "after"]);
    expect([state.text("placeholder"), state.text("p-1"), state.text("p-2")]).toEqual(["a", "b", "c"]);
    expect(result.focus?.target).toEqual(temporary("p-2"));
  });

  it("P-03 preserves prefix and suffix around multiline paste", () => {
    const snapshot = createSnapshot([{ id: "a", text: "xxYY" }, { id: "after" }]);
    const result = planEditorOperation(snapshot, {
      type: "paste", blockId: "a", selection: { anchor: 2, focus: 2 },
      payload: parseClipboard({ plainText: "one\ntwo" }), tempIdPrefix: "p",
    });
    const state = project(snapshot, result.intents);
    expect([state.text("a"), state.text("p-1")]).toEqual(["xxone", "twoYY"]);
    expect(result.focus).toEqual({ target: temporary("p-1"), selection: { anchor: 3, focus: 3 } });
  });

  it("P-04 parses nested HTML lists into a clipboard tree", () => {
    expect(parseClipboard({ html: "<ul><li>A<ul><li>B</li></ul></li></ul>", plainText: "A\nB" })).toEqual({
      kind: "block-tree", blocks: [{ text: "A", children: [{ text: "B", children: [] }] }],
    });
  });

  it("P-05 emits parent/after temporary references for clipboard trees", () => {
    const snapshot = createSnapshot([{ id: "placeholder", text: "xxYY" }]);
    const result = planEditorOperation(snapshot, {
      type: "paste", blockId: "placeholder", selection: { anchor: 2, focus: 2 },
      payload: { kind: "block-tree", blocks: [{ text: "A", children: [{ text: "B", children: [] }] }] },
      tempIdPrefix: "p",
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds("placeholder")).toEqual(["p-1"]);
    expect(state.text("p-1")).toBe("B");
    expect(result.focus).toEqual({ target: existing("placeholder"), selection: { anchor: 3, focus: 3 } });
  });

  it("P-06 paste-over-selection creates a placeholder and deletes selected subtrees", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b" }, { id: "b-child", parentId: "b" }, { id: "c" }]);
    const result = planEditorOperation(snapshot, {
      type: "pasteOverSelection", blockIds: ["b"], placeholderTempId: "placeholder",
      payload: parseClipboard({ plainText: "x\ny" }), tempIdPrefix: "p",
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds()).toEqual(["a", "placeholder", "p-1", "c"]);
    expect(state.nodes.has("b-child")).toBe(false);
  });

  it("P-07 rejects files/media as an explicit unsupported clipboard", () => {
    const payload = parseClipboard({
      plainText: "ignored", html: '<img src="data:image/png;base64,aaa">', files: [{ type: "image/png" }],
    });
    expect(payload).toEqual({ kind: "unsupported", reason: "files-or-media" });
  });

  it("P-08 forcePlainText bypasses structured and HTML clipboard trees", () => {
    expect(parseClipboard({
      plainText: "a\nb", html: "<ul><li>x</li></ul>",
      structured: { blocks: [{ text: "y", children: [] }] }, forcePlainText: true,
    })).toEqual({ kind: "block-tree", blocks: [
      { text: "a", children: [] }, { text: "b", children: [] },
    ] });
  });

  it("P-09 serializes one immutable selection snapshot to plain text and structured MIME", () => {
    const snapshot = createSnapshot([
      { id: "a", text: "A" },
      { id: "b", text: "B", type: "checklist", properties: { checked: true } },
      { id: "b-child", parentId: "b", text: "B child", properties: { tone: "quiet" } },
      { id: "c", text: "C" },
    ]);
    const before = structuredClone(snapshot);

    const payload = serializeBlockSelection(snapshot, ["b", "b-child", "c"]);
    const roundTrip = decodeStructuredClipboard(encodeStructuredClipboard(payload.structured));

    expect(payload.plainText).toBe("B\nB child\nC");
    expect(roundTrip.blocks).toEqual([
      {
        text: "B",
        type: "checklist",
        properties: { checked: true },
        collapsed: false,
        children: [{
          text: "B child",
          type: "paragraph",
          properties: { tone: "quiet" },
          collapsed: false,
          children: [],
        }],
      },
      {
        text: "C",
        type: "paragraph",
        properties: {},
        collapsed: false,
        children: [],
      },
    ]);
    expect(snapshot).toEqual(before);
  });

  it("P-10 restores structured type and properties when pasting into a blank block", () => {
    const snapshot = createSnapshot([{ id: "blank" }]);
    const payload = parseClipboard({ structured: {
      blocks: [{
        text: "Task",
        type: "checklist",
        properties: { checked: true },
        collapsed: false,
        children: [{
          text: "Child",
          type: "paragraph",
          properties: { tone: "quiet" },
          collapsed: true,
          children: [],
        }],
      }],
    } });
    const result = planEditorOperation(snapshot, {
      type: "paste",
      blockId: "blank",
      selection: { anchor: 0, focus: 0 },
      payload,
      tempIdPrefix: "p",
    });

    expect(result.intents).toEqual([
      { type: "update-text", target: existing("blank"), text: "Task" },
      {
        type: "update-type-and-properties",
        target: existing("blank"),
        blockType: "checklist",
        properties: { checked: true },
      },
      {
        type: "create-block",
        tempId: "p-1",
        parent: existing("blank"),
        after: null,
        blockType: "paragraph",
        text: "Child",
        properties: { tone: "quiet" },
        collapsed: true,
      },
    ]);
  });

  it("P-11 uses the same structured metadata contract for paste-over-selection", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const result = planEditorOperation(snapshot, {
      type: "pasteOverSelection",
      blockIds: ["b"],
      placeholderTempId: "replacement",
      tempIdPrefix: "p",
      payload: {
        kind: "block-tree",
        blocks: [{
          text: "Task",
          type: "checklist",
          properties: { checked: false },
          collapsed: false,
          children: [{
            text: "Child",
            type: "paragraph",
            properties: { tone: "quiet" },
            collapsed: true,
            children: [],
          }],
        }],
      },
    });

    expect(result.intents[0]).toMatchObject({
      type: "create-block",
      tempId: "replacement",
      blockType: "checklist",
      properties: { checked: false },
    });
    expect(result.intents).toContainEqual(expect.objectContaining({
      type: "create-block",
      tempId: "p-1",
      blockType: "paragraph",
      properties: { tone: "quiet" },
      collapsed: true,
    }));
  });

  it("P-12 replaces a flat parent-child-sibling range at its first structural position", () => {
    const snapshot = createSnapshot([
      { id: "a" },
      { id: "b" },
      { id: "b-1", parentId: "b" },
      { id: "b-2", parentId: "b" },
      { id: "c" },
      { id: "d" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "pasteOverSelection",
      blockIds: ["b", "b-1", "b-2", "c"],
      placeholderTempId: "replacement",
      payload: parseClipboard({ plainText: "Replacement" }),
    });

    expect(result.intents).toEqual([
      expect.objectContaining({ type: "create-block", tempId: "replacement", after: existing("a") }),
      { type: "delete-subtree", target: existing("b") },
      { type: "delete-subtree", target: existing("c") },
    ]);
  });
});

describe("Serendipity-homologous contiguous selection deletion", () => {
  it("M-01 deletes contiguous selected subtrees and focuses the next block", () => {
    const snapshot = createSnapshot([
      { id: "a" }, { id: "b" }, { id: "b-child", parentId: "b" }, { id: "c" }, { id: "d" },
    ]);
    const result = planEditorOperation(snapshot, { type: "deleteSelection", blockIds: ["b", "c"] });
    expect(project(snapshot, result.intents).childIds()).toEqual(["a", "d"]);
    expect(result.focus).toEqual({ target: existing("d"), selection: { anchor: 0, focus: 0 } });
  });

  it("M-02 falls back to the previous block when deletion reaches the end", () => {
    const snapshot = createSnapshot([{ id: "a", text: "aaa" }, { id: "b" }, { id: "c" }]);
    const result = planEditorOperation(snapshot, { type: "deleteSelection", blockIds: ["b", "c"] });
    expect(result.focus).toEqual({ target: existing("a"), selection: { anchor: 3, focus: 3 } });
  });

  it("M-03 rejects non-contiguous selection deletion explicitly", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(() => planEditorOperation(snapshot, { type: "deleteSelection", blockIds: ["a", "c"] }))
      .toThrow(EditorOperationUnavailableError);
  });

  it("M-04 no-ops an empty selection", () => {
    const snapshot = createSnapshot([{ id: "a" }]);
    expect(planEditorOperation(snapshot, { type: "deleteSelection", blockIds: [] })).toMatchObject({
      intents: [], focus: null,
    });
  });

  it("M-05 rejects a queued intent whose target disappeared", () => {
    const snapshot = createSnapshot([{ id: "a" }]);
    expect(() => planEditorOperation(snapshot, {
      type: "outdent",
      blockIds: ["missing"],
      focus: { blockId: "missing", selection: { anchor: 2, focus: 2 } },
    })).toThrow(StaleEditorTargetError);
  });

  it("M-06 deletes a flat parent-child-sibling selection exactly once per selected root", () => {
    const snapshot = createSnapshot([
      { id: "a" },
      { id: "b" },
      { id: "b-1", parentId: "b" },
      { id: "b-2", parentId: "b" },
      { id: "c" },
      { id: "d" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "deleteSelection",
      blockIds: ["b", "b-1", "b-2", "c"],
    });

    expect(result.intents).toEqual([
      { type: "delete-subtree", target: existing("b") },
      { type: "delete-subtree", target: existing("c") },
    ]);
    expect(project(snapshot, result.intents).childIds()).toEqual(["a", "d"]);
    expect(result.focus).toEqual({ target: existing("d"), selection: { anchor: 0, focus: 0 } });
  });
});

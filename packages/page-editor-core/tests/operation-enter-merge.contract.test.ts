import { describe, expect, it } from "vitest";

import { planEditorOperation, type EditorBlockSnapshot } from "../src/index.js";
import { createSnapshot, existing, project, temporary } from "./contract-fixtures.js";

describe("editor-core contract and positionKey ordering", () => {
  it("O-01 returns an explicit noop without mutating the immutable snapshot", () => {
    const snapshot = createSnapshot([{ id: "a", text: "alpha" }]);
    const before = structuredClone(snapshot);
    expect(planEditorOperation(snapshot, { type: "noop", reason: "native" })).toEqual({
      intents: [],
      focus: null,
      noopReason: "native",
    });
    expect(snapshot).toEqual(before);
  });

  it("O-02 sorts siblings by positionKey and then id", () => {
    const snapshot = createSnapshot([
      { id: "c", text: "C", positionKey: "m" },
      { id: "b", text: "B", positionKey: "a" },
      { id: "a", text: "A", positionKey: "a" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "mergePrevious",
      blockId: "c",
      selection: { anchor: 0, focus: 0 },
    });
    expect(result.intents[0]).toEqual({ type: "update-text", target: existing("b"), text: "BC" });
  });

  it("O-03 exposes no persisted/public order number", () => {
    type HasOrder = EditorBlockSnapshot & { order?: never };
    const block: HasOrder = createSnapshot([{ id: "a" }])[0]!;
    expect("order" in block).toBe(false);
  });
});

describe("Serendipity-homologous Enter fixtures", () => {
  it("E-00 splits at the start and keeps the new sibling after the current block", () => {
    const snapshot = createSnapshot([{ id: "a", text: "abcdef", positionKey: "V" }]);
    const result = planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "a",
      selection: { anchor: 0, focus: 0 },
      newBlockTempId: "b",
    });

    const state = project(snapshot, result.intents);
    expect([state.text("a"), state.text("b")]).toEqual(["", "abcdef"]);
    expect(state.childIds()).toEqual(["a", "b"]);
    expect(result.intents).toContainEqual(expect.objectContaining({
      type: "create-block",
      tempId: "b",
      after: existing("a"),
    }));
    expect(result.focus).toEqual({ target: temporary("b"), selection: { anchor: 0, focus: 0 } });
  });

  it("E-01 splits abc|def and focuses the new sibling", () => {
    const snapshot = createSnapshot([{ id: "a", text: "abcdef" }]);
    const result = planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "a",
      selection: { anchor: 3, focus: 3 },
      newBlockTempId: "b",
    });
    const state = project(snapshot, result.intents);
    expect(state.text("a")).toBe("abc");
    expect(state.text("b")).toBe("def");
    expect(state.childIds()).toEqual(["a", "b"]);
    expect(result.focus).toEqual({ target: temporary("b"), selection: { anchor: 0, focus: 0 } });
  });

  it("E-02 removes a selected range before splitting", () => {
    const snapshot = createSnapshot([{ id: "a", text: "abcdef" }]);
    const result = planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "a",
      selection: { anchor: 2, focus: 4 },
      newBlockTempId: "b",
    });
    const state = project(snapshot, result.intents);
    expect([state.text("a"), state.text("b")]).toEqual(["ab", "ef"]);
  });

  it("E-03 outdents an empty indented block instead of creating another block", () => {
    const snapshot = createSnapshot([
      { id: "parent", text: "parent" },
      { id: "after", text: "after" },
      { id: "empty", parentId: "parent" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "empty",
      selection: { anchor: 0, focus: 0 },
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds()).toEqual(["parent", "empty", "after"]);
    expect(result.focus?.target).toEqual(existing("empty"));
  });

  it("E-04 creates an empty sibling for an empty root block", () => {
    const snapshot = createSnapshot([{ id: "a" }]);
    const result = planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "a",
      selection: { anchor: 0, focus: 0 },
      newBlockTempId: "b",
    });
    expect(project(snapshot, result.intents).childIds()).toEqual(["a", "b"]);
  });

  it("E-05 creates an empty sibling at the end of non-empty text", () => {
    const snapshot = createSnapshot([{ id: "a", text: "abc" }]);
    const result = planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "a",
      selection: { anchor: 3, focus: 3 },
      newBlockTempId: "b",
    });
    const state = project(snapshot, result.intents);
    expect([state.text("a"), state.text("b")]).toEqual(["abc", ""]);
    expect(state.childIds()).toEqual(["a", "b"]);
    expect(result.focus).toEqual({ target: temporary("b"), selection: { anchor: 0, focus: 0 } });
  });

  it("E-06 leaves Enter on the native path during IME composition", () => {
    const snapshot = createSnapshot([{ id: "a", text: "abc" }]);
    expect(planEditorOperation(snapshot, {
      type: "splitBlock",
      blockId: "a",
      selection: { anchor: 1, focus: 1 },
      isComposing: true,
    })).toMatchObject({ intents: [], focus: null, noopReason: "composition" });
  });
});

describe("Serendipity-homologous Backspace/Delete fixtures", () => {
  it("B-01 merges current text into the previous editable block", () => {
    const snapshot = createSnapshot([{ id: "a", text: "aaa" }, { id: "b", text: "bbb" }]);
    const result = planEditorOperation(snapshot, {
      type: "mergePrevious", blockId: "b", selection: { anchor: 0, focus: 0 },
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds()).toEqual(["a"]);
    expect(state.text("a")).toBe("aaabbb");
    expect(result.focus).toEqual({ target: existing("a"), selection: { anchor: 3, focus: 3 } });
  });

  it("B-02 preserves current children under the previous visible block after merge", () => {
    const snapshot = createSnapshot([
      { id: "a", text: "aaa" },
      { id: "a-child", parentId: "a" },
      { id: "b", text: "bbb" },
      { id: "b-child", parentId: "b" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "mergePrevious", blockId: "b", selection: { anchor: 0, focus: 0 },
    });
    const state = project(snapshot, result.intents);
    expect(state.childIds("a")).toEqual(["a-child"]);
    expect(state.childIds("a-child")).toEqual(["b-child"]);
  });

  it("B-03 deletes an empty block and recovers focus on the previous block", () => {
    const snapshot = createSnapshot([{ id: "a", text: "aaa" }, { id: "b" }, { id: "c" }]);
    const result = planEditorOperation(snapshot, {
      type: "mergePrevious", blockId: "b", selection: { anchor: 0, focus: 0 },
    });
    expect(project(snapshot, result.intents).childIds()).toEqual(["a", "c"]);
    expect(result.focus?.target).toEqual(existing("a"));
  });

  it("B-04 no-ops at the first block start", () => {
    const snapshot = createSnapshot([{ id: "a", text: "aaa" }]);
    expect(planEditorOperation(snapshot, {
      type: "mergePrevious", blockId: "a", selection: { anchor: 0, focus: 0 },
    })).toMatchObject({ intents: [], focus: null });
  });

  it("B-05 forward Delete merges the next block and preserves both child groups", () => {
    const snapshot = createSnapshot([
      { id: "a", text: "aaa" }, { id: "a-child", parentId: "a" },
      { id: "b", text: "bbb" }, { id: "b-child", parentId: "b" },
    ]);
    const result = planEditorOperation(snapshot, {
      type: "mergeNext", blockId: "a", selection: { anchor: 3, focus: 3 },
    });
    const state = project(snapshot, result.intents);
    expect(state.text("a")).toBe("aaabbb");
    expect(state.childIds("a")).toEqual(["a-child", "b-child"]);
  });

  it("B-06 leaves non-edge Backspace to native deletion", () => {
    const snapshot = createSnapshot([{ id: "a" }, { id: "b", text: "bbb" }]);
    expect(planEditorOperation(snapshot, {
      type: "mergePrevious", blockId: "b", selection: { anchor: 1, focus: 1 },
    })).toMatchObject({ intents: [], focus: null, noopReason: "not-at-start" });
  });

  it("B-07 leaves non-edge Delete to native deletion", () => {
    const snapshot = createSnapshot([{ id: "a", text: "aaa" }, { id: "b" }]);
    expect(planEditorOperation(snapshot, {
      type: "mergeNext", blockId: "a", selection: { anchor: 1, focus: 1 },
    })).toMatchObject({ intents: [], focus: null, noopReason: "not-at-end" });
  });

  it("B-08 leaves Backspace and Delete on the native path during composition", () => {
    const snapshot = createSnapshot([{ id: "a", text: "a" }, { id: "b", text: "b" }]);
    expect(planEditorOperation(snapshot, {
      type: "mergePrevious", blockId: "b", selection: { anchor: 0, focus: 0 }, isComposing: true,
    }).noopReason).toBe("composition");
    expect(planEditorOperation(snapshot, {
      type: "mergeNext", blockId: "a", selection: { anchor: 1, focus: 1 }, isComposing: true,
    }).noopReason).toBe("composition");
  });

  it("B-09 merges into the previous visible descendant instead of its parent", () => {
    const snapshot = createSnapshot([
      { id: "parent", text: "Parent" },
      { id: "child", parentId: "parent", text: "Child" },
      { id: "after", text: "After" },
    ]);

    const result = planEditorOperation(snapshot, {
      type: "mergePrevious",
      blockId: "after",
      selection: { anchor: 0, focus: 0 },
    });

    const state = project(snapshot, result.intents);
    expect(state.text("parent")).toBe("Parent");
    expect(state.text("child")).toBe("ChildAfter");
    expect(state.childIds()).toEqual(["parent"]);
    expect(result.focus).toEqual({
      target: existing("child"),
      selection: { anchor: 5, focus: 5 },
    });
  });
});

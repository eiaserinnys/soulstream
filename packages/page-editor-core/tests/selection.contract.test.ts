import { describe, expect, it } from "vitest";

import {
  applyFocusSelection,
  createCompositionGuard,
  createContiguousBlockSelection,
  createPostRenderFocusSelectionApplier,
  decideHorizontalEdgeNavigation,
  decideVerticalEdgeNavigation,
  type FocusSelectionHost,
  type FocusableTextControl,
  type SelectionScheduler,
} from "../src/index.js";

function control(value: string): FocusableTextControl & { focused: boolean; selected: [number, number] | null } {
  return {
    value, focused: false, selected: null,
    focus() { this.focused = true; },
    setSelectionRange(start, end) { this.selected = [start, end]; },
  };
}

function metrics(line: "first" | "middle" | "last") {
  const positions: Record<"first" | "middle" | "last", readonly [number, number]> = {
    first: [0, 10], middle: [20, 30], last: [40, 50],
  };
  const caret = positions[line];
  return { caretTop: caret[0], caretBottom: caret[1], firstLineTop: 0, firstLineBottom: 10, lastLineTop: 40, lastLineBottom: 50 };
}

function manualScheduler(): SelectionScheduler & { flushMicrotasks(): void; flushFrames(): void } {
  const microtasks: Array<() => void> = [];
  const frames = new Map<number, () => void>();
  let handle = 0;
  return {
    queueMicrotask(callback) { microtasks.push(callback); },
    requestAnimationFrame(callback) { handle += 1; frames.set(handle, callback); return handle; },
    cancelAnimationFrame(id) { frames.delete(id); },
    flushMicrotasks() { while (microtasks.length > 0) microtasks.shift()?.(); },
    flushFrames() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("Serendipity-homologous selection and IME fixtures", () => {
  it("B-01 expands four blocks, contracts, and crosses the stable anchor", () => {
    const selection = createContiguousBlockSelection(["a", "b", "c", "d", "e"]);
    selection.select("b");
    selection.extendBy(1);
    selection.extendBy(1);
    selection.extendBy(1);
    expect(selection.getSnapshot()).toEqual({
      anchorId: "b",
      focusId: "e",
      blockIds: ["b", "c", "d", "e"],
    });
    selection.extendBy(-1);
    selection.extendBy(-1);
    selection.extendBy(-1);
    selection.extendBy(-1);
    expect(selection.getSnapshot()).toEqual({
      anchorId: "b",
      focusId: "a",
      blockIds: ["a", "b"],
    });
  });

  it("B-02 selects the whole visible page, including atomic card boundaries", () => {
    const selection = createContiguousBlockSelection([
      "session-card-first",
      "text-middle",
      "session-card-last",
    ]);

    selection.selectAll();

    expect(selection.getSnapshot()).toEqual({
      anchorId: "session-card-first",
      focusId: "session-card-last",
      blockIds: ["session-card-first", "text-middle", "session-card-last"],
    });
  });

  it("B-03 ranges only across the visible order when a collapsed subtree is hidden", () => {
    const selection = createContiguousBlockSelection([
      "collapsed-parent",
      "session-card-after-subtree",
      "text-last",
    ]);
    selection.select("collapsed-parent");

    selection.extend("session-card-after-subtree");

    expect(selection.getSnapshot().blockIds).toEqual([
      "collapsed-parent",
      "session-card-after-subtree",
    ]);
  });

  it("B-04 preserves a surviving anchor and clamps a removed focus after projection", () => {
    const selection = createContiguousBlockSelection(["text-first", "session-card", "text-last"]);
    selection.select("text-first");
    selection.extend("session-card");

    selection.replaceBlockOrder(["text-first", "text-last"]);

    expect(selection.getSnapshot()).toEqual({
      anchorId: "text-first",
      focusId: "text-first",
      blockIds: ["text-first"],
    });
  });

  it("S-01 applies focus by block id", () => {
    const target = control("abcdef");
    const host: FocusSelectionHost = { getTextControlByBlockId: (id) => id === "target" ? target : null };
    expect(applyFocusSelection(host, { target: { kind: "existing", blockId: "target" }, selection: { anchor: 2, focus: 4 } })).toBe(true);
    expect(target.selected).toEqual([2, 4]);
  });

  it("S-02 applies only the latest pending focus request", () => {
    const target = control("abcdef");
    const scheduler = manualScheduler();
    const applier = createPostRenderFocusSelectionApplier({ getTextControlByBlockId: () => target }, scheduler);
    applier.requestApply({ target: { kind: "existing", blockId: "a" }, selection: { anchor: 1, focus: 1 } });
    applier.requestApply({ target: { kind: "existing", blockId: "a" }, selection: { anchor: 3, focus: 3 } });
    scheduler.flushMicrotasks(); scheduler.flushFrames();
    expect(target.selected).toEqual([3, 3]);
  });

  it("S-02b retries the same latest request after a stale render miss", () => {
    const target = control("abcdef");
    const scheduler = manualScheduler();
    let mounted = false;
    const applied: boolean[] = [];
    const applier = createPostRenderFocusSelectionApplier(
      { getTextControlByBlockId: () => mounted ? target : null },
      scheduler,
    );

    applier.requestApply(
      { target: { kind: "existing", blockId: "a" }, selection: { anchor: 1, focus: 1 } },
      (result) => applied.push(result),
    );
    scheduler.flushMicrotasks();
    scheduler.flushFrames();
    expect(applied).toEqual([false]);

    mounted = true;
    scheduler.flushFrames();

    expect(target.selected).toEqual([1, 1]);
    expect(applied).toEqual([false, true]);
  });

  it("S-03 clamps restored offsets to rendered text length", () => {
    const target = control("abc");
    applyFocusSelection({ getTextControlByBlockId: () => target }, {
      target: { kind: "existing", blockId: "a" }, selection: { anchor: 20, focus: 20 },
    });
    expect(target.selected).toEqual([3, 3]);
  });

  it("A-01 ArrowUp from the first visual line focuses the previous block", () => {
    expect(decideVerticalEdgeNavigation({
      direction: "up", selection: { anchor: 4, focus: 4 }, metrics: metrics("first"),
      previousBlock: { target: { kind: "existing", blockId: "previous" }, textLength: 3 },
    })).toEqual({ kind: "focus", focus: { target: { kind: "existing", blockId: "previous" }, selection: { anchor: 3, focus: 3 } } });
  });

  it("A-02 ArrowUp outside the first visual line remains native", () => {
    expect(decideVerticalEdgeNavigation({
      direction: "up", selection: { anchor: 4, focus: 4 }, metrics: metrics("middle"),
      previousBlock: { target: { kind: "existing", blockId: "previous" }, textLength: 3 },
    })).toEqual({ kind: "native" });
  });

  it("A-03 ArrowDown from the last visual line focuses the next block", () => {
    expect(decideVerticalEdgeNavigation({
      direction: "down", selection: { anchor: 2, focus: 2 }, metrics: metrics("last"),
      nextBlock: { target: { kind: "existing", blockId: "next" }, textLength: 10 },
    })).toEqual({ kind: "focus", focus: { target: { kind: "existing", blockId: "next" }, selection: { anchor: 2, focus: 2 } } });
  });

  it("A-04 ArrowDown outside the last visual line remains native", () => {
    expect(decideVerticalEdgeNavigation({
      direction: "down", selection: { anchor: 2, focus: 2 }, metrics: metrics("middle"),
      nextBlock: { target: { kind: "existing", blockId: "next" }, textLength: 10 },
    })).toEqual({ kind: "native" });
  });

  it("A-05 ArrowLeft at offset zero focuses the previous block end", () => {
    expect(decideHorizontalEdgeNavigation({
      direction: "left", selection: { anchor: 0, focus: 0 }, textLength: 5,
      previousBlock: { target: { kind: "existing", blockId: "previous" }, textLength: 8 },
    })).toEqual({ kind: "focus", focus: { target: { kind: "existing", blockId: "previous" }, selection: { anchor: 8, focus: 8 } } });
  });

  it("A-06 ArrowRight at text end focuses the next block start", () => {
    expect(decideHorizontalEdgeNavigation({
      direction: "right", selection: { anchor: 5, focus: 5 }, textLength: 5,
      nextBlock: { target: { kind: "existing", blockId: "next" }, textLength: 8 },
    })).toEqual({ kind: "focus", focus: { target: { kind: "existing", blockId: "next" }, selection: { anchor: 0, focus: 0 } } });
  });

  it("MI-01 composition guard blocks structural operations", () => {
    const guard = createCompositionGuard(); guard.compositionStart();
    expect(guard.canRunStructuralOperation()).toBe(false);
    expect(guard.structuralOperationState()).toEqual({ isComposing: true });
  });

  it("MI-02 composition guard reopens after compositionend", () => {
    const guard = createCompositionGuard(true); guard.compositionEnd();
    expect(guard.canRunStructuralOperation()).toBe(true);
    expect(guard.structuralOperationState()).toEqual({ isComposing: false });
  });
});

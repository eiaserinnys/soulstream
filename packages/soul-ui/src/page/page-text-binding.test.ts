import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  applyMinimalTextChange,
  createPageTextBinding,
  transformSelectionByDelta,
} from "./page-text-binding";

describe("page Y.Text binding", () => {
  it("applies a minimal middle replacement instead of replacing the full string", () => {
    const doc = new Y.Doc();
    const text = doc.getText("text");
    text.insert(0, "hello brave world");
    const deleteSpy = vi.spyOn(text, "delete");
    const insertSpy = vi.spyOn(text, "insert");

    const change = applyMinimalTextChange(text, "hello calm world");

    expect(change).toEqual({ index: 6, deleteCount: 5, insert: "calm" });
    expect(text.toString()).toBe("hello calm world");
    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(deleteSpy).toHaveBeenCalledWith(6, 5);
    expect(insertSpy).toHaveBeenCalledOnce();
    expect(insertSpy).toHaveBeenCalledWith(6, "calm");
  });

  it("converges two clients through Yjs updates", () => {
    const first = new Y.Doc();
    const second = new Y.Doc();
    const firstText = first.getText("text");
    firstText.insert(0, "hello");
    Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
    first.on("update", (update, origin) => {
      if (origin !== second) Y.applyUpdate(second, update, first);
    });
    second.on("update", (update, origin) => {
      if (origin !== first) Y.applyUpdate(first, update, second);
    });

    applyMinimalTextChange(firstText, "hello world");
    applyMinimalTextChange(second.getText("text"), "Hello world");

    expect(firstText.toString()).toBe(second.getText("text").toString());
    expect(firstText.toString()).toBe("Hello world");
  });

  it("maps caret and selection across remote deltas", () => {
    expect(transformSelectionByDelta(
      { anchor: 5, head: 8 },
      [{ retain: 2 }, { insert: "abc" }, { retain: 3 }, { delete: 2 }],
    )).toEqual({ anchor: 8, head: 9 });

    const doc = new Y.Doc();
    const text = doc.getText("text");
    text.insert(0, "hello world");
    const binding = createPageTextBinding(text);
    const listener = vi.fn();
    binding.setSelection({ anchor: 6, head: 11 });
    binding.subscribe(listener);

    doc.transact(() => text.insert(0, "remote "), "remote-client");

    expect(binding.getSnapshot()).toEqual({
      text: "remote hello world",
      selection: { anchor: 13, head: 18 },
      remote: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    binding.destroy();
  });
});

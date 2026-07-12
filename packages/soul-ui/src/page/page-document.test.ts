import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  BLOCKS_MAP,
  PAGE_META_MAP,
  createPageDocumentProjection,
  getPageBlockText,
} from "./page-document";

describe("page document projection", () => {
  it("orders siblings by (positionKey, id) and preserves Y.Text identity", () => {
    const doc = pageDoc();
    const firstText = addBlock(doc, { id: "b", positionKey: "a", text: "B" });
    addBlock(doc, { id: "a", positionKey: "a", text: "A" });
    addBlock(doc, { id: "child", parentId: "a", positionKey: "z", text: "child" });
    const projection = createPageDocumentProjection(doc, "page-1");

    const snapshot = projection.getSnapshot();
    expect(snapshot.blocks.map((block) => block.id)).toEqual(["a", "child", "b"]);
    expect(snapshot.blocks[2]?.text).toBe(firstText);
    expect(getPageBlockText(doc, "b")).toBe(firstText);
  });

  it("keeps a generated lowercase key after its uppercase predecessor", () => {
    const doc = pageDoc();
    addBlock(doc, { id: "current", positionKey: "V", text: "Current" });
    addBlock(doc, { id: "created", positionKey: "k", text: "" });

    const snapshot = createPageDocumentProjection(doc, "page-1").getSnapshot();

    expect(snapshot.blocks.map((block) => block.id)).toEqual(["current", "created"]);
  });

  it("publishes immutable snapshots from Y.Doc changes without cloning text objects", () => {
    const doc = pageDoc();
    const text = addBlock(doc, { id: "block-1", positionKey: "a", text: "hello" });
    const projection = createPageDocumentProjection(doc, "page-1");
    const listener = vi.fn();
    const unsubscribe = projection.subscribe(listener);
    const before = projection.getSnapshot();

    text.insert(text.length, " world");

    const after = projection.getSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(after).not.toBe(before);
    expect(after.blocks[0]?.text).toBe(text);
    expect(after.blocks[0]?.textValue).toBe("hello world");
    unsubscribe();
    projection.destroy();
  });

  it("does not create missing block text as an implicit structural write", () => {
    const doc = pageDoc();
    expect(() => getPageBlockText(doc, "missing")).toThrow("page block not found: missing");
    expect(doc.getMap(BLOCKS_MAP).size).toBe(0);
  });
});

function pageDoc(): Y.Doc {
  const doc = new Y.Doc();
  const meta = doc.getMap(PAGE_META_MAP);
  meta.set("schemaVersion", 1);
  meta.set("id", "page-1");
  meta.set("title", "Page");
  meta.set("dailyDate", null);
  meta.set("mutationVersion", 1);
  meta.set("archived", false);
  meta.set("metadata", {});
  return doc;
}

function addBlock(
  doc: Y.Doc,
  input: { id: string; parentId?: string | null; positionKey: string; text: string },
): Y.Text {
  const block = new Y.Map<unknown>();
  const text = new Y.Text(input.text);
  block.set("id", input.id);
  block.set("parentId", input.parentId ?? null);
  block.set("positionKey", input.positionKey);
  block.set("type", "paragraph");
  block.set("text", text);
  block.set("properties", new Y.Map());
  block.set("collapsed", false);
  doc.getMap<Y.Map<unknown>>(BLOCKS_MAP).set(input.id, block);
  return text;
}

import { describe, expect, it } from "vitest";

import { documentContextMenuTargetForKey } from "./document-context-menu-keyboard";

describe("document context menu keyboard target", () => {
  const bounds = { left: 20, right: 180, top: 40, bottom: 88 };

  it.each([
    ["ContextMenu", false],
    ["F10", true],
  ])("opens for %s with shift=%s at the focused row edge", (key, shiftKey) => {
    expect(documentContextMenuTargetForKey({ key, shiftKey }, bounds)).toEqual({
      x: 28,
      y: 80,
    });
  });

  it.each([
    ["F10", false],
    ["Enter", false],
    ["ContextMenu", true],
  ])("ignores unrelated key %s with shift=%s", (key, shiftKey) => {
    expect(documentContextMenuTargetForKey({ key, shiftKey }, bounds)).toBeNull();
  });
});

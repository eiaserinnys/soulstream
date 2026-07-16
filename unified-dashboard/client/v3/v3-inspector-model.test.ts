import { describe, expect, it, vi } from "vitest";
import { openDocumentInV3 } from "./v3-inspector-model";

describe("v3 inspector activation", () => {
  it("opens a page document in the v3 document inspector", () => {
    const setActiveBoardDocument = vi.fn();
    const setInspectorOpen = vi.fn();

    openDocumentInV3("doc-a", { setActiveBoardDocument, setInspectorOpen });

    expect(setActiveBoardDocument).toHaveBeenCalledWith("doc-a");
    expect(setInspectorOpen).toHaveBeenCalledWith(true);
  });
});

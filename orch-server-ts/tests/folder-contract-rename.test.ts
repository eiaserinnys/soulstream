import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBoardYjsDocumentName } from "../src/board-yjs/board_yjs_document.js";

// Public schema and persisted document names must not reopen retired aliases.
describe("folder public contract", () => {
  it("exposes one folder event and the six supported board content types", () => {
    const schema = JSON.parse(readFileSync(new URL("../../packages/wire-schema/src/upstream.schema.json", import.meta.url), "utf8"));
    expect(schema.$defs.SSEEventFolderUpdated.required).toContain("folderId");
    expect(schema.$defs.SSEEventTaskUpdated).toBeUndefined();
    expect(schema.$defs.SSEEventRunbookUpdatedLegacy).toBeUndefined();
    expect(schema["x-soulstream-board-item-types"].sort()).toEqual(["asset", "custom_view", "frame", "markdown", "session", "subfolder"]);
    expect(schema["x-soulstream-board-container-kinds"]).toBeUndefined();
  });
  it("accepts only the folder document namespace", () => {
    expect(parseBoardYjsDocumentName("board-folder:folder-a")).toEqual({ folderId: "folder-a" });
    for (const name of ["board:task:a", "board:runbook:a", "board:folder:a"]) {
      expect(parseBoardYjsDocumentName(name)).toBeNull();
    }
  });
});

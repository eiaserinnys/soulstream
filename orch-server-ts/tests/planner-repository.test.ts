import { describe, expect, it } from "vitest";
import { PlannerCursorError, decodeStarredFolderCursor, sliceRows } from "../src/planner/planner_repository_reads.js";

describe("folder planner pagination", () => {
  it("keeps an exact page identity in a bounded star cursor", () => {
    const first = sliceRows([{ id: "a", position: "1" }, { id: "b", position: "2" }], 1,
      "starred-folder", row => [row.position, row.id], row => row.id);
    expect(first.items).toEqual(["a"]);
    expect(decodeStarredFolderCursor(first.nextCursor!)).toMatchObject({ position: "1", second: "a" });
    expect(sliceRows([{ id: "b" }], 1, "subfolder", row => ["0", row.id], row => row.id).nextCursor).toBeNull();
  });
  it("rejects cursors from a different planner slice", () => {
    const slice = sliceRows([{ id: "a" }, { id: "b" }], 1, "subfolder", row => ["0", row.id], row => row.id);
    expect(() => decodeStarredFolderCursor(slice.nextCursor!)).toThrow(PlannerCursorError);
  });
});

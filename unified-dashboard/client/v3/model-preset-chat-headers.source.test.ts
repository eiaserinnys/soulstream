import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("v3 model preset chat header coverage", () => {
  it("renders the shared server-label badge in every v3 chat header", () => {
    const taskWorkspace = source("./TaskWorkspace.tsx");
    const taskBoardWorkspace = source("./TaskBoardWorkspace.tsx");

    expect(taskWorkspace.match(/<SessionModelPresetBadge session=\{activeSession\} \/>/g))
      .toHaveLength(2);
    expect(taskBoardWorkspace.match(/<SessionModelPresetBadge session=\{activeSession\} \/>/g))
      .toHaveLength(1);
  });
});

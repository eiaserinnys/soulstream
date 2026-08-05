import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPOSITORY_SOURCE = readFileSync(
  new URL("../../../orch-server-ts/src/folders/folder_control_plane_service.ts", import.meta.url),
  "utf8",
);

describe("folder control-plane row mapping contract", () => {
  it("keeps getFolderById SELECT columns aligned with folderFromRow", () => {
    const mapper = capture(
      REPOSITORY_SOURCE,
      /function folderFromRow\(row: FolderDbRow\): FolderRow \{([\s\S]*?)\n\}/,
    );
    const getFolderById = capture(
      REPOSITORY_SOURCE,
      /async getFolderById\([\s\S]*?\n  \}/,
    );
    const selectColumns = capture(getFolderById, /SELECT([\s\S]*?)FROM folders/);

    const mapperFields = [...new Set(
      [...mapper.matchAll(/\brow\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1]),
    )].sort();
    const selectedFields = selectColumns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      .sort();

    expect(selectedFields).toEqual(mapperFields);
  });
});

function capture(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  expect(match, `source must match ${pattern}`).not.toBeNull();
  return match?.[1] ?? match?.[0] ?? "";
}

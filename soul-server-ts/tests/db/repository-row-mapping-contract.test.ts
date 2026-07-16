import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPOSITORY_SOURCE = readFileSync(
  new URL("../../src/db/repositories/catalog_repository.ts", import.meta.url),
  "utf8",
);

describe("catalog repository row mapping contract", () => {
  it("keeps getFolderById SELECT columns aligned with FolderDataRow and toFolderRow", () => {
    const rowContract = capture(REPOSITORY_SOURCE, /interface FolderDataRow\s*\{([\s\S]*?)\n\}/);
    const mapper = capture(
      REPOSITORY_SOURCE,
      /function toFolderRow\(row: FolderDataRow\): FolderRow \{([\s\S]*?)\n\}/,
    );
    const getFolderById = capture(
      REPOSITORY_SOURCE,
      /async getFolderById\([\s\S]*?\n  \}/,
    );
    const selectColumns = capture(getFolderById, /SELECT([\s\S]*?)FROM folders/);

    const contractFields = [...rowContract.matchAll(/^\s+([a-z_][a-z0-9_]*):/gm)]
      .map((match) => match[1])
      .sort();
    const mapperFields = [...new Set(
      [...mapper.matchAll(/\brow\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1]),
    )].sort();
    const selectedFields = selectColumns
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean)
      .sort();

    expect(mapperFields).toEqual(contractFields);
    expect(selectedFields).toEqual(contractFields);
  });
});

function capture(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  expect(match, `source must match ${pattern}`).not.toBeNull();
  return match?.[1] ?? match?.[0] ?? "";
}

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE_DIRECTORY = new URL("./", import.meta.url);

function productionSources(): URL[] {
  return readdirSync(SOURCE_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => /\.(?:ts|tsx)$/.test(entry.name))
    .filter((entry) => !/\.(?:test|qa)\.(?:ts|tsx)$/.test(entry.name))
    .map((entry) => new URL(entry.name, SOURCE_DIRECTORY));
}

describe("v3 mutation invalidation policy", () => {
  it("forbids broad local invalidation from every v3 production source", () => {
    for (const sourceUrl of productionSources()) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source, sourceUrl.pathname).not.toMatch(/invalidateLocal/);
      expect(source, sourceUrl.pathname).not.toMatch(/invalidateV3\s*\(\s*["']local["']/);
    }
  });

  it("forbids direct query-cache reset primitives from every v3 production source", () => {
    for (const sourceUrl of productionSources()) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source, sourceUrl.pathname).not.toMatch(
        /\b(?:invalidateQueries|resetQueries|removeQueries|refetchQueries)\s*\(/,
      );
    }
  });

  it("does not expose a broad local source in the live invalidation plane", () => {
    const source = readFileSync(new URL("./v3-live-invalidation-plane.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/["']local["']/);
  });
});

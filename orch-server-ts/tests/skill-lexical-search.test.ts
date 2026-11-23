import { describe, expect, it } from "vitest";
import type { SkillCatalogEntry } from "../src/skills/skill_catalog.js";
import { rankSkillsLexically } from "../src/skills/skill_lexical_search.js";

function entry(name: string, description = ""): SkillCatalogEntry {
  return { name, description, bodyNodeId: name };
}

describe("rankSkillsLexically", () => {
  it("finds a Korean skill when the query includes a particle", () => {
    const catalog = [entry("debugging", "버그 원인 찾기"), entry("card-work", "카드 작업 절차")];
    expect(rankSkillsLexically("카드를 정리", catalog, 5)).toEqual([{ entry: catalog[1], score: 1 / 3 }]);
  });

  it("normalizes English case and full-width characters", () => {
    const catalog = [entry("card-work")];
    expect(rankSkillsLexically("Card", catalog, 5)).toEqual([{ entry: catalog[0], score: 1 }]);
    expect(rankSkillsLexically("ＣＡＲＤ", catalog, 5)).toEqual([{ entry: catalog[0], score: 1 }]);
  });

  it("preserves catalog order for equal scores", () => {
    const catalog = [entry("ab-first"), entry("ab-second")];
    expect(rankSkillsLexically("ab", catalog, 5).map(({ entry }) => entry.name)).toEqual(["ab-first", "ab-second"]);
  });

  it("limits results and excludes zero scores", () => {
    const catalog = [entry("car"), entry("bug"), entry("card-work")];
    expect(rankSkillsLexically("card", catalog, 5)).toEqual([
      { entry: catalog[2], score: 1 },
      { entry: catalog[0], score: 2 / 3 },
    ]);
    expect(rankSkillsLexically("card", catalog, 1)).toEqual([{ entry: catalog[2], score: 1 }]);
  });

  it("returns no results for a query with only symbols", () => {
    expect(rankSkillsLexically("!!!", [entry("card-work")], 5)).toEqual([]);
  });
});

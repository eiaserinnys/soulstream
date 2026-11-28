import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("PR-CD task default and context contract", () => {
  it("keeps one context editor in information and removes the duplicate session label", () => {
    const detail = read("./FolderDetailPane.tsx");
    const sections = read("./FolderWorkspaceSections.tsx");
    const information = detail.indexOf('data-task-section="information"');
    const cards = detail.indexOf('data-task-section="cards"');

    expect(sections).toContain("<FolderContextSummary");
    expect(detail).not.toContain("effectiveSessionDefaults?.agentId || effectiveSessionDefaults?.nodeId ?");
    expect(detail).not.toContain("기본값:");
    expect(information).toBeGreaterThan(-1);
    expect(detail.indexOf("{folderSections}")).toBeGreaterThan(information);
    expect(detail.indexOf("{folderSections}")).toBeLessThan(cards);
  });

  it("projects returned task blocks without reloading the daily or project planner", () => {
    const mutations = read("./use-v3-dashboard-mutations.ts");
    const applyFolderBlocks = mutations.slice(
      mutations.indexOf("const applyFolderBlocks"),
      mutations.indexOf("  return {"),
    );

    expect(applyFolderBlocks).toContain("patchPlannerFolder");
    expect(applyFolderBlocks).not.toContain("refreshFolder");
  });
});

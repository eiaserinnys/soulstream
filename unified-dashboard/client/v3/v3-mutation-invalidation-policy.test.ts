import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MUTATION_OWNERS = [
  "./V3DashboardLayout.tsx",
  "./use-v3-planner-actions.ts",
  "./RitualModal.tsx",
  "./TaskContextPicker.tsx",
  "./TaskInlineBoard.tsx",
  "./ProjectContextEditor.tsx",
  "./use-task-star.ts",
  "./use-project-folder-controller.ts",
];

describe("v3 mutation invalidation policy", () => {
  it("forbids broad local invalidation from every mutation owner", () => {
    for (const relativePath of MUTATION_OWNERS) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source, relativePath).not.toMatch(/invalidateLocal/);
      expect(source, relativePath).not.toMatch(/invalidateV3\s*\(\s*["']local["']/);
    }
  });

  it("does not expose a broad local source in the live invalidation plane", () => {
    const source = readFileSync(new URL("./v3-live-invalidation-plane.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/["']local["']/);
  });
});

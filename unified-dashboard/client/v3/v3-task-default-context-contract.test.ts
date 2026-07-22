import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("PR-CD task default and context contract", () => {
  it("keeps the editable assignment in information and removes the duplicate session label", () => {
    const detail = read("./TaskDetailPane.tsx");
    const information = detail.indexOf('data-task-section="information"');
    const checklist = detail.indexOf('data-task-section="checklist"');

    expect(detail).toContain("TaskDefaultAssignment");
    expect(detail).not.toContain("effectiveSessionDefaults?.agentId || effectiveSessionDefaults?.nodeId ?");
    expect(detail).toContain("<strong>컨텍스트</strong>");
    expect(detail).not.toContain("기본값:");
    expect(information).toBeGreaterThan(-1);
    expect(detail.indexOf("<TaskDefaultAssignment")).toBeGreaterThan(information);
    expect(detail.indexOf("<TaskDefaultAssignment")).toBeLessThan(checklist);
  });

  it("uses concise preview copy and right-aligns inheritance sources", () => {
    const form = read("./NewTaskForm.tsx");
    const css = read("./v3-planner-surfaces.css");

    expect(form).toContain("컨텍스트 · {projectName}");
    expect(form).toContain("<strong>atom</strong>");
    expect(form).toContain("<strong>기본 담당</strong>");
    expect(form).not.toContain("컨텍스트 미리보기");
    expect(form).not.toContain("지식 없음");
    expect(form).not.toContain("실행 기본값");
    expect(css).toMatch(/\.v3-project-guidance\s*>\s*small[^}]*text-align:\s*right/s);
    expect(css).toMatch(/\.v3-project-context-sourced\s*>\s*small[^}]*margin-left:\s*auto/s);
  });

  it("projects returned task blocks without reloading the daily or project planner", () => {
    const mutations = read("./use-v3-dashboard-mutations.ts");
    const applyTaskBlocks = mutations.slice(
      mutations.indexOf("const applyTaskBlocks"),
      mutations.indexOf("const applyRitualAction"),
    );

    expect(applyTaskBlocks).toContain("patchPlannerTask");
    expect(applyTaskBlocks).not.toContain("refreshTask");
  });
});

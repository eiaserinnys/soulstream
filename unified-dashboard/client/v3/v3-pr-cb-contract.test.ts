import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, file), "utf8");

describe("PR-CB visual contracts", () => {
  it("keeps daily headings and task cards inside one responsive column", () => {
    const view = read("./PlannerViews.tsx");
    const css = read("./v3-planner.css");

    expect(view).toContain('<div className="v3-planner-column">');
    expect(css).toMatch(/\.v3-planner-scroll > \*\s*\{[\s\S]*max-width:\s*892px;[\s\S]*margin-inline:\s*auto;/);
  });

  it("uses symmetric horizontal padding for the shared session-card surface", () => {
    const css = read("./v3-run-history.css");

    expect(css).toMatch(/\.v3-run-open\s*\{[\s\S]*padding:\s*10px;/);
    expect(css).not.toMatch(/padding:\s*10px\s+4px\s+10px\s+10px;/);
  });

  it("shares the panel title resolver in chat headers without session breadcrumbs", () => {
    const workspace = read("./TaskWorkspace.tsx");
    const css = read("./v3-task-workspace.css");

    expect(workspace).toContain('import { sessionPanelTitle } from "./v3-session-panel-model";');
    expect(workspace).not.toContain("function runLabel(");
    expect(workspace.match(/sessionPanelTitle\(activeSession\)/g)).toHaveLength(3);
    expect(workspace.match(/\{projectTitle\} › \{visibleTitle\}/g)).toHaveLength(2);
    expect(css).toMatch(/\.v3-chat-session-title\s*\{[\s\S]*align-items:\s*center;[\s\S]*font-size:\s*var\(--font-size-base\);/);
  });
});

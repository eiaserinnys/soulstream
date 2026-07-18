import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 aesthetic policy", () => {
  it("uses the shared liquid glass card for session and inline board cards", () => {
    const sessions = read("./RichSessionRow.tsx");
    const board = read("./TaskInlineBoard.tsx");

    expect(sessions).toContain("LiquidGlassCard");
    expect(sessions).toContain("webglSurface");
    expect(board).toContain("LiquidGlassCard");
    expect(board).toContain("webglSurface");
    expect(board).not.toContain('<article key={item.id} className="v3-inline-board-item"');
  });

  it("keeps information unified and separates task sections with spacing", () => {
    const detail = read("./TaskDetailPane.tsx");
    const css = read("./v3-task-workspace.css");
    const sectionRule = css.match(/\.v3-detail-section\s*\{[^}]*\}/s)?.[0] ?? "";

    expect(detail).toContain("<h3>정보</h3>");
    expect(detail).not.toContain("<h3>설명</h3>");
    expect(detail).not.toContain("<h3>컨텍스트</h3>");
    expect(sectionRule).not.toContain("border-top");
    expect(css).toMatch(/\.v3-context-rows\s*\{[^}]*gap:\s*5px/s);
    expect(css).toMatch(/\.v3-context-row\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.v3-context-add\.dashboard-icon-cap\s*\{[^}]*height:\s*28px/s);
  });

  it("raises muted contrast at the semantic token source for both themes", () => {
    const globals = read("../../../packages/soul-ui/src/styles/globals.css");

    expect(globals).toContain("--muted-foreground: #596171;");
    expect(globals).toContain("--muted-foreground: #c8cdd7;");
  });

  it("removes nested glass framing from project context and documents", () => {
    const view = read("./PlannerViews.tsx");
    const css = read("./v3-planner-surfaces.css");
    const contextRule = css.match(/\.v3-project-context\s*\{[^}]*\}/s)?.[0] ?? "";

    expect(view).toContain('className="v3-documents"');
    expect(view).not.toContain("documentWebglActive");
    expect(contextRule).not.toContain("border:");
  });
});

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const has = (path: string) => existsSync(new URL(path, import.meta.url));

describe("PR-CL v3 visual system contract", () => {
  it("loads global visual rules eagerly and keeps selection before final dialog rules", () => {
    const app = read("../main.tsx");
    const entry = read("./v3-dashboard-styles.ts");

    const globalsIndex = app.indexOf('import "./globals.css";');
    const visualIndex = app.indexOf('import "./v3/v3-visual-system.css";');
    expect(visualIndex).toBeGreaterThan(globalsIndex);
    expect(visualIndex).toBeLessThan(app.indexOf("import { StrictMode }"));
    expect(entry).not.toContain('import "./v3-visual-system.css";');

    const selectionIndex = entry.indexOf('import "./v3-selection-policy.css";');
    expect(selectionIndex).toBeGreaterThan(entry.indexOf('import "./v3-session-panel.css";'));
    expect(selectionIndex).toBeLessThan(entry.indexOf('import "./v3-dialog-hierarchy.css";'));
  });

  it("isolates visual tokens for the early connection dialog", () => {
    const visualSystem = read("./v3-visual-system.css");
    const connectionDialog = read("../connection/ConnectionDialog.tsx");
    const tokens = has("./v3-visual-tokens.css") ? read("./v3-visual-tokens.css") : "";

    expect(has("./v3-visual-tokens.css")).toBe(true);
    expect(visualSystem.startsWith('@import "./v3-visual-tokens.css";')).toBe(true);
    expect(visualSystem).not.toContain("--v3-type-page:");
    expect(visualSystem).toMatch(/\.v3-navigation\s*\{[^}]*--glass-chrome-surface-strong:\s*var\(--v3-glass-panel\)/s);
    expect(visualSystem).toMatch(/\.v3-planner\s*\{[^}]*--glass-chrome-surface-strong:\s*var\(--v3-glass-panel\)/s);
    expect(visualSystem).toMatch(/\.v3-session-panel\s*\{[^}]*--glass-chrome-surface-strong:\s*var\(--v3-glass-panel\)/s);
    expect(connectionDialog).toContain('import "../v3/v3-visual-tokens.css";');
    expect(connectionDialog).not.toContain('import "../v3/v3-visual-system.css";');
    expect(tokens).toContain('--v3-type-page: 680 21px/28px');
    expect(tokens).toContain('--v3-space-2: 8px');
  });

  it("keeps main box placement in planner CSS and passes the canonical outer margin", () => {
    const planner = read("./v3-planner.css");
    const visualSystem = read("./v3-visual-system.css");
    const plannerMobile = read("./v3-planner-mobile.css");
    const sessionPanel = read("./v3-session-panel.css");
    const layout = read("./V3DashboardLayout.tsx");

    expect(layout).toContain("V3_MAIN_COLUMNS_OUTER_MARGIN_PX");
    expect(layout).toContain('"--v3-main-columns-outer-margin": `${V3_MAIN_COLUMNS_OUTER_MARGIN_PX}px`');
    expect(planner).toContain("calc(var(--v3-navigation-width, 264px) + var(--v3-main-columns-outer-margin))");
    expect(planner).toContain("calc(var(--v3-session-panel-width, 300px) + var(--v3-main-columns-outer-margin))");
    expect(planner).toContain("height: calc(100dvh - 76px - var(--v3-main-columns-outer-margin));");
    expect(planner).toContain("margin: 76px 0 var(--v3-main-columns-outer-margin) var(--v3-main-columns-outer-margin);");
    expect(planner).toContain("margin: 76px var(--v3-main-columns-outer-margin) var(--v3-main-columns-outer-margin) 0;");
    expect(planner).toContain("@media (max-width: 1180px)");
    expect(planner).toContain("@media (max-width: 760px)");
    expect(visualSystem).not.toMatch(/\.v3-shell\s*\{[^}]*grid-template-columns:/s);
    expect(visualSystem).not.toMatch(/\.v3-navigation\s*\{[^}]*width:/s);
    expect(visualSystem).not.toMatch(/\.v3-navigation\s*\{[^}]*margin:\s*76px/s);
    expect(visualSystem).not.toMatch(/\.v3-navigation\s*\{[^}]*padding:/s);
    expect(visualSystem).not.toMatch(/\.v3-planner\s*\{[^}]*height:\s*calc\(100dvh/s);
    expect(visualSystem).not.toMatch(/\.v3-planner\s*\{[^}]*margin:/s);
    expect(visualSystem).not.toMatch(/\.v3-planner\s*\{[^}]*padding-top:/s);
    expect(visualSystem).not.toMatch(/\.v3-session-panel\s*\{[^}]*width:/s);
    expect(visualSystem).not.toMatch(/\.v3-session-panel\s*\{[^}]*margin:/s);
    expect(visualSystem).not.toContain("min(var(--v3-navigation-width), 240px)");
    expect(plannerMobile).not.toMatch(/\.v3-shell\s*\{\s*display:\s*block/s);
    expect(plannerMobile).toContain(".v3-planner-scroll");
    expect(plannerMobile).toContain(".v3-global-toolbar");
    expect(plannerMobile).toContain(".v3-mobile-tabs");
    expect(sessionPanel).not.toMatch(/\.v3-session-panel\s*\{\s*position:\s*relative/s);
    expect(sessionPanel).toContain(".v3-session-panel-scroll");
  });

  it("defines the seven typography roles with exact metrics", () => {
    const css = read("./v3-visual-tokens.css");

    expect(css).toContain('--v3-type-page: 680 21px/28px');
    expect(css).toContain('--v3-type-section: 650 16px/24px');
    expect(css).toContain('--v3-type-card: 600 16px/23px');
    expect(css).toContain('--v3-type-side-title: 600 14px/20px');
    expect(css).toContain('--v3-type-body: 450 14px/22px');
    expect(css).toContain('--v3-type-meta: 500 12px/18px');
    expect(css).toContain('--v3-type-badge: 600 11px/16px');
    expect(css).toContain('font-family: "Pretendard Variable", Pretendard');
  });

  it("uses the registered shared card row, section rhythm, and semantic progress roles", () => {
    const css = read("./v3-visual-tokens.css") + read("./v3-visual-system.css") + read("./v3-project-star.css");
    const cardRow = read("./CardRow.tsx");
    const componentReview = read("./ComponentsReviewPage.tsx");
    const runRows = read("./v3-run-history.css");

    expect(css).toMatch(/\.v3-task-list[^{]*\{[^}]*gap:\s*var\(--v3-space-1\)/s);
    expect(css).toMatch(/\.v3-session-list[^{]*\{[^}]*gap:\s*var\(--v3-space-1\)/s);
    expect(componentReview).toContain('name="CardRowView / RunRowFrame"');
    expect(componentReview).toContain('name="작업 목록"');
    expect(cardRow).toContain('<RunRowFrame variant="card"');
    expect(runRows).toMatch(/\.v3-run-open\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) fit-content\(30%\)/s);
    expect(runRows).toMatch(/\.v3-run-row\[data-has-actions\]\s+\.v3-run-open\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) fit-content\(30%\) auto/s);
    expect(css).toContain('grid-template-columns: var(--v3-tree-toggle-column) var(--v3-tree-drag-column) var(--v3-tree-icon-column) minmax(0, 1fr)');
    expect(css).toContain('padding-left: calc(var(--v3-project-depth, 0) * var(--v3-tree-indent-step))');
    expect(css).toMatch(/\.v3-progress > i[^{]*\{[^}]*background:\s*var\(--v3-accent\)/s);
    expect(css).toMatch(/--v3-complete:\s*var\(--info\)/);
    expect(css).toMatch(/\.v3-progress\[data-complete="true"\] > i[^{]*\{[^}]*background:\s*var\(--v3-progress-complete\)/s);
  });

  it("defines shared glass surfaces, the darker detail surface, and responsive exits", () => {
    const css = read("./v3-visual-tokens.css");
    const planner = read("./v3-planner.css");

    expect(css).toContain('--v3-glass-panel: color-mix(in srgb, var(--background) 16%, transparent)');
    expect(css).toContain('--v3-glass-card: color-mix(in srgb, var(--background) 34%, transparent)');
    expect(css).toContain('--v3-glass-dense: var(--control-surface)');
    expect(css).toContain('--v3-glass-detail: color-mix(in srgb, var(--background) 24%, transparent)');
    expect(planner).toContain('@media (max-width: 1180px)');
    expect(planner).toContain('@media (max-width: 760px)');
  });

  it("keeps chat rows readable with explicit slots instead of utility coupling", () => {
    const user = read("../../../packages/soul-ui/src/components/chat/UserMessage.tsx");
    const assistant = read("../../../packages/soul-ui/src/components/chat/AssistantMessage.tsx");
    const css = read("./v3-visual-system.css");

    expect(user).toContain('data-slot="chat-message-row"');
    expect(user).toContain('data-slot="chat-message-bubble"');
    expect(assistant).toContain('data-slot="chat-message-row"');
    expect(assistant).toContain('data-slot="chat-message-bubble"');
    expect(css).toMatch(/\[data-slot="chat-message-row"\][^{]*\{[^}]*padding-block:\s*6px/s);
    expect(css).toMatch(/\[data-slot="chat-message-bubble"\][^{]*\{[^}]*max-width:\s*88%[^}]*padding:\s*14px 16px/s);
    expect(css).toMatch(/\[data-slot="chat-tool-row"\][^{]*\{[^}]*padding-block:\s*4px/s);
    expect(css).toMatch(/\[data-slot="tool-call-group-toggle"\][^{]*\{[^}]*font:\s*var\(--v3-type-meta\) var\(--v3-font-family\)/s);
    expect(css).not.toContain(':is(.v3-chat-pane, .v3-chat-surface) [data-slot="chat-body"] h1');
    expect(css).not.toContain(':is(.v3-chat-pane, .v3-chat-surface) [data-slot="chat-body"] h4');
    expect(css).toContain('font-size: var(--chat-font-size)');
    expect(css).toContain('line-height: var(--chat-line-height)');
  });
});

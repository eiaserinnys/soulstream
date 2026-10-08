import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAYOUT_PATH = fileURLToPath(new URL("./V3DashboardLayout.tsx", import.meta.url));
const PLANNER_CSS_PATH = fileURLToPath(new URL("./v3-planner.css", import.meta.url));
const SESSION_PANEL_CSS_PATH = fileURLToPath(new URL("./v3-session-panel.css", import.meta.url));
const RUN_HISTORY_CSS_PATH = fileURLToPath(new URL("./v3-run-history.css", import.meta.url));
const WORKSPACE_CSS_PATH = fileURLToPath(new URL("./v3-folder-workspace.css", import.meta.url));
const BOARD_CSS_PATH = fileURLToPath(new URL("./v3-folder-board.css", import.meta.url));
const STATUS_CHIP_CSS_PATH = fileURLToPath(new URL("./v3-status-chip.css", import.meta.url));

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

function ruleBodies(css: string, selector: string): string[] {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = rules.exec(css)) !== null) {
    const header = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const selectors = header.split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]);
  }
  if (bodies.length === 0) throw new Error("Missing CSS rule: " + selector);
  return bodies;
}

function ruleBody(css: string, selector: string): string {
  return ruleBodies(css, selector)[0];
}

function lastRuleBody(css: string, selector: string): string {
  const bodies = ruleBodies(css, selector);
  return bodies[bodies.length - 1];
}

describe("v3 panel scroll contract", () => {
  it("fixes the planner glass frame to the dynamic viewport and scrolls only its content", () => {
    const layout = readFileSync(LAYOUT_PATH, "utf8");
    const css = readFileSync(PLANNER_CSS_PATH, "utf8");
    const mainColumns = source("./v3-main-columns.ts");
    const shell = ruleBody(css, ".v3-shell");
    const main = ruleBody(css, ".v3-main");
    const planner = ruleBody(css, ".v3-planner");
    const scroll = ruleBody(css, ".v3-planner-scroll");
    const outerMarginMatch = mainColumns.match(/V3_MAIN_COLUMNS_OUTER_MARGIN_PX\s*=\s*(\d+)/);
    const outerMargin = Number(outerMarginMatch?.[1]);

    expect(shell).toMatch(/height:\s*100dvh/);
    expect(shell).toMatch(/overflow:\s*hidden/);
    expect(main).toMatch(/min-height:\s*0/);
    expect(main).toMatch(/overflow:\s*hidden/);
    expect(main).not.toMatch(/overflow-y:\s*auto/);
    expect(planner).toMatch(/display:\s*flex/);
    expect(planner).toMatch(/height:\s*calc\(100dvh\s*-\s*76px\s*-\s*var\(--v3-main-columns-outer-margin\)\)/);
    expect(planner).toMatch(/min-height:\s*0/);
    expect(planner).toMatch(/overflow:\s*hidden/);
    expect(scroll).toMatch(/min-height:\s*0/);
    expect(scroll).toMatch(/flex:\s*1/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(layout).toContain('className="v3-planner-scroll"');
    expect(layout).toContain('data-testid="v3-planner-scroll"');
    expect(layout).toMatch(/"--v3-main-columns-outer-margin":\s*[^;\n]*V3_MAIN_COLUMNS_OUTER_MARGIN_PX/);
    expect(outerMarginMatch?.[1]).toBe("22");
    expect(76 + outerMargin).toBe(98);
  });

  it("uses the full center column without fixed side gutters while bounding readable content", () => {
    const css = readFileSync(PLANNER_CSS_PATH, "utf8");
    const planner = ruleBody(css, ".v3-planner");
    const content = ruleBody(css, ".v3-planner-scroll > *");

    expect(planner).toMatch(/width:\s*100%/);
    expect(planner).toMatch(/margin:\s*76px 0 var\(--v3-main-columns-outer-margin\)/);
    expect(planner).not.toMatch(/calc\(100% - 48px\)/);
    expect(content).toMatch(/max-width:\s*892px/);
    expect(content).toMatch(/margin-inline:\s*auto/);
  });

  it("keeps rich session rows inside the visible right-panel width", () => {
    const panelCss = readFileSync(SESSION_PANEL_CSS_PATH, "utf8");
    const rowCss = readFileSync(RUN_HISTORY_CSS_PATH, "utf8");
    const statusChipCss = readFileSync(STATUS_CHIP_CSS_PATH, "utf8");
    const runRowFrame = source("./RunRowFrame.tsx");
    const statusChip = source("./StatusChip.tsx");
    const scroll = ruleBody(panelCss, ".v3-session-panel-scroll");
    const list = ruleBody(panelCss, ".v3-session-list");
    const row = ruleBody(rowCss, ".v3-run-row");
    const trailing = ruleBody(rowCss, ".v3-run-trailing > *");
    const time = lastRuleBody(rowCss, ".v3-run-trailing time");
    const statusLabel = ruleBody(statusChipCss, ".v3-status-label");

    expect(scroll).toMatch(/overflow-x:\s*hidden/);
    expect(list).toMatch(/min-width:\s*0/);
    expect(list).toMatch(/max-width:\s*100%/);
    expect(row).toMatch(/min-width:\s*0/);
    expect(row).toMatch(/max-width:\s*100%/);
    expect(panelCss).not.toMatch(/\.v3-session-row\s+\.v3-run-trailing/);
    expect(trailing).toMatch(/max-width:\s*100%/);
    expect(trailing).toMatch(/min-width:\s*0/);
    expect(time).toMatch(/overflow:\s*hidden/);
    expect(time).toMatch(/text-overflow:\s*ellipsis/);
    expect(time).toMatch(/white-space:\s*nowrap/);
    expect(runRowFrame).toContain('import { StatusChip } from "./StatusChip";');
    expect(runRowFrame).toMatch(/className="v3-run-trailing"/);
    expect(runRowFrame).toMatch(/<StatusChip label=\{status\.label\} tone=\{status\.tone\}\/>/);
    expect(runRowFrame).toMatch(/<time dateTime=\{timestamp\.raw\}>\{timestamp\.display\}<\/time>/);
    expect(statusChip).toMatch(/<span className="v3-status-label">\{label\}<\/span>/);
    expect(statusLabel).toMatch(/overflow:\s*hidden/);
    expect(statusLabel).toMatch(/white-space:\s*nowrap/);
    expect(statusLabel).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("shares one liquid-glass scrollbar contract between the project nav and session panel", () => {
    const plannerCss = readFileSync(PLANNER_CSS_PATH, "utf8");
    const panelCss = readFileSync(SESSION_PANEL_CSS_PATH, "utf8");
    const navigationScrollbar = lastRuleBody(plannerCss, ".v3-navigation-scroll");
    const sessionPanelScrollbar = lastRuleBody(plannerCss, ".v3-session-panel-scroll");

    expect(plannerCss).toMatch(/\.v3-navigation-scroll,\s*\.v3-session-panel-scroll\s*{/);
    expect(navigationScrollbar).toEqual(sessionPanelScrollbar);
    expect(navigationScrollbar).toMatch(/scrollbar-width:\s*thin/);
    expect(navigationScrollbar).toMatch(/scrollbar-color:\s*color-mix\(/);
    expect(plannerCss).toContain(".v3-navigation-scroll::-webkit-scrollbar-thumb,\n.v3-session-panel-scroll::-webkit-scrollbar-thumb");
    expect(panelCss).not.toMatch(/\.v3-session-panel-scroll\s*\{[^}]*scrollbar-(?:width|color)/s);
  });

  it("keeps the 390px planner frame bounded above the mobile tabs", () => {
    const plannerCss = readFileSync(PLANNER_CSS_PATH, "utf8");
    const mediaStart = plannerCss.indexOf("@media (max-width: 760px)");
    expect(mediaStart).toBeGreaterThanOrEqual(0);
    const mobile = plannerCss.slice(mediaStart);
    const planner = ruleBody(mobile, ".v3-planner");
    const main = ruleBody(mobile, ".v3-main");

    expect(main).toMatch(/height:\s*calc\(100dvh - 58px\)/);
    expect(main).toMatch(/overflow:\s*hidden/);
    expect(planner).toMatch(/height:\s*calc\(100dvh - 146px\)/);
    expect(planner).toMatch(/min-height:\s*0/);
  });

  it("preserves the workspace detail, chat, and board internal scroll boundaries", () => {
    const css = readFileSync(WORKSPACE_CSS_PATH, "utf8");
    const boardCss = readFileSync(BOARD_CSS_PATH, "utf8");

    expect(ruleBody(css, ".v3-detail-scroll")).toMatch(/overflow-y:\s*auto/);
    expect(ruleBody(css, ".v3-detail-pane--inline .v3-detail-scroll")).toMatch(/overflow:\s*visible/);
    expect(ruleBody(boardCss, ".v3-full-board")).toMatch(/overflow:\s*hidden/);
    expect(ruleBody(css, ".v3-chat-content")).toMatch(/min-height:\s*0/);
    expect(ruleBody(css, ".v3-chat-content")).toMatch(/flex:\s*1/);
  });

  it("matches exact leaf selectors and selects the final repeated rule", () => {
    const fixture =
      ".v3-detail-pane--inline .v3-detail-scroll {\n  overflow: visible;\n}\n" +
      ".v3-detail-scroll {\n  overflow-y: auto;\n}\n" +
      ".v3-detail-scroll:hover {\n  overflow: hidden;\n}\n" +
      ".v3-detail-scroll {\n  overflow: clip;\n}";

    expect(ruleBody(fixture, ".v3-detail-scroll")).toMatch(/overflow-y:\s*auto/);
    expect(lastRuleBody(fixture, ".v3-detail-scroll")).toMatch(/overflow:\s*clip/);
    expect(lastRuleBody(fixture, ".v3-detail-scroll")).not.toMatch(/overflow:\s*hidden/);
    expect(ruleBody(fixture, ".v3-detail-pane--inline .v3-detail-scroll")).toMatch(
      /overflow:\s*visible/,
    );
  });
});

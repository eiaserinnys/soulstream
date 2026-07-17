import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAYOUT_PATH = fileURLToPath(new URL("./V3DashboardLayout.tsx", import.meta.url));
const PLANNER_CSS_PATH = fileURLToPath(new URL("./v3-planner.css", import.meta.url));
const PLANNER_MOBILE_CSS_PATH = fileURLToPath(new URL("./v3-planner-mobile.css", import.meta.url));
const SESSION_PANEL_CSS_PATH = fileURLToPath(new URL("./v3-session-panel.css", import.meta.url));
const RUN_HISTORY_CSS_PATH = fileURLToPath(new URL("./v3-run-history.css", import.meta.url));
const WORKSPACE_CSS_PATH = fileURLToPath(new URL("./v3-task-workspace.css", import.meta.url));
const BOARD_CSS_PATH = fileURLToPath(new URL("./v3-task-board.css", import.meta.url));

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

describe("v3 panel scroll contract", () => {
  it("fixes the planner glass frame to the dynamic viewport and scrolls only its content", () => {
    const layout = readFileSync(LAYOUT_PATH, "utf8");
    const css = readFileSync(PLANNER_CSS_PATH, "utf8");
    const shell = ruleBody(css, ".v3-shell");
    const main = ruleBody(css, ".v3-main");
    const planner = ruleBody(css, ".v3-planner");
    const scroll = ruleBody(css, ".v3-planner-scroll");

    expect(shell).toMatch(/height:\s*100dvh/);
    expect(shell).toMatch(/overflow:\s*hidden/);
    expect(main).toMatch(/min-height:\s*0/);
    expect(main).toMatch(/overflow:\s*hidden/);
    expect(main).not.toMatch(/overflow-y:\s*auto/);
    expect(planner).toMatch(/display:\s*flex/);
    expect(planner).toMatch(/height:\s*calc\(100dvh - 98px\)/);
    expect(planner).toMatch(/min-height:\s*0/);
    expect(planner).toMatch(/overflow:\s*hidden/);
    expect(scroll).toMatch(/min-height:\s*0/);
    expect(scroll).toMatch(/flex:\s*1/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(layout).toContain('className="v3-planner-scroll"');
    expect(layout).toContain('data-testid="v3-planner-scroll"');
  });

  it("uses the full center column without fixed side gutters while bounding readable content", () => {
    const css = readFileSync(PLANNER_CSS_PATH, "utf8");
    const planner = ruleBody(css, ".v3-planner");
    const content = ruleBody(css, ".v3-planner-scroll > *");

    expect(planner).toMatch(/width:\s*100%/);
    expect(planner).toMatch(/margin:\s*76px 0 22px/);
    expect(planner).not.toMatch(/calc\(100% - 48px\)/);
    expect(content).toMatch(/max-width:\s*892px/);
    expect(content).toMatch(/margin-inline:\s*auto/);
  });

  it("keeps rich session rows inside the visible right-panel width", () => {
    const panelCss = readFileSync(SESSION_PANEL_CSS_PATH, "utf8");
    const rowCss = readFileSync(RUN_HISTORY_CSS_PATH, "utf8");
    const scroll = ruleBody(panelCss, ".v3-session-panel-scroll");
    const list = ruleBody(panelCss, ".v3-session-list");
    const row = ruleBody(rowCss, ".v3-run-row");

    expect(scroll).toMatch(/overflow-x:\s*hidden/);
    expect(list).toMatch(/min-width:\s*0/);
    expect(list).toMatch(/max-width:\s*100%/);
    expect(row).toMatch(/min-width:\s*0/);
    expect(row).toMatch(/max-width:\s*100%/);
    expect(panelCss).toMatch(/\.v3-session-row \.v3-run-trailing[\s\S]*text-overflow:\s*ellipsis/);
  });

  it("shares one liquid-glass scrollbar contract between the project nav and session panel", () => {
    const plannerCss = readFileSync(PLANNER_CSS_PATH, "utf8");
    const panelCss = readFileSync(SESSION_PANEL_CSS_PATH, "utf8");
    const sharedScrollbar = ruleBody(
      plannerCss,
      ".v3-navigation-scroll,\n.v3-session-panel-scroll",
    );

    expect(sharedScrollbar).toMatch(/scrollbar-width:\s*thin/);
    expect(sharedScrollbar).toMatch(/scrollbar-color:\s*color-mix\(/);
    expect(plannerCss).toContain(".v3-navigation-scroll::-webkit-scrollbar-thumb,\n.v3-session-panel-scroll::-webkit-scrollbar-thumb");
    expect(panelCss).not.toMatch(/\.v3-session-panel-scroll\s*\{[^}]*scrollbar-(?:width|color)/s);
  });

  it("keeps the 390px planner frame bounded above the mobile tabs", () => {
    const mobile = readFileSync(PLANNER_MOBILE_CSS_PATH, "utf8");
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
    expect(ruleBody(boardCss, ".v3-full-board")).toMatch(/overflow:\s*hidden/);
    expect(ruleBody(css, ".v3-chat-content")).toMatch(/min-height:\s*0/);
    expect(ruleBody(css, ".v3-chat-content")).toMatch(/flex:\s*1/);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const LAYOUT_PATH = fileURLToPath(new URL("./V3DashboardLayout.tsx", import.meta.url));
const PLANNER_CSS_PATH = fileURLToPath(new URL("./v3-planner.css", import.meta.url));
const WORKSPACE_CSS_PATH = fileURLToPath(new URL("./v3-task-workspace.css", import.meta.url));
const BOARD_CSS_PATH = fileURLToPath(new URL("./v3-task-board.css", import.meta.url));
const RUN_HISTORY_PATH = fileURLToPath(new URL("./TaskRunHistory.tsx", import.meta.url));
const CONTEXT_CSS_PATH = fileURLToPath(new URL("./v3-context-succession.css", import.meta.url));

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

  it("keeps the 390px planner frame bounded above the mobile tabs", () => {
    const css = readFileSync(PLANNER_CSS_PATH, "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 760px)"));
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

  it("raises the nested run move dialog above the task workspace", () => {
    const source = readFileSync(RUN_HISTORY_PATH, "utf8");
    const css = readFileSync(CONTEXT_CSS_PATH, "utf8");

    expect(source).toContain('className="v3-run-move-dialog max-w-md"');
    expect(css).toMatch(/body:has\(\.v3-run-move-dialog\)[^{]*dialog-backdrop[^}]*z-index:\s*90/s);
    expect(css).toMatch(/body:has\(\.v3-run-move-dialog\)[^{]*dialog-viewport[^}]*z-index:\s*90/s);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("task board r3 workspace contract", () => {
  it("composes the three workspace areas from existing product components", () => {
    const workspace = read("./TaskBoardWorkspace.tsx");
    const resources = read("./TaskBoardResourcePane.tsx");

    expect(workspace).toContain('data-testid="v3-task-board-resources"');
    expect(workspace).toContain('data-testid="v3-task-board-canvas"');
    expect(workspace).toContain('data-testid="v3-task-board-chat"');
    expect(workspace).toContain('data-testid="v3-task-board-document-overlay"');
    expect(workspace).toContain("<MarkdownDocumentPanel />");
    expect(workspace).toContain("<ChatView");
    expect(resources).toContain("<TaskCard");
    expect(resources).toContain("<RichSessionRow");
    expect(resources).toContain("<MarkdownContent");
    expect(resources).toContain('role="tablist"');
    expect(resources).toContain('aria-selected={tab.id === activeTabId}');
  });

  it("keeps the paper overlay out of the chat column at wide and narrow desktop widths", () => {
    const css = read("./v3-task-board.css");

    expect(css).toMatch(/\.v3-workspace\.v3-task-board-workspace\s*{[^}]*grid-template-columns:/s);
    expect(css).toMatch(/\.v3-task-board-document-overlay\s*{[^}]*grid-column:\s*3;/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*1180px\)[\s\S]*\.v3-task-board-document-overlay\s*{[^}]*grid-column:\s*1\s*\/\s*4;/s);
    expect(css).toMatch(/\.v3-task-board-chat\s*{[^}]*grid-column:\s*5;/s);
  });

  it("does not introduce a task-board design token or dependency surface", () => {
    const css = read("./v3-task-board.css");
    const workspace = read("./TaskBoardWorkspace.tsx");
    const resources = read("./TaskBoardResourcePane.tsx");

    expect(css).not.toMatch(/--v3-task-board-[\w-]+\s*:/);
    expect(`${workspace}\n${resources}`).not.toContain("style={{");
    expect(`${workspace}\n${resources}`).not.toContain("<svg");
  });
});

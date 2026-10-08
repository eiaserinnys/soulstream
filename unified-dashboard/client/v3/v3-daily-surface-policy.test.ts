import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 daily auto-height surface policy", () => {
  it("uses the shared auto-height editor with bounded internal scrolling", () => {
    const styles = read("./v3-folder-workspace.css");
    const memo = read("./DailyMemo.tsx");
    const panel = read("./FolderDescriptionPanel.tsx");
    const textareaRule = styles.match(/\.v3-description-editor textarea\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(memo).toMatch(/<FolderDescriptionPanel[\s\S]*?variant="daily"/);
    expect(panel).toContain("useTextareaAutoHeight(editorRef, draft, chatFontSize, editing)");
    expect(panel).toMatch(/<textarea\b[\s\S]*?\brows=\{1\}/);
    expect(textareaRule).toMatch(/min-height:\s*calc\(var\(--spacing\)\s*\*\s*8\)/);
    expect(textareaRule).toMatch(/max-height:\s*min\(calc\(var\(--v3-control-height\)\s*\*\s*6\),\s*50dvh\)/);
    expect(textareaRule).toMatch(/resize:\s*none/);
    expect(textareaRule).toMatch(/overflow-y:\s*auto/);
    expect(textareaRule).toMatch(/scrollbar-width:\s*none/);
    expect(styles).toMatch(/\.v3-description-editor textarea::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/);
    expect(styles).not.toMatch(/\.v3-description-editor\[data-editor-variant="daily"\]\s+textarea/);
  });

  it("pins both daily headings to the left edge", () => {
    const styles = read("./v3-planner.css");

    expect(styles).toMatch(
      /\.v3-date-head\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?text-align:\s*left;/,
    );
    expect(styles).toMatch(
      /\.v3-section-head\s*\{[\s\S]*?justify-content:\s*flex-start;[\s\S]*?text-align:\s*left;/,
    );
  });
});

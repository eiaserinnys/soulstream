import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task document board unification", () => {
  it("removes the legacy mounted-document entrance from the task detail", () => {
    const detail = read("./TaskDetailPane.tsx");

    expect(detail).not.toContain("v3-task-documents");
    expect(detail).not.toContain("＋ 문서");
    expect(detail).not.toContain("프로젝트로 승격");
    expect(detail).not.toContain("documentOptions={task.mountedDocuments");
  });

  it("keeps markdown creation and inline rename on the task board list", () => {
    const inlineBoard = read("./TaskInlineBoard.tsx");

    expect(inlineBoard).toContain("<DashboardIconCap");
    expect(inlineBoard).toContain('label="마크다운 추가"');
    expect(inlineBoard).toContain("useBoardYjsRuntime");
    expect(inlineBoard).toContain("renameMarkdownDocument");
    expect(inlineBoard).toContain("patchBoardMarkdownTitle");
    expect(inlineBoard).toContain("마크다운 이름 변경 취소");
    expect(inlineBoard).toContain('variant="inline"');
  });

  it("expands inline markdown to its content while preserving the board scroll owner", () => {
    const css = read("./v3-context-menus.css");
    const boardCss = read("./v3-task-board.css");
    const inlineMarkdownRule = css.match(/\.v3-inline-markdown\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*gap:\s*var\(--v3-space-1\)/);
    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*padding-inline:\s*var\(--v3-space-1\)/);
    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*--v3-inline-rename-action-size:\s*var\(--v3-action-size\)/);
    expect(inlineMarkdownRule).not.toMatch(/^\s*height\s*:/m);
    expect(inlineMarkdownRule).not.toMatch(/^\s*max-height\s*:/m);
    expect(inlineMarkdownRule).not.toMatch(/^\s*overflow(?:-y)?\s*:\s*(?:auto|scroll)/m);
    expect(boardCss).toMatch(
      /\.v3-task-board-resource-content\s*\{[^}]*overflow:\s*auto;/s,
    );
    expect(css).toMatch(
      /\.v3-description-editor\[data-editor-variant="inline"\]\s+textarea\s*\{[\s\S]*?min-height:\s*0;/,
    );
    expect(css).toMatch(
      /\.v3-description-editor\[data-editor-variant="inline"\]\s*\{[\s\S]*?padding:\s*0;/,
    );
    expect(css).toMatch(
      /\.v3-description-editor\[data-editor-variant="inline"\]\s*\{[\s\S]*?transition:\s*none;/,
    );
    expect(css).toMatch(
      /\.v3-description-editor\[data-editor-variant="inline"\]\s*>\s*div\s*\{[\s\S]*?position:\s*absolute;/,
    );
  });

  it("expands code blocks inside blockquotes while preserving ordinary code scroll", () => {
    const globals = read("../../../packages/soul-ui/src/styles/globals.css");
    const markdown = read("../../../packages/soul-ui/src/components/MarkdownContent.tsx");

    expect(globals).toMatch(
      /\[data-markdown-blockquote\]\s+pre\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s,
    );
    expect(markdown).toContain('data-markdown-blockquote="true"');
    expect(markdown).toContain("overflow-auto max-h-60");
    expect(markdown).toContain("overflow-auto max-h-24");
  });
});

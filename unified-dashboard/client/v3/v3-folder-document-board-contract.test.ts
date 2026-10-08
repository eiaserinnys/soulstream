import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task document board unification", () => {
  it("removes the legacy mounted-document entrance from the task detail", () => {
    const detail = read("./FolderDetailPane.tsx");

    expect(detail).not.toContain("v3-task-documents");
    expect(detail).not.toContain("＋ 문서");
    expect(detail).not.toContain("프로젝트로 승격");
    expect(detail).not.toContain("mountedDocuments");
  });

  it("keeps markdown creation and inline rename on the task board list", () => {
    const inlineBoard = read("./FolderInlineBoard.tsx");

    expect(inlineBoard).toContain("<DashboardIconCap");
    expect(inlineBoard).toContain('label="마크다운 추가"');
    expect(inlineBoard).toContain("useBoardYjsRuntime");
    expect(inlineBoard).not.toContain("activeBoardDocumentId");
    expect(inlineBoard).not.toContain("setActiveBoardDocument");
    expect(inlineBoard).not.toContain("onDeletedActiveDocument");
    expect(inlineBoard).toContain("renameMarkdownDocument");
    expect(inlineBoard).toContain("patchBoardMarkdownTitle");
    expect(inlineBoard).toContain("마크다운 이름 변경 취소");
    expect(inlineBoard).toContain('variant="inline"');
  });

  it("expands inline markdown to its content while preserving the board scroll owner", () => {
    const css = read("./v3-context-menus.css");
    const boardCss = read("./v3-folder-board.css");
    const inlineBoard = read("./FolderInlineBoard.tsx");
    const editorCss = read("./v3-folder-workspace.css");
    const editor = read("./FolderDescriptionPanel.tsx");
    const inlineMarkdownRule = css.match(/\.v3-inline-markdown\s*\{([^}]*)\}/)?.[1] ?? "";
    const sharedSurfaceRule = editorCss.match(/\.v3-description-preview,\s*\.v3-description-editor\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const actionsRule = editorCss.match(/\.v3-description-actions\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const textareaRule = editorCss.match(/\.v3-description-editor textarea\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*gap:\s*var\(--v3-space-1\)/);
    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*padding-inline:\s*var\(--v3-space-1\)/);
    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*--v3-inline-rename-action-size:\s*var\(--v3-action-size\)/);
    expect(inlineMarkdownRule).not.toMatch(/^\s*height\s*:/m);
    expect(inlineMarkdownRule).not.toMatch(/^\s*max-height\s*:/m);
    expect(inlineMarkdownRule).not.toMatch(/^\s*overflow(?:-y)?\s*:\s*(?:auto|scroll)/m);
    expect(boardCss).toMatch(
      /\.v3-folder-board-resource-content\s*\{[^}]*overflow:\s*auto;/s,
    );
    expect(sharedSurfaceRule).toMatch(/display:\s*grid/);
    expect(sharedSurfaceRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(sharedSurfaceRule).toMatch(/gap:\s*var\(--v3-space-2\)/);
    expect(sharedSurfaceRule).toMatch(/padding:\s*var\(--v3-space-3\)/);
    expect(actionsRule).toMatch(/display:\s*flex/);
    expect(actionsRule).toMatch(/gap:\s*var\(--v3-space-1\)/);
    expect(textareaRule).toMatch(/min-height:\s*calc\(var\(--spacing\)\s*\*\s*8\)/);
    expect(textareaRule).toMatch(/max-height:\s*min\(calc\(var\(--v3-control-height\)\s*\*\s*6\),\s*50dvh\)/);
    expect(textareaRule).toMatch(/resize:\s*none/);
    expect(textareaRule).toMatch(/overflow-y:\s*auto/);
    expect(editorCss).toMatch(/\.v3-description-editor textarea::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/);
    expect(`${editorCss}\n${css}`).not.toMatch(/\.v3-description-editor\[data-editor-variant="inline"\]/);
    expect(editor).toContain("useTextareaAutoHeight(editorRef, draft, chatFontSize, editing)");
    expect(editor).toMatch(/<textarea\b[\s\S]*?\brows=\{1\}/);
    expect(inlineBoard).toMatch(/<FolderDescriptionPanel[\s\S]*?variant="inline"/);
  });

  it("expands every fenced code block in explicit document surfaces only", () => {
    const globals = read("../../../packages/soul-ui/src/styles/globals.css");
    const markdown = read("../../../packages/soul-ui/src/components/MarkdownContent.tsx");

    expect(globals).toMatch(
      /pre\[data-markdown-code-layout="document"\]\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s,
    );
    expect(globals).not.toMatch(/\[data-markdown-blockquote\]\s+pre/);
    expect(markdown).toContain('data-markdown-code-layout="document"');
    expect(markdown).toContain('data-markdown-code-scroll="horizontal"');
    expect(markdown).toContain("overflow-auto max-h-60");
    expect(markdown).toContain("overflow-auto max-h-24");
  });
});

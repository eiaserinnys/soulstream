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
  });

  it("uses the v3 spacing and action-size tokens around inline rename controls", () => {
    const css = read("./v3-context-menus.css");

    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*gap:\s*var\(--v3-space-1\)/);
    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*padding-inline:\s*var\(--v3-space-1\)/);
    expect(css).toMatch(/\.v3-inline-board-rename-actions[\s\S]*--v3-inline-rename-action-size:\s*var\(--v3-action-size\)/);
  });
});

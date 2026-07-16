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

    expect(inlineBoard).toContain("＋ 마크다운");
    expect(inlineBoard).toContain("useBoardYjsRuntime");
    expect(inlineBoard).toContain("renameMarkdownDocument");
    expect(inlineBoard).toContain("patchBoardMarkdownTitle");
  });
});

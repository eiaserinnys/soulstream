import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("PR-CJ task context editing contract", () => {
  it("adds initial task context through the canonical picker surface", () => {
    const form = read("./NewFolderForm.tsx");
    const picker = read("./FolderContextPicker.tsx");
    const atomOptions = read("./AtomContextOptions.tsx");

    expect(form).toContain("InitialFolderContextPicker");
    expect(form).toContain("setError(await onCreate(normalized, folderId, description, {");
    expect(form).toContain("sessionDefaults");
    expect(picker).toContain("AtomNodeSelector");
    expect(picker).toContain("업무 직접 guidance");
    expect(picker).toContain("nodeTitle: title.trim() || normalized");
    expect(picker).toContain("onOptionsChange");
    expect(atomOptions).toContain("atom depth");
    expect(atomOptions).toContain("atom 렌더 방식");
    expect(atomOptions).toContain("제목만 포함");
    expect(atomOptions).toContain("최근 자식 수");
  });

  it("edits folder atom references through one context editor", () => {
    const detail = read("./FolderDetailPane.tsx");
    const sections = read("./FolderWorkspaceSections.tsx");
    const editor = read("./ProjectContextEditor.tsx");

    expect(detail).toContain('direct: reference.source.pageId === task.page.id');
    expect(sections).toContain("<ProjectContextEditor");
    expect(editor).toContain("saveProjectAtomReference");
    expect(editor).toContain("deleteProjectContextBlock");
    expect(detail).not.toContain("savePageAtomReference");
  });

  it("keeps atom deletion in the canonical editor", () => {
    const editor = read("./ProjectContextEditor.tsx");
    const atomOptions = read("./AtomContextOptions.tsx");

    expect(editor).toContain("onDelete={() => removeAtom(reference.blockId)}");
    expect(atomOptions).toContain("<Trash2");
    expect(atomOptions).toContain("v3-context-option--selected");
  });
});

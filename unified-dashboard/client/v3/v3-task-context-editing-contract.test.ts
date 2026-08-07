import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("PR-CJ task context editing contract", () => {
  it("adds initial task context through the canonical picker surface", () => {
    const form = read("./NewTaskForm.tsx");
    const picker = read("./TaskContextPicker.tsx");
    const atomOptions = read("./AtomContextOptions.tsx");

    expect(form).toContain("InitialTaskContextPicker");
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

  it("keeps inherited atom rows read-only and edits direct rows with one block mutation", () => {
    const detail = read("./TaskDetailPane.tsx");

    expect(detail).toContain('direct: reference.source.pageId === task.page.id');
    expect(detail).toContain("savePageAtomReference");
    expect(detail).toContain("deletePageContextBlock");
    expect(detail).toContain("updateOptimisticTaskAtomReference");
    expect(detail).toContain("deleteOptimisticTaskContextBlock");
    expect(detail).toContain("context.direct ?");
    expect(detail).toContain("v3-context-row-readonly");
    expect(detail).toContain("최근 자식 수");
  });

  it("uses destructive trash affordances instead of an atom toggle", () => {
    const detail = read("./TaskDetailPane.tsx");
    const atomOptions = read("./AtomContextOptions.tsx");
    const css = read("./v3-task-workspace.css");

    expect(detail).toContain("<Trash2");
    expect(atomOptions).toContain("<Trash2");
    expect(atomOptions).toContain("v3-context-option--selected");
    expect(css).toMatch(/\.v3-context-row-remove\s*\{[^}]*color:\s*var\(--destructive\)/s);
  });
});

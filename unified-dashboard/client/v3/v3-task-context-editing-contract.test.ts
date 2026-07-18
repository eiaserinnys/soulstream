import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("PR-CJ task context editing contract", () => {
  it("adds initial task context through the canonical picker surface", () => {
    const form = read("./NewTaskForm.tsx");
    const picker = read("./TaskContextPicker.tsx");

    expect(form).toContain("InitialTaskContextPicker");
    expect(form).toContain("onCreate(normalized, folderId, description, initialContext)");
    expect(picker).toContain("AtomNodeSelector");
    expect(picker).toContain("업무 직접 guidance");
    expect(picker).toContain("nodeTitle: title.trim() || normalized");
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
  });

  it("uses destructive trash affordances instead of an atom toggle", () => {
    const detail = read("./TaskDetailPane.tsx");
    const picker = read("./TaskContextPicker.tsx");
    const css = read("./v3-task-workspace.css");

    expect(detail).toContain("<Trash2");
    expect(picker).toContain("<Trash2");
    expect(picker).toContain("v3-context-option--selected");
    expect(css).toMatch(/\.v3-context-row-remove\s*\{[^}]*color:\s*var\(--destructive\)/s);
  });
});

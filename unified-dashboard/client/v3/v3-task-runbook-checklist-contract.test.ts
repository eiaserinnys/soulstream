import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task runbook checklist", () => {
  it("reuses the board RunbookCard in the task detail without a parallel checklist renderer", () => {
    const detail = read("./TaskDetailPane.tsx");

    expect(detail).toContain("RunbookCard");
    expect(detail).toContain("<RunbookCard");
    expect(detail).toContain("runbookId={task.runbookId}");
    expect(detail).toContain("fallbackTitle={task.page.title}");
    expect(detail).toContain("onOpenBoard={() => onOpenBoard()}");
    expect(detail).not.toContain("RunbookItemStatusToggle");
    expect(detail).not.toContain("useRunbookStore");
  });

  it("keeps large task checklists inside a bounded inner scroll surface", () => {
    const css = read("./v3-task-workspace.css");

    expect(css).toContain(".v3-task-runbook-checklist");
    expect(css).toMatch(/\.v3-task-runbook-checklist\s*\{[^}]*height:\s*min\(520px,\s*65dvh\)/s);
    expect(css).toMatch(/\.v3-task-runbook-checklist\s*\{[^}]*min-height:\s*320px/s);
  });
});

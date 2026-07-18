import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task runbook checklist", () => {
  it("reuses the board RunbookCard in the task detail without a parallel checklist renderer", () => {
    const detail = read("./TaskDetailPane.tsx");
    const card = read("../../../packages/soul-ui/src/runbook/RunbookCard.tsx");
    const checklist = read("../../../packages/soul-ui/src/runbook/RunbookChecklist.tsx");

    expect(detail).toContain("RunbookCard");
    expect(detail).toContain("<RunbookCard");
    expect(detail).toContain("runbookId={task.runbookId}");
    expect(detail).toContain("fallbackTitle={task.page.title}");
    expect(detail).not.toContain("onOpenBoard={() => onOpenBoard()}");
    expect(detail).not.toContain("defaultItemDetailsOpen");
    expect(card).not.toContain("defaultItemDetailsOpen");
    expect(checklist).not.toContain("defaultItemDetailsOpen");
    expect(detail).toContain('textSize="session"');
    expect(detail.match(/label="런북 보드 열기"/g)).toHaveLength(1);
    expect(detail).not.toContain("RunbookItemStatusToggle");
    expect(detail).not.toContain("useRunbookStore");
  });

  it("uses one row action primitive for the sibling menu and disclosure buttons", () => {
    const controls = read("../../../packages/soul-ui/src/runbook/RunbookChecklistControls.tsx");
    const item = read("../../../packages/soul-ui/src/runbook/RunbookChecklistItem.tsx");

    expect(controls).toContain("export const RunbookRowActionButton = forwardRef");
    expect(controls).toContain("<RunbookRowActionButton");
    expect(item).toContain('data-testid="runbook-item-actions"');
    expect(item).toContain("<RunbookRowActionButton");
    const detailsButton = item.match(
      /<RunbookRowActionButton[\s\S]*?data-testid="runbook-item-details-toggle"[\s\S]*?>/,
    )?.[0];
    expect(detailsButton).toBeDefined();
    expect(detailsButton).not.toContain("className=");
  });

  it("lets short checklists size to content and bounds only long checklists", () => {
    const css = read("./v3-task-workspace.css");

    expect(css).toContain(".v3-task-runbook-checklist");
    expect(css).toMatch(/\.v3-task-runbook-checklist\s*\{[^}]*max-height:\s*min\(348px,\s*44dvh\)/s);
    expect(css).toMatch(/\.v3-task-runbook-checklist\s*>\s*\[data-testid="runbook-card"\]\s*\{[^}]*height:\s*auto/s);
    expect(css).not.toMatch(/\.v3-task-runbook-checklist\s*\{[^}]*\n\s*height:/s);
    expect(css).not.toContain("min-height: 214px");
  });

  it("uses the section gap as the task workspace bottom inset", () => {
    const css = read("./v3-task-workspace.css");

    expect(css).toMatch(/\.v3-detail-scroll\s*\{[^}]*padding:\s*24px 24px 28px/s);
    expect(css).not.toContain("padding: 24px 24px 70px");
  });
});

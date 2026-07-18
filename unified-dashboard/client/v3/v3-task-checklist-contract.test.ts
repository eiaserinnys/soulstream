import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("v3 task checklist", () => {
  it("reuses the board TaskCard in the task detail without a parallel checklist renderer", () => {
    const detail = read("./TaskDetailPane.tsx");
    const card = read("../../../packages/soul-ui/src/task/TaskCard.tsx");
    const checklist = read("../../../packages/soul-ui/src/task/TaskChecklist.tsx");

    expect(detail).toContain("TaskCard");
    expect(detail).toContain("<TaskCard");
    expect(detail).toContain("taskId={task.taskId}");
    expect(detail).toContain("fallbackTitle={task.page.title}");
    expect(detail).not.toContain("onOpenBoard={() => onOpenBoard()}");
    expect(detail).not.toContain("defaultItemDetailsOpen");
    expect(card).not.toContain("defaultItemDetailsOpen");
    expect(checklist).not.toContain("defaultItemDetailsOpen");
    expect(detail).toContain('textSize="session"');
    expect(detail.match(/label="업무 보드 열기"/g)).toHaveLength(1);
    expect(detail).not.toContain("TaskItemStatusToggle");
    expect(detail).not.toContain("useTaskStore");
  });

  it("uses one row action primitive for the sibling menu and disclosure buttons", () => {
    const controls = read("../../../packages/soul-ui/src/task/TaskChecklistControls.tsx");
    const item = read("../../../packages/soul-ui/src/task/TaskChecklistItem.tsx");

    expect(controls).toContain("export const TaskRowActionButton = forwardRef");
    expect(controls).toContain("<TaskRowActionButton");
    expect(item).toContain('data-testid="task-item-actions"');
    expect(item).toContain("<TaskRowActionButton");
    const detailsButton = item.match(
      /<TaskRowActionButton[\s\S]*?data-testid="task-item-details-toggle"[\s\S]*?>/,
    )?.[0];
    expect(detailsButton).toBeDefined();
    expect(detailsButton).not.toContain("className=");
  });

  it("lets short checklists size to content and bounds only long checklists", () => {
    const css = read("./v3-task-workspace.css");

    expect(css).toContain(".v3-task-checklist");
    expect(css).toMatch(/\.v3-task-checklist\s*\{[^}]*max-height:\s*min\(348px,\s*44dvh\)/s);
    expect(css).toMatch(/\.v3-task-checklist\s*>\s*\[data-testid="task-card"\]\s*\{[^}]*height:\s*auto/s);
    expect(css).not.toMatch(/\.v3-task-checklist\s*\{[^}]*\n\s*height:/s);
    expect(css).not.toContain("min-height: 214px");
  });

  it("uses the section gap as the task workspace bottom inset", () => {
    const css = read("./v3-task-workspace.css");

    expect(css).toMatch(/\.v3-detail-scroll\s*\{[^}]*padding:\s*24px 24px 28px/s);
    expect(css).not.toContain("padding: 24px 24px 70px");
  });
});

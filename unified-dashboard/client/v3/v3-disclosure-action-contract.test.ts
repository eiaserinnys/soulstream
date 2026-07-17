import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const DISCLOSURE_SOURCES = [
  "./TaskInlineBoard.tsx",
  "./ProjectNavigationTree.tsx",
  "../../../packages/soul-ui/src/runbook/RunbookCard.tsx",
  "../../../packages/soul-ui/src/runbook/RunbookOverview.tsx",
  "../../../packages/soul-ui/src/components/FolderItem.tsx",
  "../../../packages/soul-ui/src/components/ClaudeRuntimeNotificationsPanel.tsx",
  "../../../packages/soul-ui/src/components/ClaudeRuntimeSchedulesPanel.tsx",
  "../../../packages/soul-ui/src/components/ClaudeRuntimeTasksPanel.tsx",
  "../../../packages/soul-ui/src/board-workspace/BoardWorkspaceMinimap.tsx",
] as const;

describe("disclosure action icon contract", () => {
  it.each(DISCLOSURE_SOURCES)("uses the shared down-to-expand and up-to-collapse action in %s", (path) => {
    const source = read(path);

    expect(source).toContain("DisclosureActionIcon");
    expect(source).not.toMatch(/expanded\s*\?\s*<Chevron(?:Down|Right|Up)/);
    expect(source).not.toMatch(/isExpanded\s*\?\s*<Chevron(?:Down|Right|Up)/);
  });

  it("keeps the generic accordion primitive on the same visual contract", () => {
    const accordion = read("../../../packages/soul-ui/src/components/ui/accordion.tsx");

    expect(accordion).toContain("ChevronDownIcon");
    expect(accordion).toContain("data-panel-open:*:data-[slot=accordion-indicator]:rotate-180");
  });
});

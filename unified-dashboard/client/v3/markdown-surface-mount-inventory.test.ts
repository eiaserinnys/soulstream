import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SOURCE_ROOTS = [
  path.join(REPO_ROOT, "packages/soul-ui/src"),
  path.join(REPO_ROOT, "unified-dashboard/client/v3"),
];

function inventoryMounts(componentName: string) {
  return SOURCE_ROOTS.flatMap(walkTypescriptReactFiles)
    .filter((file) => readFileSync(file, "utf8").includes(`<${componentName}`))
    .map((file) => path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"))
    .sort();
}

function countMounts(componentName: string, file: string) {
  return readFileSync(path.join(REPO_ROOT, file), "utf8").split(`<${componentName}`).length - 1;
}

function walkTypescriptReactFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkTypescriptReactFiles(fullPath);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [fullPath];
  });
}

describe("markdown surface mount inventory", () => {
  it("enumerates every shared MarkdownContent surface", () => {
    expect(inventoryMounts("MarkdownContent")).toEqual([
      "packages/soul-ui/src/components/MarkdownDocumentPanel.tsx",
      "packages/soul-ui/src/components/chat/AssistantMessage.tsx",
      "packages/soul-ui/src/components/chat/UserMessage.tsx",
      "packages/soul-ui/src/task/TaskChecklistItem.tsx",
      "packages/soul-ui/src/task/TaskOverviewRows.tsx",
      "unified-dashboard/client/v3/TaskBoardResourcePane.tsx",
      "unified-dashboard/client/v3/TaskDescriptionPanel.tsx",
    ]);
  });

  it("enumerates every shared MarkdownDocumentPanel surface", () => {
    expect(inventoryMounts("MarkdownDocumentPanel")).toEqual([
      "packages/soul-ui/src/components/RightPanel.tsx",
      "unified-dashboard/client/v3/TaskBoardWorkspace.tsx",
      "unified-dashboard/client/v3/TaskWorkspace.tsx",
      "unified-dashboard/client/v3/V3StandaloneDocumentInspector.tsx",
    ]);
  });

  it("enumerates every TaskDescriptionPanel wrapper surface", () => {
    const mounts = [
      "unified-dashboard/client/v3/DailyMemo.tsx",
      "unified-dashboard/client/v3/ProjectContextEditor.tsx",
      "unified-dashboard/client/v3/TaskDetailPane.tsx",
      "unified-dashboard/client/v3/TaskInlineBoard.tsx",
    ];
    expect(inventoryMounts("TaskDescriptionPanel")).toEqual(mounts);
    expect(Object.fromEntries(mounts.map((file) => [
      file,
      countMounts("TaskDescriptionPanel", file),
    ]))).toEqual({
      "unified-dashboard/client/v3/DailyMemo.tsx": 1,
      "unified-dashboard/client/v3/ProjectContextEditor.tsx": 2,
      "unified-dashboard/client/v3/TaskDetailPane.tsx": 1,
      "unified-dashboard/client/v3/TaskInlineBoard.tsx": 1,
    });
  });
});

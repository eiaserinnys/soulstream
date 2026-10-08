import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("v3 model preset chat header coverage", () => {
  it("renders the shared server-label badge in every v3 chat header", () => {
    const taskWorkspace = source("./FolderWorkspace.tsx");
    const taskBoardWorkspace = source("./FolderBoardWorkspace.tsx");
    const sessionColumn = source("./WorkspaceSessionColumn.tsx");
    const sharedHeaders = source("./WorkspacePanelHeaders.tsx");
    const boardChatColumn = taskBoardWorkspace.match(/<WorkspaceSessionColumn\b([\s\S]*?)\/>/)?.[1] ?? "";

    expect(taskWorkspace.match(/<SessionPanelHeader\b/g))
      .toHaveLength(2);
    expect(sessionColumn.match(/<SessionPanelHeader\b/g))
      .toHaveLength(1);
    expect(boardChatColumn).toContain("activeSession={activeSession}");
    expect(sharedHeaders).toContain("sessionPanelTitle(session)");
    expect(sharedHeaders.match(/<SessionModelPresetBadge session=\{session\}\/>/g))
      .toHaveLength(1);
  });
});

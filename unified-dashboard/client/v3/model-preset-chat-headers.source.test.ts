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
    const taskWorkspaceHeaders = taskWorkspace.match(/<SessionPanelHeader\b[^>]*\/>/g) ?? [];
    const sessionColumnHeaders = sessionColumn.match(/<SessionPanelHeader\b[^>]*\/>/g) ?? [];

    expect(taskWorkspaceHeaders).toHaveLength(2);
    for (const header of taskWorkspaceHeaders) expect(header).toContain("session={activeSession}");
    expect(sessionColumnHeaders).toHaveLength(1);
    expect(sessionColumnHeaders[0]).toContain("session={activeSession}");
    expect(boardChatColumn).toContain("activeSession={activeSession}");
    expect(sharedHeaders).toContain("sessionPanelTitle(session)");
    expect(sharedHeaders.match(/<SessionModelPresetBadge session=\{session\}\/>/g))
      .toHaveLength(1);
  });
});

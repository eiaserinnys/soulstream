import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(import.meta.dirname, file), "utf8");

describe("PR-CB visual contracts", () => {
  it("keeps daily headings and task cards inside one responsive column", () => {
    const view = read("./PlannerViews.tsx");
    const css = read("./v3-planner.css");

    expect(view).toContain('<div className="v3-planner-column v3-planner-column--daily">');
    expect(css).toMatch(/\.v3-planner-scroll > \*\s*\{[\s\S]*max-width:\s*892px;[\s\S]*margin-inline:\s*auto;/);
  });

  it("uses symmetric horizontal padding for the shared session-card surface", () => {
    const css = read("./v3-run-history.css");

    expect(css).toMatch(/\.v3-run-open\s*\{[\s\S]*padding:\s*10px;/);
    expect(css).not.toMatch(/padding:\s*10px\s+4px\s+10px\s+10px;/);
  });

  it("shares the panel title resolver in chat headers without session breadcrumbs", () => {
    const workspace = read("./FolderWorkspace.tsx");
    const boardWorkspace = read("./FolderBoardWorkspace.tsx");
    const sessionColumn = read("./WorkspaceSessionColumn.tsx");
    const sharedHeaders = read("./WorkspacePanelHeaders.tsx");
    const documentOverlay = read("./FolderDocumentOverlay.tsx");
    const css = read("./v3-folder-workspace.css");
    const boardChatColumn = boardWorkspace.match(/<WorkspaceSessionColumn\b([\s\S]*?)\/>/)?.[1] ?? "";

    expect(workspace.match(/<SessionPanelHeader\b/g)).toHaveLength(2);
    expect(workspace).not.toContain("function runLabel(");
    expect(boardChatColumn).toContain("activeSession={activeSession}");
    expect(sessionColumn).toContain("<SessionPanelHeader session={activeSession}");
    expect(sharedHeaders).toContain('import { sessionPanelTitle } from "./v3-session-panel-model";');
    expect(sharedHeaders).toContain("sessionPanelTitle(session)");
    expect(sharedHeaders).toContain("<SessionModelPresetBadge session={session}/>");
    expect(workspace).not.toContain("{projectTitle} › {visibleTitle}");
    expect(boardWorkspace).toContain("projectTitle={projectTitle} folderTitle={task.page.title}");
    expect(documentOverlay).toContain("{projectTitle} › {folderTitle}");
    expect(css).toMatch(/\.v3-chat-session-title\s*\{[\s\S]*align-items:\s*center;[\s\S]*font-size:\s*var\(--font-size-base\);/);
  });
});

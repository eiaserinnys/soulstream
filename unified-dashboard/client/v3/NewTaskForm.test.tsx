import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  findProjectPageForFolder,
  newTaskFolderOptions,
  ProjectInheritancePreview,
} from "./NewTaskForm";

describe("new task inheritance preview", () => {
  it("matches the selected folder to its existing project page", () => {
    const folders = [
      {
        id: "folder-soulstream",
        name: "소울스트림",
        parentFolderId: null,
        sortOrder: 0,
        projectPageId: "project-soulstream",
      },
      {
        id: "folder-empty",
        name: "빈 프로젝트",
        parentFolderId: null,
        sortOrder: 1,
        projectPageId: "project-empty",
      },
    ];
    const pages = [
      projectPage("project-empty", "빈 프로젝트", { folderId: "folder-empty" }),
      projectPage("project-soulstream", "소울스트림", { folderId: "folder-soulstream" }),
    ];

    expect(findProjectPageForFolder("folder-soulstream", folders, pages)?.id)
      .toBe("project-soulstream");
  });

  it("reuses the v1 emoji-insensitive recursive folder order", () => {
    const folders = [
      folder("child-z", "🧰 Zeta", "root-a"),
      folder("root-z", "📒 Zebra", null),
      folder("child-a", "  📱 Alpha", "root-a"),
      folder("root-a", "✨ Alpha", null),
    ];

    expect(newTaskFolderOptions(folders).map(({ folder: item, depth }) => [item.id, depth]))
      .toEqual([
        ["root-a", 0],
        ["child-a", 1],
        ["child-z", 1],
        ["root-z", 0],
      ]);
  });

  it("renders real guidance, atom chips, and agent@node defaults", () => {
    const guidance = "완성도와 검증 근거를 우선한다. ".repeat(24).trim();
    const html = renderToStaticMarkup(
      <ProjectInheritancePreview
        projectName="소울스트림"
        state={{
          status: "ready",
          data: {
            guidance: [{ blockId: "guidance-1", text: guidance }],
            atomReferences: [{
              blockId: "atom-1",
              instance: "atom",
              nodeId: "node-soulstream",
              nodeTitle: "soulstream",
              depth: 5,
              titlesOnly: false,
            }],
            sessionDefaults: [{
              blockId: "defaults-1",
              agentId: "roselin_codex",
              nodeId: "eiaserinnys",
            }],
          },
          message: null,
        }}
      />,
    );

    expect(html).toContain("상속 미리보기 · 소울스트림");
    expect(html).toContain("line-clamp-3");
    expect(html).toContain("…</span>");
    expect(html).toContain(`data-testid="inheritance-guidance-full">${guidance}</pre>`);
    expect(html).toContain("v3-project-context-chip");
    expect(html).toContain("⚛ soulstream · depth 5 · titlesOnly off");
    expect(html).toContain("👤 roselin_codex@eiaserinnys");
  });

  it("keeps every inheritance label and says 없음 when blocks are absent", () => {
    const html = renderToStaticMarkup(
      <ProjectInheritancePreview
        projectName="빈 프로젝트"
        state={{
          status: "ready",
          data: { guidance: [], atomReferences: [], sessionDefaults: [] },
          message: null,
        }}
      />,
    );

    expect(html).toContain("guidance");
    expect(html).toContain("atom");
    expect(html).toContain("실행 기본값");
    expect(html.match(/없음/g)).toHaveLength(3);
  });
});

function projectPage(id: string, title: string, metadata: Record<string, unknown>) {
  return {
    id,
    title,
    daily_date: null,
    version: 1,
    archived: false,
    metadata,
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

function folder(id: string, name: string, parentFolderId: string | null) {
  return {
    id,
    name,
    parentFolderId,
    sortOrder: 0,
    projectPageId: id,
  };
}

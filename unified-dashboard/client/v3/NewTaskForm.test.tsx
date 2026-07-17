import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  newTaskFolderOptions,
  ProjectInheritancePreview,
} from "./NewTaskForm";
import { mergeProjectContextPages } from "./project-context-inheritance";

describe("new task inheritance preview", () => {
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
          folderId: "folder-soulstream",
          data: mergeProjectContextPages([{
            source: { folderId: "folder-soulstream", folderName: "소울스트림", pageId: "project-soulstream" },
            details: {
            guidance: [{ blockId: "guidance-1", text: guidance, scope: "project" }],
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
              scope: "project",
              agentId: "roselin_codex",
              nodeId: "eiaserinnys",
            }],
            },
          }]),
          message: null,
        }}
      />,
    );

    expect(html).toContain("컨텍스트 · 소울스트림");
    expect(html).toContain("v3-text-clamp-3");
    expect(html).toContain(guidance);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<strong>guidance</strong>");
    expect(html).toContain("소울스트림에서 상속");
    expect(html).toContain("v3-project-context-chip");
    expect(html).toContain("⚛ soulstream · depth 5 · titlesOnly off");
    expect(html).toContain("👤 roselin_codex@eiaserinnys");

    const clampCss = readFileSync(new URL("./v3-content-boundary.css", import.meta.url), "utf8");
    expect(clampCss).toMatch(/\.v3-text-clamp-3[\s\S]*text-overflow:\s*ellipsis/);
    expect(clampCss).toMatch(/\.v3-text-clamp-3\s*\{[^}]*-webkit-line-clamp:\s*3/s);
  });

  it("keeps every inheritance label and says 없음 when blocks are absent", () => {
    const html = renderToStaticMarkup(
      <ProjectInheritancePreview
        projectName="빈 프로젝트"
        state={{
          status: "ready",
          folderId: "folder-empty",
          data: mergeProjectContextPages([]),
          message: null,
        }}
      />,
    );

    expect(html).toContain("atom");
    expect(html).toContain("기본 담당");
    expect(html).not.toContain("지식 없음");
    expect(html).not.toContain("실행 기본값");
    expect(html.match(/없음/g)).toHaveLength(3);
  });
});

function folder(id: string, name: string, parentFolderId: string | null) {
  return {
    id,
    name,
    parentFolderId,
    sortOrder: 0,
    projectPageId: id,
  };
}

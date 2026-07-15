import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProjectContextEditor } from "./ProjectContextEditor";
import type { ProjectPageSnapshot } from "./project-page-details";

describe("ProjectContextEditor", () => {
  it("keeps guidance visible and exposes atom/default editors as popover triggers", () => {
    const snapshot = {
      page: { id: "project-1", title: "프로젝트", version: 1 },
      blocks: [],
      stateVector: "AA==",
      guidance: [{ blockId: "guidance-1", text: "프로젝트 지침 본문" }],
      atomReferences: [{
        blockId: "atom-1",
        instance: "atom",
        nodeId: "node-1",
        nodeTitle: "소울스트림",
        depth: 3,
        titlesOnly: false,
      }],
      sessionDefaults: [{ blockId: "defaults-1", agentId: "roselin_codex", nodeId: "eiaserinnys" }],
    } as unknown as ProjectPageSnapshot;

    const html = renderToStaticMarkup(
      <ProjectContextEditor pageId="project-1" snapshot={snapshot} onChanged={vi.fn(async () => undefined)} />,
    );

    expect(html).toContain('data-testid="v3-project-guidance-guidance-1"');
    expect(html).toContain("프로젝트 지침 본문");
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(3);
    expect(html).not.toContain('data-editor-presentation="inline-expansion"');
  });
});

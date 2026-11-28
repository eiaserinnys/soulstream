import { createI18n } from "@soulstream/i18n";
import { expect, it } from "vitest";

import type { BlockDto } from "../../../packages/page-model/src/types";
import { buildFolderSessionContextItems } from "./folder-session-context-items";
import type { ProjectContextInheritance } from "./project-context-inheritance";

it("translates succession chip labels while recognizing the Korean source marker", () => {
  const currentPage = "page-current";
  const context: ProjectContextInheritance = {
    pages: [],
    guidance: [{
      blockId: "guidance",
      scope: "folder",
      text: "Review the checklist",
      source: { folderId: "current", folderName: "이 폴더", pageId: currentPage },
    }],
    atomReferences: [{
      blockId: "atom",
      instance: "atom",
      nodeId: "rollout",
      nodeTitle: "Rollout",
      depth: 3,
      titlesOnly: false,
      source: { folderId: "parent", folderName: "Operations", pageId: "page-parent" },
    }],
    sessionDefaults: [],
  };
  const pageLink: BlockDto = {
    id: "page-link",
    page_id: currentPage,
    block_type: "paragraph",
    text: "[[Runbook]]",
    parent_id: null,
    position_key: "a",
    properties: {},
    collapsed: false,
  };

  const chips = buildFolderSessionContextItems(context, [pageLink], currentPage, createI18n("en").t);
  expect(chips.map(({ direct, sourceLabel, label }) => ({ direct, sourceLabel, label }))).toEqual([
    { direct: true, sourceLabel: "This folder", label: "Review the checklist · This folder" },
    { direct: false, sourceLabel: "Inherited from Operations", label: "Rollout · Inherited from Operations" },
    { direct: true, sourceLabel: "This folder", label: "Runbook · This folder" },
  ]);
  expect(context.guidance[0].source.folderName).toBe("이 폴더");
  expect(buildFolderSessionContextItems(context, [pageLink], currentPage)[0].sourceLabel).toBe("이 폴더");
});

import { describe, expect, it } from "vitest";

import {
  beginProjectContextLoad,
  completeProjectContextLoad,
  folderProjectContextSources,
  mergeProjectContextPages,
  type ProjectContextPreviewState,
} from "./project-context-inheritance";

describe("project context inheritance", () => {
  it("walks only the selected parent chain and silently skips legacy NULL bindings", () => {
    const sources = folderProjectContextSources("dashboard", [
      folder("unrelated", "무관", null, "page-unrelated"),
      folder("soulstream", "소울스트림", null, "page-soulstream"),
      folder("legacy", "레거시", "soulstream", null),
      folder("dashboard", "대시보드", "legacy", "page-dashboard"),
    ]);

    expect(sources).toEqual({
      status: "resolved",
      sources: [
        { folderId: "soulstream", folderName: "소울스트림", pageId: "page-soulstream" },
        { folderId: "dashboard", folderName: "대시보드", pageId: "page-dashboard" },
      ],
    });
  });

  it("uses server semantic keys and keeps the selected values in root-to-leaf order", () => {
    const result = mergeProjectContextPages([
      {
        source: { folderId: "soulstream", folderName: "소울스트림", pageId: "page-soulstream" },
        details: {
          guidance: [guidance("root-shared", "root shared", "shared"), guidance("root-only", "root only", "root")],
          atomReferences: [atom("root-same", "node-same", 5), atom("root-only-atom", "node-root", 3)],
          sessionDefaults: [defaults("root-defaults", "project", "root-agent", "root-node")],
        },
      },
      {
        source: { folderId: "dashboard", folderName: "대시보드", pageId: "page-dashboard" },
        details: {
          guidance: [
            guidance("leaf-shared", "leaf shared", "shared"),
            guidance("leaf-shared-later", "later duplicate", "shared"),
          ],
          atomReferences: [atom("leaf-same", "node-same", 2)],
          sessionDefaults: [defaults("leaf-defaults", "project", "leaf-agent", "leaf-node")],
        },
      },
    ]);

    expect(result.guidance.map((item) => [item.text, item.source.folderName])).toEqual([
      ["root only", "소울스트림"],
      ["leaf shared", "대시보드"],
    ]);
    expect(result.atomReferences.map((item) => [item.nodeId, item.depth, item.source.folderName])).toEqual([
      ["node-root", 3, "소울스트림"],
      ["node-same", 2, "대시보드"],
    ]);
    expect(result.sessionDefaults).toEqual([
      expect.objectContaining({ agentId: "leaf-agent", nodeId: "leaf-node", source: expect.objectContaining({ folderName: "대시보드" }) }),
    ]);
  });

  it("retains the visible preview through transient empty inputs and equal refreshes", () => {
    const ready = readyState("dashboard");

    expect(beginProjectContextLoad(ready, "dashboard", { status: "unavailable" })).toBe(ready);
    expect(beginProjectContextLoad(ready, "other", { status: "unavailable" })).toEqual({
      status: "loading",
      folderId: "other",
      data: null,
      message: null,
    });

    const equalRefresh = readyState("dashboard");
    expect(completeProjectContextLoad(ready, equalRefresh)).toBe(ready);
  });
});

function readyState(folderId: string): Extract<ProjectContextPreviewState, { status: "ready" }> {
  return {
    status: "ready",
    folderId,
    data: mergeProjectContextPages([{
      source: { folderId, folderName: "대시보드", pageId: "page-dashboard" },
      details: {
        guidance: [guidance("guidance", "상속 지침", "project")],
        atomReferences: [],
        sessionDefaults: [],
      },
    }]),
    message: null,
  };
}

function folder(id: string, name: string, parentFolderId: string | null, projectPageId: string | null) {
  return { id, name, parentFolderId, projectPageId, sortOrder: 0 };
}

function guidance(blockId: string, text: string, scope: string) {
  return { blockId, text, scope };
}

function atom(blockId: string, nodeId: string, depth: number) {
  return { blockId, instance: "atom" as const, nodeId, nodeTitle: nodeId, depth, titlesOnly: false };
}

function defaults(blockId: string, scope: string, agentId: string, nodeId: string) {
  return { blockId, scope, agentId, nodeId };
}

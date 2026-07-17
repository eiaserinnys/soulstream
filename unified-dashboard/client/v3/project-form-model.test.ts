import { describe, expect, it } from "vitest";

import {
  emptyProjectFormValue,
  projectFormValueFromDetails,
  projectHasContents,
} from "./project-form-model";

describe("project form model", () => {
  it("uses one canonical form shape for create and settings", () => {
    expect(emptyProjectFormValue("새 프로젝트")).toEqual({
      title: "새 프로젝트",
      guidance: [],
      atomReferences: [],
      sessionDefaults: null,
    });

    expect(projectFormValueFromDetails("기존 프로젝트", {
      guidance: [{ blockId: "g-1", text: "지침", scope: "project" }],
      atomReferences: [{
        blockId: "a-1",
        instance: "atom",
        nodeId: "node-1",
        nodeTitle: "노드",
        depth: 3,
        titlesOnly: false,
      }],
      sessionDefaults: [{
        blockId: "d-1",
        scope: "project",
        agentId: "roselin_codex",
        nodeId: "eiaserinnys",
      }],
    })).toMatchObject({
      title: "기존 프로젝트",
      guidance: [{ blockId: "g-1", text: "지침" }],
      atomReferences: [{ blockId: "a-1", nodeId: "node-1" }],
      sessionDefaults: { blockId: "d-1", agentId: "roselin_codex" },
    });
  });

  it("requires confirmation only when a project owns visible contents", () => {
    const folders = [
      { id: "root", name: "Root", sortOrder: 0, parentFolderId: null },
      { id: "child", name: "Child", sortOrder: 0, parentFolderId: "root" },
    ];
    expect(projectHasContents("empty", { folders, sessions: {}, boardItems: [] })).toBe(false);
    expect(projectHasContents("root", { folders, sessions: {}, boardItems: [] })).toBe(true);
    expect(projectHasContents("child", {
      folders,
      sessions: { "session-1": { folderId: "child", displayName: null } },
      boardItems: [],
    })).toBe(true);
    expect(projectHasContents("empty", {
      folders,
      sessions: {},
      boardItems: [{ id: "markdown:1", folderId: "empty", itemType: "markdown", itemId: "1", x: 0, y: 0 }],
    })).toBe(true);
  });
});

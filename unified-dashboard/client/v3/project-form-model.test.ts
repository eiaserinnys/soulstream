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
        mode: "index",
        limit: 3,
      }],
      sessionDefaults: [{
        blockId: "d-1",
        scope: "project",
        agentId: "roselin_codex",
        nodeId: "eiaserinnys",
        modelPreset: "preset-a",
      }],
    })).toMatchObject({
      title: "기존 프로젝트",
      guidance: [{ blockId: "g-1", text: "지침" }],
      atomReferences: [{ blockId: "a-1", nodeId: "node-1", mode: "index", limit: 3 }],
      sessionDefaults: {
        blockId: "d-1",
        agentId: "roselin_codex",
        modelPreset: "preset-a",
      },
    });
  });

  it("requires confirmation only when a project owns visible contents", () => {
    const folders = [
      { status: "open" as const, version: 1, archived: false, id: "root", name: "Root", sortOrder: 0, parentFolderId: null },
      { status: "open" as const, version: 1, archived: false, id: "child", name: "Child", sortOrder: 0, parentFolderId: "root" },
    ];
    const empty = { folders, sessions: {}, hasCards: false, hasDocuments: false };
    expect(projectHasContents("empty", empty)).toBe(false);
    expect(projectHasContents("root", empty)).toBe(true);
    expect(projectHasContents("child", {
      ...empty,
      sessions: { "session-1": { folderId: "child" } },
    })).toBe(true);
    expect(projectHasContents("empty", { ...empty, hasCards: true })).toBe(true);
    expect(projectHasContents("empty", { ...empty, hasDocuments: true })).toBe(true);
    expect(projectHasContents("empty", { ...empty, hasResources: true })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { initialFolderOperations } from "../src/folders/folder_initial_context.js";

function sequentialIds() {
  let next = 0;
  return () => `temp-${++next}`;
}

describe("initialFolderOperations context blocks", () => {
  const operations = initialFolderOperations("대시보드", "", "folder-1", sequentialIds(), {
    guidance: "실제 근거와 함께 기록한다.",
    atomReferences: [{
      instance: "atom",
      nodeId: "node-a",
      nodeTitle: "프론트엔드 아키텍처",
      depth: 2,
      titlesOnly: true,
      mode: "index",
      limit: 15,
    }],
    sessionDefaults: { agentId: "roselin", nodeId: "eiaserinnys", modelPreset: "sol" },
  });
  const byType = (type: string) => operations.filter((operation) => operation.blockType === type);

  it("writes folder guidance with the same project scope the folder settings dialog writes", () => {
    expect(byType("guidance")).toEqual([expect.objectContaining({
      text: "실제 근거와 함께 기록한다.",
      properties: { enabled: true, scope: "project" },
    })]);
  });

  it("keeps the requested atom render mode and limit on the atom_ref block", () => {
    expect(byType("atom_ref")[0]?.properties).toEqual({
      instance: "atom",
      nodeId: "node-a",
      nodeTitle: "프론트엔드 아키텍처",
      depth: 2,
      titlesOnly: true,
      mode: "index",
      limit: 15,
    });
  });

  it("omits mode when the caller did not send one", () => {
    const plain = initialFolderOperations("폴더", "", "folder-2", sequentialIds(), {
      guidance: "",
      atomReferences: [{ instance: "atom", nodeId: "node-b", nodeTitle: "세션", depth: 1, titlesOnly: false }],
    });
    expect(plain.find((operation) => operation.blockType === "atom_ref")?.properties).not.toHaveProperty("mode");
    expect(plain.some((operation) => operation.blockType === "guidance")).toBe(false);
  });

  it("writes session defaults with the session scope", () => {
    expect(byType("session_defaults")[0]?.properties).toEqual({
      agentId: "roselin", nodeId: "eiaserinnys", modelPreset: "sol", scope: "session",
    });
  });
});

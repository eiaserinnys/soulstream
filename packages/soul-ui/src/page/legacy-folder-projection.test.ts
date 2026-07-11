import { describe, expect, it } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { projectLegacyFolder } from "./legacy-folder-projection";

function summary(id: string, folderId: string): SessionSummary {
  return { agentSessionId: id, folderId, status: "running", eventCount: 0, prompt: id };
}

function catalog(x = 999, y = -999): CatalogState {
  return {
    folders: [
      { id: "root", name: "Root", sortOrder: 0 },
      { id: "child-b", name: "Child B", sortOrder: 2, parentFolderId: "root" },
      { id: "child-a", name: "Child A", sortOrder: 1, parentFolderId: "root" },
    ],
    sessions: {
      "root-session": { folderId: "root", displayName: null },
      "child-session": { folderId: "child-a", displayName: "Child session" },
    },
    boardItems: [
      { id: "markdown:doc-a", folderId: "root", itemType: "markdown", itemId: "doc-a", x, y, metadata: { title: "Notes" } },
      { id: "session:root-session", folderId: "root", itemType: "session", itemId: "root-session", x: 1, y: 1 },
      { id: "asset:file-a", folderId: "child-a", itemType: "asset", itemId: "file-a", x: 2, y: 2, metadata: { title: "Attachment" } },
    ],
  };
}

describe("projectLegacyFolder", () => {
  const sessions = [summary("root-session", "root"), summary("child-session", "child-a")];

  it("projects child folders, sessions, and board items as a read-only hierarchy", () => {
    const result = projectLegacyFolder(catalog(), sessions, "root");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    expect(result.rows.map((row) => [row.kind, row.id, row.depth])).toEqual([
      ["folder", "child-a", 0],
      ["session", "child-session", 1],
      ["board-item", "asset:file-a", 1],
      ["folder", "child-b", 0],
      ["session", "root-session", 0],
      ["board-item", "markdown:doc-a", 0],
    ]);
    expect(result.readOnly).toBe(true);
  });

  it("preserves source order and never derives hierarchy or order from board coordinates", () => {
    const first = projectLegacyFolder(catalog(999, -999), sessions, "root");
    const second = projectLegacyFolder(catalog(-10000, 50000), sessions, "root");
    expect(second).toEqual(first);
  });

  it("returns an explicit missing state for a deleted or inaccessible folder", () => {
    expect(projectLegacyFolder(catalog(), sessions, "missing")).toEqual({
      status: "missing",
      folderId: "missing",
    });
  });
});

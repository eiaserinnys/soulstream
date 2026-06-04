import { describe, expect, it } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import {
  buildBoardWorkspaceItems,
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
} from "./board-workspace-items";

const catalog: CatalogState = {
  folders: [
    {
      id: "folder-old",
      name: "Old folder",
      sortOrder: 0,
      parentFolderId: "root",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "folder-new",
      name: "New folder",
      sortOrder: 1,
      parentFolderId: "root",
      createdAt: "2026-06-03T00:00:00.000Z",
    },
    {
      id: "nested",
      name: "Nested",
      sortOrder: 0,
      parentFolderId: "folder-new",
      createdAt: "2026-06-04T00:00:00.000Z",
    },
  ],
  sessions: {
    "session-a": { folderId: "root", displayName: null },
    "session-b": { folderId: "root", displayName: "Pinned name" },
    nested: { folderId: "folder-new", displayName: null },
  },
};

const sessions: SessionSummary[] = [
  {
    agentSessionId: "session-a",
    status: "completed",
    eventCount: 10,
    prompt: "Prompt title",
    updatedAt: "2026-06-02T00:00:00.000Z",
  },
  {
    agentSessionId: "session-b",
    status: "running",
    eventCount: 12,
    prompt: "Fallback prompt",
    updatedAt: "2026-06-01T12:00:00.000Z",
    lastMessage: {
      type: "assistant",
      preview: "Latest assistant message",
      timestamp: "2026-06-04T00:00:00.000Z",
    },
    displayName: "Pinned name",
  },
];

describe("board workspace item helpers", () => {
  it("builds a single sorted item list from direct child folders and sessions", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "session:session-b",
      "folder:folder-new",
      "session:session-a",
      "folder:folder-old",
    ]);
    expect(items.find((item) => item.id === "folder-new")).toMatchObject({
      type: "folder",
      childCount: 2,
    });
  });

  it("uses lastMessage.preview for session previews and displayName for titles", () => {
    expect(getSessionBoardTitle(sessions[1])).toBe("Pinned name");
    expect(getSessionBoardPreview(sessions[1])).toBe("Latest assistant message");
    expect(getSessionBoardPreview(sessions[0])).toBe("Prompt title");
  });

  it("formats invalid or missing timestamps as an ellipsis", () => {
    expect(formatBoardWorkspaceTime(undefined)).toBe("...");
    expect(formatBoardWorkspaceTime("not-a-date")).toBe("...");
  });
});

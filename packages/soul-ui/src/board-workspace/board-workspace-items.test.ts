import { describe, expect, it } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import {
  buildBoardWorkspaceItems,
  computeBoardCanvasSize,
  findFirstOpenBoardPosition,
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
  snapBoardPosition,
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
  boardItems: [
    {
      id: "session:session-b",
      folderId: "root",
      itemType: "session",
      itemId: "session-b",
      x: 0,
      y: 0,
    },
    {
      id: "session:session-a",
      folderId: "root",
      itemType: "session",
      itemId: "session-a",
      x: 200,
      y: 40,
    },
    {
      id: "subfolder:folder-new",
      folderId: "root",
      itemType: "subfolder",
      itemId: "folder-new",
      x: 40,
      y: 160,
    },
    {
      id: "markdown:doc-root",
      folderId: "root",
      itemType: "markdown",
      itemId: "doc-root",
      x: 240,
      y: 160,
      metadata: {
        title: "Board note",
        preview: "Short markdown preview",
      },
    },
    {
      id: "subfolder:nested",
      folderId: "folder-new",
      itemType: "subfolder",
      itemId: "nested",
      x: 0,
      y: 0,
    },
    {
      id: "session:nested",
      folderId: "folder-new",
      itemType: "session",
      itemId: "nested",
      x: 160,
      y: 0,
    },
  ],
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
  it("builds a coordinate-sorted item list from catalog boardItems", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "session:session-b",
      "session:session-a",
      "folder:folder-new",
      "markdown:doc-root",
    ]);
    expect(items.find((item) => item.id === "folder-new")).toMatchObject({
      type: "folder",
      childCount: 2,
    });
    expect(items.find((item) => item.id === "doc-root")).toMatchObject({
      type: "markdown",
      title: "Board note",
      preview: "Short markdown preview",
    });
  });

  it("falls back to deterministic 280x160 placement when boardItems are absent", () => {
    const { boardItems: _unused, ...legacyCatalog } = catalog;
    const items = buildBoardWorkspaceItems({
      catalog: legacyCatalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual([
      "folder:folder-old",
      "folder:folder-new",
      "session:session-a",
      "session:session-b",
    ]);
    expect(items.map((item) => [item.x, item.y])).toEqual([
      [0, 0],
      [280, 0],
      [560, 0],
      [840, 0],
    ]);
  });

  it("keeps board session tiles visible before session summaries arrive", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "folder-new",
      sessions: [],
    });

    const sessionItem = items.find((item) => item.type === "session");
    expect(sessionItem).toMatchObject({
      type: "session",
      id: "nested",
      session: {
        agentSessionId: "nested",
        folderId: "folder-new",
        status: "unknown",
        eventCount: 0,
      },
    });
  });

  it("snaps positions to 20px, allows negative coordinates, and finds the first empty tile slot", () => {
    const items = buildBoardWorkspaceItems({
      catalog,
      selectedFolderId: "root",
      sessions,
    });

    expect(snapBoardPosition(59, 101)).toEqual({ x: 60, y: 100 });
    expect(snapBoardPosition(-31, -51)).toEqual({ x: -40, y: -60 });
    expect(findFirstOpenBoardPosition(items)).toEqual({ x: 280, y: 0 });
    expect(computeBoardCanvasSize(items)).toEqual({ width: 720, height: 520 });
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

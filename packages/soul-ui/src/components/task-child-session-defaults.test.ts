import { describe, expect, it } from "vitest";

import type { CatalogState, SessionSummary, TaskItem } from "../shared";
import { resolveTaskChildSessionDefaults } from "./task-child-session-defaults";

const BASE_TASK: TaskItem = {
  id: "task-parent",
  parentId: null,
  positionKey: 1,
  title: "Parent task",
  description: "",
  acceptanceCriteria: "",
  verificationOwner: "both",
  status: "in_progress",
  linkedSessionId: "parent-session",
  linkedNodeId: "fallback-node",
  activeForSessionId: null,
  createdFromSessionId: "creator-session",
  createdFromEventId: null,
  navigationSessionId: null,
  navigationNodeId: null,
  navigationEventId: null,
  archived: false,
  pinned: false,
  version: 1,
  createdAt: "2026-06-01T00:00:00Z",
  updatedAt: "2026-06-01T00:00:00Z",
};

const BASE_SESSION: SessionSummary = {
  agentSessionId: "parent-session",
  status: "completed",
  eventCount: 3,
  nodeId: "parent-node",
  agentId: "parent-agent",
  agentName: "Parent Agent",
};

const BASE_CATALOG: CatalogState = {
  folders: [
    { id: "folder-a", name: "Folder A", sortOrder: 1, settings: {} },
  ],
  sessions: {
    "parent-session": { folderId: "folder-a", displayName: null },
  },
};

describe("resolveTaskChildSessionDefaults", () => {
  it("inherits folder, node, and agent from the parent task session", () => {
    const result = resolveTaskChildSessionDefaults(
      BASE_TASK,
      new Map([["parent-session", BASE_SESSION]]),
      BASE_CATALOG,
    );

    expect(result).toEqual({
      folderId: "folder-a",
      nodeId: "parent-node",
      agentId: "parent-agent",
    });
  });

  it("uses the task node when the parent session summary is not loaded", () => {
    const result = resolveTaskChildSessionDefaults(
      BASE_TASK,
      new Map(),
      BASE_CATALOG,
    );

    expect(result).toEqual({
      folderId: "folder-a",
      nodeId: "fallback-node",
    });
  });

  it("returns null when the parent session has no inheritable values", () => {
    const result = resolveTaskChildSessionDefaults(
      {
        ...BASE_TASK,
        linkedSessionId: "empty-session",
        linkedNodeId: null,
        createdFromSessionId: null,
      },
      new Map([[
        "empty-session",
        { ...BASE_SESSION, agentSessionId: "empty-session", nodeId: undefined, agentId: null },
      ]]),
      {
        folders: [],
        sessions: {
          "empty-session": { folderId: null, displayName: null },
        },
      },
    );

    expect(result).toBeNull();
  });
});

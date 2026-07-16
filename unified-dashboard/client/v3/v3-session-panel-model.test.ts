import { describe, expect, it } from "vitest";
import type { CatalogBoardItem, SessionSummary } from "@seosoyoung/soul-ui";

import {
  sessionPanelGroups,
  sessionPanelTitle,
  sessionWorkspaceTargetFromBoardItems,
} from "./v3-session-panel-model";

describe("v3 session panel model", () => {
  it("separates running and completed review sessions without cloning rows", () => {
    const running = session("running", "running", "not_required", "2026-07-16T03:00:00Z");
    const review = session("review", "completed", "needs_review", "2026-07-16T02:00:00Z");
    const acknowledged = session("done", "completed", "acknowledged", "2026-07-16T04:00:00Z");

    const groups = sessionPanelGroups([review, acknowledged, running]);

    expect(groups.running).toEqual([running]);
    expect(groups.review).toEqual([review]);
    expect(groups.running[0]).toBe(running);
    expect(groups.review[0]).toBe(review);
  });

  it("separates running sessions whose assigned node disappeared from a ready snapshot", () => {
    const connected = {
      ready: true,
      connectedNodeIds: new Set(["node-online"]),
    };
    const online = {
      ...session("online", "running", "not_required", "2026-07-16T03:00:00Z"),
      nodeId: "node-online",
    };
    const offline = {
      ...session("offline", "running", "not_required", "2026-07-16T04:00:00Z"),
      nodeId: "node-offline",
    };

    const groups = sessionPanelGroups([online, offline], connected);

    expect(groups.running).toEqual([online]);
    expect(groups.offline).toEqual([offline]);
  });

  it("does not infer offline before the first node snapshot", () => {
    const running = {
      ...session("running", "running", "not_required", "2026-07-16T03:00:00Z"),
      nodeId: "node-not-loaded-yet",
    };

    expect(sessionPanelGroups([running], {
      ready: false,
      connectedNodeIds: new Set(),
    })).toMatchObject({ running: [running], offline: [] });
  });

  it("sorts each group by recent activity while preserving equal-session identity", () => {
    const older = session("older", "running", "not_required", "2026-07-16T01:00:00Z");
    const newer = session("newer", "running", "not_required", "2026-07-16T02:00:00Z");

    expect(sessionPanelGroups([older, newer]).running).toEqual([newer, older]);
  });

  it("uses display name, then last message, then a quiet fallback without UUID exposure", () => {
    expect(sessionPanelTitle({
      ...session("secret-uuid", "running", "not_required", "2026-07-16T01:00:00Z"),
      displayName: "  이름 있는 세션  ",
      lastMessage: { type: "assistant", preview: "fallback", timestamp: "2026-07-16T01:00:00Z" },
    })).toBe("이름 있는 세션");
    expect(sessionPanelTitle({
      ...session("secret-uuid", "running", "not_required", "2026-07-16T01:00:00Z"),
      lastMessage: { type: "assistant", preview: "  마지막\n메시지  ", timestamp: "2026-07-16T01:00:00Z" },
    })).toBe("마지막 메시지");
    expect(sessionPanelTitle(session("secret-uuid", "running", "not_required", "2026-07-16T01:00:00Z")))
      .toBe("제목 없는 세션");
  });

  it("resolves only the primary session board item and treats folder containers as standalone", () => {
    const items: CatalogBoardItem[] = [
      boardItem("reference", "runbook", "rb-reference"),
      boardItem("primary", "runbook", "rb-task"),
    ];

    expect(sessionWorkspaceTargetFromBoardItems(items, "session-a"))
      .toEqual({ kind: "task", pageId: "rb-task" });
    expect(sessionWorkspaceTargetFromBoardItems([
      boardItem("primary", "folder", "folder-a"),
    ], "session-a")).toEqual({ kind: "standalone" });
    expect(sessionWorkspaceTargetFromBoardItems(items, "missing")).toBeNull();
  });
});

function session(
  id: string,
  status: SessionSummary["status"],
  reviewState: SessionSummary["reviewState"],
  updatedAt: string,
): SessionSummary {
  return { agentSessionId: id, status, reviewState, updatedAt, eventCount: 0 };
}

function boardItem(
  membershipKind: CatalogBoardItem["membershipKind"],
  containerKind: NonNullable<CatalogBoardItem["containerKind"]>,
  containerId: string,
): CatalogBoardItem {
  return {
    id: `${membershipKind}:${containerId}`,
    folderId: "folder-a",
    containerKind,
    containerId,
    membershipKind,
    itemType: "session",
    itemId: "session-a",
    x: 0,
    y: 0,
  };
}

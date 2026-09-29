import { describe, expect, it } from "vitest";
import type { CatalogBoardItem, CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";

import {
  sessionPanelGroups,
  sessionPanelAffiliation,
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

  it("shows an acknowledged review again after the session becomes running", () => {
    const stillReview = session("review", "completed", "needs_review", "2026-07-16T04:00:00Z");
    const updated = session("review", "running", "not_required", "2026-07-16T05:00:00Z");

    const acknowledged = new Set(["review"]);
    const pendingGroups = sessionPanelGroups([stillReview], undefined, acknowledged);
    const updatedGroups = sessionPanelGroups([updated], undefined, acknowledged);

    expect(pendingGroups.review).toEqual([]);
    expect(updatedGroups.running).toEqual([updated]);
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
      lastMessage: { type: "assistant_message", preview: "fallback", timestamp: "2026-07-16T01:00:00Z" },
    })).toBe("이름 있는 세션");
    expect(sessionPanelTitle({
      ...session("secret-uuid", "running", "not_required", "2026-07-16T01:00:00Z"),
      lastMessage: { type: "assistant_message", preview: "  마지막\n메시지  ", timestamp: "2026-07-16T01:00:00Z" },
    })).toBe("마지막 메시지");
    expect(sessionPanelTitle(session("secret-uuid", "running", "not_required", "2026-07-16T01:00:00Z")))
      .toBe("제목 없는 세션");
  });

  it("opens the folder that owns the primary session board item", () => {
    const items: CatalogBoardItem[] = [
      boardItem("reference", "other-folder"),
      boardItem("primary", "folder-a"),
    ];
    expect(sessionWorkspaceTargetFromBoardItems(items, "session-a"))
      .toEqual({ kind: "folder", folderId: "folder-a" });
    expect(sessionWorkspaceTargetFromBoardItems(items, "missing")).toBeNull();
  });

  it("uses the owning folder name for session affiliation", () => {
    const folders: CatalogFolder[] = [
      { checklistEnabled: false, status: "open" as const, version: 1, archived: false, id: "folder-a", name: "소울스트림", sortOrder: 0 },
    ];
    expect(sessionPanelAffiliation([boardItem("primary", "folder-a")], folders, "session-a"))
      .toBe("소울스트림");
    expect(sessionPanelAffiliation([], folders, "session-a")).toBeNull();
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
  folderId: string,
): CatalogBoardItem {
  return {
    id: `${membershipKind}:${folderId}`,
    folderId,
    membershipKind,
    itemType: "session",
    itemId: "session-a",
    x: 0,
    y: 0,
  };
}

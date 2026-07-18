// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogBoardItem, CatalogFolder, SessionReviewAcknowledgeResult, SessionSummary } from "@seosoyoung/soul-ui";

const acknowledgeSessionReview = vi.hoisted(() => vi.fn());

vi.mock("@seosoyoung/soul-ui", () => ({
  acknowledgeSessionReview,
  DashboardIconCap: ({
    children,
    label,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) => (
    <button {...props} aria-label={label} title={label}>{children}</button>
  ),
  ProfileAvatar: ({ fallbackEmoji }: { fallbackEmoji: string }) => (
    <span data-testid="profile-avatar">{fallbackEmoji}</span>
  ),
  SessionContextMenu: () => null,
  SessionReviewAcknowledgeError: class SessionReviewAcknowledgeError extends Error {},
  useGlassSurface: () => false,
}));

import { V3SessionPanel } from "./V3SessionPanel";

describe("V3SessionPanel", () => {
  afterEach(() => {
    acknowledgeSessionReview.mockReset();
    document.body.replaceChildren();
  });

  it("renders catalog sessions through the rich row and opens the selected session", () => {
    const onOpenSession = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    flushSync(() => {
      root.render(
        <V3SessionPanel
          sessions={[session("running-1", "running"), session("review-1", "completed")]}
          boardItems={affiliationBoardItems("running-1")}
          folders={projectFolders}
          nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["eiaserinnys"]) }}
          activeSessionId={null}
          onOpenSession={onOpenSession}
          onRenameSession={async () => undefined}
          onDeleteSessions={async () => undefined}
          onAcknowledged={() => undefined}
        />,
      );
    });

    const runningRow = host.querySelector('[data-testid="v3-session-row-running-1"]');
    expect(runningRow?.querySelector(".v3-run-row")).not.toBeNull();
    expect(runningRow?.textContent).toContain("running-1");
    expect(runningRow?.textContent).toContain("로젤린");
    expect(runningRow?.textContent).toContain("eiaserinnys");
    expect(runningRow?.textContent).toContain("마지막 진행 메시지");
    expect(runningRow?.textContent).toContain("PR-BY 업무 · 소울스트림");
    expect(runningRow?.querySelector(".v3-run-affiliation")?.getAttribute("title"))
      .toBe("PR-BY 업무 · 소울스트림");
    expect(runningRow?.textContent).toContain("실행 중");
    expect(runningRow?.querySelector('[data-testid="profile-avatar"]')).not.toBeNull();
    expect(runningRow?.querySelector(".v3-run-trailing time")?.textContent).toMatch(/전$/);
    expect(host.querySelector('[data-testid="v3-session-group-review"]')?.textContent).toContain("review-1");
    flushSync(() => { runningRow?.querySelector<HTMLButtonElement>(".v3-run-open")?.click(); });
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: "running-1" }));
    flushSync(() => { root.unmount(); });
  });

  it("removes only the acknowledged row and keeps the panel mounted", async () => {
    acknowledgeSessionReview.mockResolvedValue({
      status: "ok",
      agentSessionId: "review-1",
      reviewState: "acknowledged",
      changed: true,
    } satisfies SessionReviewAcknowledgeResult);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function Harness() {
      const [sessions, setSessions] = useState([
        session("review-1", "completed"),
        session("review-2", "completed"),
      ]);
      return (
        <V3SessionPanel
          sessions={sessions}
          boardItems={[]}
          folders={[]}
          nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["eiaserinnys"]) }}
          activeSessionId={null}
          onOpenSession={() => undefined}
          onRenameSession={async () => undefined}
          onDeleteSessions={async () => undefined}
          onAcknowledged={(result) => setSessions((current) => current.filter((item) => item.agentSessionId !== result.agentSessionId))}
        />
      );
    }

    flushSync(() => { root.render(<Harness />); });
    const untouched = host.querySelector('[data-testid="v3-session-row-review-2"]');
    flushSync(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="review-1 확인 처리"]')?.click();
    });

    await vi.waitFor(() => expect(host.querySelector('[data-testid="v3-session-row-review-1"]')).toBeNull());
    expect(host.querySelector('[data-testid="v3-session-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v3-session-row-review-2"]')).toBe(untouched);
    flushSync(() => { root.unmount(); });
  });

  it("moves a running session on a disconnected node into an offline group", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    flushSync(() => {
      root.render(
        <V3SessionPanel
          sessions={[{ ...session("offline-1", "running"), nodeId: "node-offline" }]}
          boardItems={[]}
          folders={[]}
          nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["eiaserinnys"]) }}
          activeSessionId={null}
          onOpenSession={() => undefined}
          onRenameSession={async () => undefined}
          onDeleteSessions={async () => undefined}
          onAcknowledged={() => undefined}
        />,
      );
    });

    expect(host.querySelector('[data-testid="v3-session-group-running"]')?.textContent)
      .not.toContain("offline-1");
    const offlineGroup = host.querySelector('[data-testid="v3-session-group-offline"]');
    expect(offlineGroup?.textContent).toContain("offline-1");
    expect(offlineGroup?.textContent).toContain("노드 오프라인");

    flushSync(() => {
      root.render(
        <V3SessionPanel
          sessions={[{ ...session("offline-1", "running"), nodeId: "node-offline" }]}
          boardItems={[]}
          folders={[]}
          nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["node-offline"]) }}
          activeSessionId={null}
          onOpenSession={() => undefined}
          onRenameSession={async () => undefined}
          onDeleteSessions={async () => undefined}
          onAcknowledged={() => undefined}
        />,
      );
    });

    expect(host.querySelector('[data-testid="v3-session-group-offline"]')).toBeNull();
    expect(host.querySelector('[data-testid="v3-session-group-running"]')?.textContent)
      .toContain("offline-1");
    expect(host.querySelector('[data-testid="v3-session-group-running"]')?.textContent)
      .toContain("실행 중");
    flushSync(() => { root.unmount(); });
  });
});

function session(agentSessionId: string, status: "running" | "completed"): SessionSummary {
  return {
    agentSessionId,
    displayName: agentSessionId,
    status,
    reviewState: status === "completed" ? "needs_review" : null,
    eventCount: 1,
    createdAt: "2026-07-16T00:00:00Z",
    updatedAt: "2026-07-16T00:05:00Z",
    lastMessage: {
      type: "assistant",
      preview: "마지막 진행 메시지",
      timestamp: "2026-07-16T00:05:00Z",
    },
    nodeId: "eiaserinnys",
    agentId: "roselin_codex",
    agentName: "로젤린",
  } as SessionSummary;
}

const projectFolders: CatalogFolder[] = [
  { id: "project-folder", name: "소울스트림", sortOrder: 0, projectPageId: "project-page" },
];

function affiliationBoardItems(sessionId: string): CatalogBoardItem[] {
  return [
    {
      id: `session:${sessionId}`,
      folderId: "project-folder",
      containerKind: "task",
      containerId: "task-a",
      membershipKind: "primary",
      itemType: "session",
      itemId: sessionId,
      x: 0,
      y: 0,
    },
    {
      id: "task:task-a",
      folderId: "project-folder",
      containerKind: "folder",
      containerId: "project-folder",
      membershipKind: "primary",
      itemType: "task",
      itemId: "task-a",
      x: 0,
      y: 0,
      metadata: { title: "PR-BY 업무" },
    },
  ];
}

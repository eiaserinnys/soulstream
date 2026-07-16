// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionReviewAcknowledgeResult, SessionSummary } from "@seosoyoung/soul-ui";

const acknowledgeSessionReview = vi.hoisted(() => vi.fn());

vi.mock("@seosoyoung/soul-ui", () => ({
  acknowledgeSessionReview,
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

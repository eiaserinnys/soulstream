// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionReviewAcknowledgeResult, SessionSummary } from "@seosoyoung/soul-ui";

const acknowledgeSessionReview = vi.hoisted(() => vi.fn());

vi.mock("@seosoyoung/soul-ui", () => ({
  acknowledgeSessionReview,
  Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => <button {...props} />,
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SessionContextMenu: () => null,
  SessionReviewAcknowledgeError: class SessionReviewAcknowledgeError extends Error {},
}));

vi.mock("./RichSessionRow", () => ({
  RichSessionRow: ({ session, actions }: { session: SessionSummary; actions: React.ReactNode }) => (
    <div data-testid={`row-${session.agentSessionId}`}>{session.agentSessionId}{actions}</div>
  ),
}));

import { ReviewQueuePanel } from "./ReviewQueuePanel";

describe("ReviewQueuePanel", () => {
  afterEach(() => {
    acknowledgeSessionReview.mockReset();
    document.body.replaceChildren();
  });

  it("keeps the dialog and untouched row mounted while acknowledging one row", async () => {
    acknowledgeSessionReview.mockResolvedValue({
      status: "ok",
      agentSessionId: "review-1",
      reviewState: "acknowledged",
      changed: true,
    } satisfies SessionReviewAcknowledgeResult);
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    function Harness() {
      const [sessions, setSessions] = useState([session("review-1"), session("review-2")]);
      return (
        <ReviewQueuePanel
          open
          companionOpen={false}
          sessions={sessions}
          onClose={onClose}
          onOpenSession={() => undefined}
          onRenameSession={async () => undefined}
          onDeleteSessions={async () => undefined}
          onAcknowledged={(result) => setSessions((current) => current.filter((item) => item.agentSessionId !== result.agentSessionId))}
        />
      );
    }

    flushSync(() => { root.render(<Harness />); });
    const untouched = host.querySelector('[data-testid="row-review-2"]');
    const acknowledgeButton = host.querySelector<HTMLButtonElement>('[aria-label="review-1 확인 처리"]');
    expect(acknowledgeButton).not.toBeNull();

    flushSync(() => {
      acknowledgeButton?.focus();
      acknowledgeButton?.click();
    });

    await vi.waitFor(() => expect(host.querySelector('[data-testid="row-review-1"]')).toBeNull());

    expect(host.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="row-review-1"]')).toBeNull();
    expect(host.querySelector('[data-testid="row-review-2"]')).toBe(untouched);
    expect(document.activeElement).toBe(host.querySelector('[data-testid="v3-review-queue-list"]'));
    expect(onClose).not.toHaveBeenCalled();
    flushSync(() => { root.unmount(); });
  });

  it("stays open on the explicit empty state after acknowledging the last row", async () => {
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
      const [sessions, setSessions] = useState([session("review-1")]);
      return (
        <ReviewQueuePanel
          open
          companionOpen={false}
          sessions={sessions}
          onClose={() => undefined}
          onOpenSession={() => undefined}
          onRenameSession={async () => undefined}
          onDeleteSessions={async () => undefined}
          onAcknowledged={() => setSessions([])}
        />
      );
    }

    flushSync(() => { root.render(<Harness />); });
    flushSync(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="review-1 확인 처리"]')?.click();
    });

    await vi.waitFor(() => expect(host.textContent).toContain("검수 대기 세션이 없습니다."));

    expect(host.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(host.textContent).toContain("검수 대기 세션이 없습니다.");
    flushSync(() => { root.unmount(); });
  });
});

function session(agentSessionId: string): SessionSummary {
  return {
    agentSessionId,
    displayName: agentSessionId,
    status: "completed",
    reviewState: "needs_review",
    eventCount: 1,
  };
}

/**
 * @vitest-environment jsdom
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@seosoyoung/soul-ui";

import { ProjectLegacySessionsSection } from "./ProjectLegacySessionsSection";

describe("ProjectLegacySessionsSection", () => {
  it("renders the loaded count, RichSessionRow, and a bounded load-more action", () => {
    const html = renderToStaticMarkup(
      <ProjectLegacySessionsSection
        sessions={[session("legacy-a"), session("legacy-b")]}
        liveSessions={[{ ...session("legacy-a"), displayName: "실시간 제목" }]}
        nodeConnectivity={{ ready: true, connectedNodeIds: new Set(["node-a"]) }}
        loading={false}
        loadingMore={false}
        error={null}
        hasMore
        onLoadMore={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    expect(html).toContain("레가시 세션");
    expect(html).toContain("2개+");
    expect(html).toContain("실시간 제목");
    expect(html).toContain('data-session-id="legacy-b"');
    expect(html).toContain('data-testid="v3-load-more-project-legacy-sessions"');
  });
});

function session(agentSessionId: string): SessionSummary {
  return {
    agentSessionId,
    status: "completed",
    eventCount: 0,
    displayName: agentSessionId,
    agentId: "roselin",
    nodeId: "node-a",
    updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

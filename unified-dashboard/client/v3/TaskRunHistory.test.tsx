import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@seosoyoung/soul-ui";

import { TaskRunHistory } from "./TaskRunHistory";

describe("TaskRunHistory", () => {
  it("renders rich catalog data, a loading skeleton, and a run-number failure fallback", () => {
    const richSession: SessionSummary = {
      agentSessionId: "catalog-hit",
      status: "running",
      eventCount: 42,
      displayName: "라이브 코디네이터 세션",
      agentId: "roselin_codex",
      agentName: "로젤린",
      nodeId: "eiaserinnys",
      lastMessage: {
        type: "assistant",
        preview: "마지막 메시지 한 줄",
        timestamp: new Date().toISOString(),
      },
      createdAt: "2026-07-14T00:00:00Z",
    };
    const html = renderToStaticMarkup(
      <TaskRunHistory
        taskTitle="PR-J"
        taskPageId="page-pr-j"
        runbookId="rb-pr-j"
        contextCount={0}
        sessionDefaults={null}
        predecessorSessionId={null}
        sessionIds={["catalog-hit", "loading-miss", "failed-miss"]}
        sessions={[richSession]}
        runSessionLoadStates={new Map([
          ["catalog-hit", "ready"],
          ["loading-miss", "loading"],
          ["failed-miss", "failed"],
        ])}
        onOpenSession={vi.fn()}
        onSessionCreated={vi.fn()}
      />,
    );

    expect(html).toContain("라이브 코디네이터 세션");
    expect(html).toContain("로젤린");
    expect(html).toContain("eiaserinnys");
    expect(html).toContain("마지막 메시지 한 줄");
    expect(html).toContain("run #1");
    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain("run #3");
    expect(html).toContain("조회 실패");
  });
});

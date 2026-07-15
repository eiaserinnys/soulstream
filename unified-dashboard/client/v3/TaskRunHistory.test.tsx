import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionSummary } from "@seosoyoung/soul-ui";

import { getRunSessionRenamePrefill, TaskRunHistory } from "./TaskRunHistory";

describe("TaskRunHistory", () => {
  it("uses only displayName for rename prefill and never falls back to the prompt", () => {
    const promptOnly = {
      agentSessionId: "prompt-only",
      prompt: "전체 사용자 프롬프트",
    } as SessionSummary;

    expect(getRunSessionRenamePrefill([promptOnly], "prompt-only")).toBe("");
    expect(getRunSessionRenamePrefill([
      { ...promptOnly, displayName: "표시 이름" },
    ], "prompt-only")).toBe("표시 이름");
  });

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
        contextItems={[]}
        pageContextSources={{
          key: "page_context_sources",
          label: "Project and task page context sources",
          content: { pages: [{ page_id: "page-pr-j" }] },
        }}
        contextPending={false}
        sessionDefaults={null}
        predecessorSessionId={null}
        sessionIds={["catalog-hit", "loading-miss", "failed-miss"]}
        sessions={[richSession]}
        moveTargets={[]}
        runHistoryTotal={61}
        runHistoryHasMore
        runHistoryLoading={false}
        onLoadMoreRuns={vi.fn()}
        runSessionLoadStates={new Map([
          ["catalog-hit", "ready"],
          ["loading-miss", "loading"],
          ["failed-miss", "failed"],
        ])}
        onOpenSession={vi.fn()}
        onSessionCreated={vi.fn()}
        onRenameSession={vi.fn()}
        onDeleteSessions={vi.fn()}
        onMoveSession={vi.fn()}
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
    expect(html).not.toContain(">재개<");
    expect(html).not.toContain("aria-label=\"라이브 코디네이터 세션 요약\"");
    expect(html).not.toContain("v3-run-summary");
    expect(html).toContain("＋ 새 세션");
    expect(html).toContain("3/61회");
    expect(html).toContain("이전 Run 더 보기");
    expect(html).not.toContain("▶ 새 세션");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorSessionProvider } from "./OrchestratorSessionProvider";

const CONTRACT_PATH = fileURLToPath(
  new URL(
    "../../../packages/wire-schema/fixtures/session_serialization_contract.json",
    import.meta.url,
  ),
);

function loadCase(): Record<string, any> {
  const data = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  return data.cases[0];
}

function jsonShape(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("OrchestratorSessionProvider session serialization contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the soul-ui session mapper while preserving the provider summary shape", async () => {
    const fixture = loadCase();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [fixture.expectedOrchResponse],
          total: 1,
        }),
      }),
    );

    const result = await new OrchestratorSessionProvider().fetchSessions();

    expect(jsonShape(result.sessions[0])).toEqual(
      fixture.expectedUnifiedDashboardSession,
    );
    expect(result).toMatchObject({ total: 1, hasMore: false });
  });

  it("loads 250 referenced sessions in URL-safe batches without dropping any", async () => {
    const fixture = loadCase();
    const sessionIds = Array.from({ length: 250 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://example.test");
      const requested = url.searchParams.getAll("session_id");
      return {
        ok: true,
        json: async () => ({
          sessions: requested.map((sessionId) => ({
            ...fixture.expectedOrchResponse,
            agentSessionId: sessionId,
            agent_session_id: sessionId,
          })),
          total: requested.length,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OrchestratorSessionProvider().fetchSessions({ sessionIds });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.every(([url]) => String(url).length <= 6_000)).toBe(true);
    expect(fetchMock.mock.calls.every(([input]) => {
      const url = new URL(String(input), "https://example.test");
      return url.searchParams.get("limit") === "200" &&
        url.searchParams.getAll("session_id").length <= 200;
    })).toBe(true);
    expect(result.sessions.map((session) => session.agentSessionId)).toEqual(sessionIds);
    expect(result).toMatchObject({ total: 250, hasMore: false });
  });

  it("requests the full canonical review queue without recent-window pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [], total: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await new OrchestratorSessionProvider().fetchSessions({
      reviewState: "needs_review",
      limit: 0,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://example.test");
    expect(url.searchParams.get("review_state")).toBe("needs_review");
    expect(url.searchParams.get("limit")).toBe("0");
  });

  it("preserves awaySummary for the run history summary toggle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [{
            agentSessionId: "run-a",
            status: "completed",
            awaySummary: "검증을 마치고 PR 준비 중입니다.",
          }],
          total: 1,
        }),
      }),
    );

    const result = await new OrchestratorSessionProvider().fetchSessions();

    expect(result.sessions[0]?.awaySummary).toBe("검증을 마치고 PR 준비 중입니다.");
  });

  it("preserves compact attention and notice baselines from the shared mapper", async () => {
    const attention = {
      id: "sess-a:41",
      sourceEventId: 41,
      sessionId: "sess-a",
      kind: "input_request",
      requestedAt: "2026-09-07T00:00:00.000Z",
      title: "질문",
      body: "계속할까요?",
      requiresDetail: false,
    };
    const notice = {
      id: "sess-a:42",
      sourceEventId: 42,
      sessionId: "sess-a",
      kind: "complete",
      createdAt: "2026-09-07T00:00:01.000Z",
      title: "완료",
      body: "작업이 끝났습니다.",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [{
            agent_session_id: "sess-a",
            status: "running",
            pending_attentions: [attention],
            attention_revision: 7,
            recent_notices: [notice],
            notification_watermark: 42,
            notices_truncated: true,
          }],
          total: 1,
        }),
      }),
    );

    const result = await new OrchestratorSessionProvider().fetchSessions();

    expect(result.sessions[0]).toMatchObject({
      pendingAttentions: [attention],
      attentionRevision: 7,
      recentNotices: [notice],
      notificationWatermark: 42,
      noticesTruncated: true,
    });
  });
});

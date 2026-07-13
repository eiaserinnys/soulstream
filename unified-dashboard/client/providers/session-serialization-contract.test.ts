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
    expect(result.sessions.map((session) => session.agentSessionId)).toEqual(sessionIds);
    expect(result).toMatchObject({ total: 250, hasMore: false });
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
});

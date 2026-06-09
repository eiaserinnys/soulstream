import { describe, expect, it, vi } from "vitest";

import type { SessionRow, ListSessionSummaryRow } from "../../src/db/session_db.js";
import { buildSupervisorSnapshotSessionSummaries } from "../../src/supervisor/wake_snapshot.js";

describe("Supervisor wake snapshot filtering", () => {
  it("keeps whitelisted caller sources and critical sessions while dropping automatic noise", async () => {
    const now = new Date("2026-06-10T00:00:00.000Z");
    const summaryRows = [
      makeSummaryRow("sess-browser", now),
      makeSummaryRow("sess-llm", now),
      makeSummaryRow("sess-system-error", now),
      makeSummaryRow("sess-missing-error", now),
      makeSummaryRow("sess-self-error", now),
      makeSummaryRow("sess-missing-source", now),
    ];
    const fullRows = new Map<string, SessionRow>([
      [
        "sess-browser",
        makeSessionRow("sess-browser", now, {
          callerSource: "browser",
          agentId: "worker",
          status: "completed",
        }),
      ],
      [
        "sess-llm",
        makeSessionRow("sess-llm", now, {
          callerSource: "llm",
          agentId: "worker",
          status: "completed",
        }),
      ],
      [
        "sess-system-error",
        makeSessionRow("sess-system-error", now, {
          callerSource: "system",
          agentId: "worker",
          status: "error",
          terminationDetail: "tool failed",
        }),
      ],
      [
        "sess-missing-error",
        makeSessionRow("sess-missing-error", now, {
          callerSource: null,
          agentId: "worker",
          status: "error",
        }),
      ],
      [
        "sess-self-error",
        makeSessionRow("sess-self-error", now, {
          callerSource: "slack",
          agentId: "ariela_codex",
          status: "error",
        }),
      ],
      [
        "sess-missing-source",
        makeSessionRow("sess-missing-source", now, {
          callerSource: null,
          agentId: "worker",
          status: "completed",
        }),
      ],
    ]);
    const db = {
      listSessionsSummary: vi.fn(async () => ({
        sessions: summaryRows,
        total: summaryRows.length,
      })),
      getSession: vi.fn(async (sessionId: string) => fullRows.get(sessionId) ?? null),
    };

    const summaries = await buildSupervisorSnapshotSessionSummaries(
      "ariela_codex",
      db,
      { warn: vi.fn() },
    );

    expect(summaries.map((summary) => summary.sessionId)).toEqual([
      "sess-browser",
      "sess-system-error",
      "sess-missing-error",
    ]);
    expect(summaries.find((summary) => summary.sessionId === "sess-browser")
      ?.callerSource).toBe("browser");
    expect(summaries.find((summary) => summary.sessionId === "sess-system-error")
      ?.terminationDetail).toBe("tool failed");
  });
});

function makeSummaryRow(sessionId: string, now: Date): ListSessionSummaryRow {
  return {
    session_id: sessionId,
    display_name: sessionId,
    status: "completed",
    session_type: "llm",
    created_at: now,
    updated_at: now,
    event_count: 10,
    away_summary: null,
    caller_session_id: null,
    last_event_id: null,
    last_read_event_id: null,
    node_id: "node-a",
  };
}

function makeSessionRow(
  sessionId: string,
  now: Date,
  params: {
    callerSource: string | null;
    agentId: string;
    status: string;
    terminationDetail?: string | null;
  },
): SessionRow {
  return {
    session_id: sessionId,
    folder_id: null,
    display_name: sessionId,
    node_id: "node-a",
    session_type: "llm",
    status: params.status,
    prompt: null,
    client_id: null,
    claude_session_id: null,
    last_message: null,
    metadata: params.callerSource
      ? [{ type: "caller_info", value: { source: params.callerSource } }]
      : [],
    was_running_at_shutdown: false,
    last_event_id: null,
    last_read_event_id: null,
    created_at: now,
    updated_at: now,
    agent_id: params.agentId,
    caller_session_id: null,
    away_summary: null,
    termination_reason: null,
    termination_detail: params.terminationDetail ?? null,
  };
}

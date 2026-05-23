import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import {
  SessionListCommandError,
  SessionListCommands,
} from "../../src/upstream/session_list_commands.js";

function createSessionDb(overrides: Partial<SessionDB> = {}): SessionDB {
  return {
    listSessionsSummary: vi.fn(async () => ({ sessions: [], total: 0 })),
    ...overrides,
  } as unknown as SessionDB;
}

describe("session list command boundary", () => {
  it("queries all session summaries with the hard limit and builds sessions_update wire", async () => {
    const summaryRows = [
      {
        session_id: "sess-a",
        display_name: "A",
        status: "running",
        session_type: "claude",
        created_at: new Date("2026-05-19T00:00:00Z"),
        updated_at: new Date("2026-05-20T00:00:00Z"),
        event_count: 12,
        away_summary: null,
        caller_session_id: null,
      },
      {
        session_id: "sess-b",
        display_name: "B",
        status: "completed",
        session_type: "codex",
        created_at: new Date("2026-05-18T00:00:00Z"),
        updated_at: new Date("2026-05-19T00:00:00Z"),
        event_count: 7,
        away_summary: "지난 세션 요약",
        caller_session_id: "parent-sess",
      },
    ];
    const listSessionsSummary = vi.fn(async () => ({
      sessions: summaryRows,
      total: 2,
    }));
    const commands = new SessionListCommands(
      createSessionDb({ listSessionsSummary } as unknown as Partial<SessionDB>),
    );

    const ack = await commands.listSessions({ requestId: "list-1" });

    expect(listSessionsSummary).toHaveBeenCalledWith({
      limit: 10_000,
      offset: 0,
    });
    expect(ack).toEqual({
      type: "sessions_update",
      sessions: summaryRows,
      total: 2,
      requestId: "list-1",
    });
  });

  it("preserves Python parity by returning an empty requestId when absent", async () => {
    const commands = new SessionListCommands(createSessionDb());

    const ack = await commands.listSessions({ requestId: "" });

    expect(ack.requestId).toBe("");
  });

  it("fails explicitly when the session DB dependency is not configured", async () => {
    const commands = new SessionListCommands(undefined);

    await expect(commands.listSessions({ requestId: "list-bad" })).rejects.toEqual(
      new SessionListCommandError(
        "list_sessions handler requires session_db dependency — wire main.ts CommandDispatcher with SessionDB",
      ),
    );
  });
});

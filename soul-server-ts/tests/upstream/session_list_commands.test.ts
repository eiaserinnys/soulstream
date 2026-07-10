import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import {
  SessionListCommandError,
  SessionListCommands,
} from "../../src/upstream/session_list_commands.js";

function createSessionDb(overrides: Partial<SessionDB> = {}): SessionDB {
  return {
    listSessionsForUpstreamDump: vi.fn(async () => ({ sessions: [], total: 0 })),
    ...overrides,
  } as unknown as SessionDB;
}

describe("session list command boundary", () => {
  it("queries full session rows so reconnect dumps preserve agent identity", async () => {
    const sessionRows = [
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
        last_event_id: 12,
        last_read_event_id: 0,
        node_id: "node-1",
        agent_id: "agent-a",
        prompt: "hello",
        folder_id: "folder-a",
        metadata: [{ type: "caller_info", value: { source: "agent" } }],
        last_message: null,
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
        last_event_id: 7,
        last_read_event_id: 6,
        node_id: "node-1",
        agent_id: "agent-b",
        prompt: "world",
        folder_id: "folder-b",
        metadata: [],
        last_message: { type: "assistant_message", preview: "done" },
      },
    ];
    const listSessionsForUpstreamDump = vi.fn(async () => ({
      sessions: sessionRows,
      total: 2,
    }));
    const commands = new SessionListCommands(
      createSessionDb({ listSessionsForUpstreamDump } as unknown as Partial<SessionDB>),
      "node-1",
    );

    const ack = await commands.listSessions({ requestId: "list-1" });

    expect(listSessionsForUpstreamDump).toHaveBeenCalledWith({
      limit: 10_000,
      offset: 0,
      nodeId: "node-1",
    });
    expect(ack).toEqual({
      type: "sessions_update",
      sessions: sessionRows,
      total: 2,
      requestId: "list-1",
    });
    expect(ack.sessions[0]).toMatchObject({
      session_id: "sess-a",
      agent_id: "agent-a",
      display_name: "A",
      folder_id: "folder-a",
    });
  });

  it("preserves Python parity by returning an empty requestId when absent", async () => {
    const commands = new SessionListCommands(createSessionDb(), "node-1");

    const ack = await commands.listSessions({ requestId: "" });

    expect(ack.requestId).toBe("");
  });

  it("fails explicitly when the session DB dependency is not configured", async () => {
    const commands = new SessionListCommands(undefined, "node-1");

    await expect(commands.listSessions({ requestId: "list-bad" })).rejects.toEqual(
      new SessionListCommandError(
        "list_sessions handler requires session_db dependency — wire main.ts CommandDispatcher with SessionDB",
      ),
    );
  });
});

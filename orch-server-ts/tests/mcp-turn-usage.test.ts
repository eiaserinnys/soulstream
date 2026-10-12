import { describe, expect, it, vi } from "vitest";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import type { CallToolResult } from "@soulstream/mcp-contract";

const context = { principal: "internal" as const, callerSessionId: null, nodeId: "node-test" };

function options(eventReads: Record<string, unknown>) {
  return {
    sessions: { repositoryProvider: async () => ({ eventReads }) },
  } as unknown as McpHostOptions;
}

describe("list_turn_usage MCP response", () => {
  it("validates the range, pages rows, and returns metadata only for sessions on the page", async () => {
    const listTurnUsage = vi.fn(async () => ({
      total: 5,
      rows: [
        {
          session_id: "s1",
          event_id: 11,
          at: new Date("2026-10-05T01:30:00.000Z"),
          kind: "complete",
          model: "claude-model",
          input_tokens: 15,
          cached_input_tokens: 2,
          cache_write_tokens: 3,
          output_tokens: 4,
          cost_usd: 0.1256789,
          first_call_input_tokens: 8,
          first_call_cached_tokens: 1,
          injection_chars: 120,
          name: "세션 1",
          agent_id: "agent-1",
          node_id: "node-1",
          model_preset: "preset-1",
          session_created_at: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          session_id: "s2",
          event_id: 3,
          at: new Date("2026-10-05T01:31:00.000Z"),
          kind: "no_usage",
          injection_chars: 80,
          ended: "limit_hit",
          tool_calls: 0,
          name: null,
          agent_id: null,
          node_id: "node-2",
          model_preset: null,
          session_created_at: new Date("2026-10-05T01:00:00.000Z"),
        },
      ],
    }));
    const result = await executeMcpTool(options({ listTurnUsage }), "list_turn_usage" as never, {
      since: "2026-10-05T10:00:00+09:00",
      until: "2026-10-05T11:00:00+09:00",
      cursor: 2,
      limit: 2,
    }, context) as CallToolResult;

    expect(listTurnUsage).toHaveBeenCalledWith({
      sessionId: undefined,
      since: new Date("2026-10-05T01:00:00.000Z"),
      until: new Date("2026-10-05T02:00:00.000Z"),
      cursor: 2,
      limit: 2,
    });
    expect(result.structuredContent).toEqual({
      since: "2026-10-05T01:00:00.000Z",
      until: "2026-10-05T02:00:00.000Z",
      session_id: null,
      total: 5,
      cursor: 2,
      limit: 2,
      next_cursor: 4,
      sessions: {
        s1: {
          name: "세션 1",
          agent_id: "agent-1",
          node_id: "node-1",
          model_preset: "preset-1",
          created_at: "2026-10-01T00:00:00.000Z",
        },
        s2: { node_id: "node-2", created_at: "2026-10-05T01:00:00.000Z" },
      },
      turns: [
        {
          session_id: "s1",
          event_id: 11,
          at: "2026-10-05T01:30:00.000Z",
          kind: "complete",
          model: "claude-model",
          input_tokens: 15,
          cached_input_tokens: 2,
          cache_write_tokens: 3,
          output_tokens: 4,
          cost_usd: 0.1256789,
          first_call_input_tokens: 8,
          first_call_cached_tokens: 1,
          injection_chars: 120,
        },
        {
          session_id: "s2",
          event_id: 3,
          at: "2026-10-05T01:31:00.000Z",
          kind: "no_usage",
          injection_chars: 80,
          ended: "limit_hit",
          tool_calls: 0,
        },
      ],
    });
  });

  it("allows a full-session query without since and rejects an unbounded period query", async () => {
    const listTurnUsage = vi.fn(async () => ({ rows: [], total: 0 }));
    const opts = options({ listTurnUsage });
    const wholeSession = await executeMcpTool(opts, "list_turn_usage" as never, {
      session_id: "session-1",
    }, context) as CallToolResult;

    expect(listTurnUsage).toHaveBeenCalledWith({
      sessionId: "session-1",
      since: undefined,
      until: expect.any(Date),
      cursor: 0,
      limit: 100,
    });
    expect(wholeSession.structuredContent).toMatchObject({
      since: null,
      session_id: "session-1",
      total: 0,
      next_cursor: null,
      sessions: {},
      turns: [],
    });

    const noPeriod = await executeMcpTool(opts, "list_turn_usage" as never, {}, context) as CallToolResult;
    expect(noPeriod.isError).toBe(true);
    expect(JSON.stringify(noPeriod.content)).toContain("session_id 또는 since");
    expect(listTurnUsage).toHaveBeenCalledTimes(1);
  });

  it("enforces the 31-day limit only for cross-session period reads", async () => {
    const listTurnUsage = vi.fn(async () => ({ rows: [], total: 0 }));
    const opts = options({ listTurnUsage });
    const tooWide = await executeMcpTool(opts, "list_turn_usage" as never, {
      since: "2026-09-01T00:00:00Z",
      until: "2026-10-05T00:00:00Z",
    }, context) as CallToolResult;
    expect(tooWide.isError).toBe(true);
    expect(JSON.stringify(tooWide.content)).toContain("31일");
    expect(listTurnUsage).not.toHaveBeenCalled();

    await executeMcpTool(opts, "list_turn_usage" as never, {
      session_id: "session-1",
      since: "2026-09-01T00:00:00Z",
      until: "2026-10-05T00:00:00Z",
    }, context);
    expect(listTurnUsage).toHaveBeenCalledTimes(1);
  });
});

describe("summarize_turn_usage MCP response", () => {
  it("summarizes repository session rows and validates the period", async () => {
    const summarizeTurnUsage = vi.fn(async () => [{
      session_id: "session-1",
      turns: 1,
      turns_without_usage: 0,
      input_tokens: 12,
      cached_input_tokens: 4,
      output_tokens: 3,
      cost_usd: 0.25,
      model: "model-1",
      first_call_input_tokens: 10,
      display_name: "세션 1",
      agent_id: "agent-1",
      node_id: "node-1",
      created_at: new Date("2026-10-05T01:00:00.000Z"),
      injection_chars: 150,
    }]);
    const opts = options({ summarizeTurnUsage });
    const result = await executeMcpTool(opts, "summarize_turn_usage" as never, {
      since: "2026-10-05T10:00:00+09:00",
      until: "2026-10-05T11:00:00+09:00",
    }, context) as CallToolResult;

    expect(summarizeTurnUsage).toHaveBeenCalledWith({
      since: new Date("2026-10-05T01:00:00.000Z"),
      until: new Date("2026-10-05T02:00:00.000Z"),
    });
    expect(result.structuredContent).toMatchObject({
      since: "2026-10-05T01:00:00.000Z",
      until: "2026-10-05T02:00:00.000Z",
      totals: { sessions: 1, new_sessions: 1, turns: 1, turns_without_usage: 0, cost_usd: 0.25 },
      by_agent_model: [{ agent_id: "agent-1", model: "model-1", sessions: 1, injection_chars_median: 150 }],
      top_sessions: [{ session_id: "session-1", name: "세션 1", first_call_input_tokens: 10 }],
    });

    const invalid = await executeMcpTool(opts, "summarize_turn_usage" as never, {
      since: "2026-09-01T00:00:00Z",
      until: "2026-10-05T00:00:00Z",
    }, context) as CallToolResult;
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("31일");
    expect(summarizeTurnUsage).toHaveBeenCalledTimes(1);
  });
});

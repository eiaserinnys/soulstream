import { describe, expect, it } from "vitest";
import { summarizeTurnUsage } from "../src/mcp/turn_usage_summary.js";

const SINCE = "2026-10-05T00:00:00.000Z";
const UNTIL = "2026-10-12T00:00:00.000Z";
const created = (value: string) => new Date(value);

function row(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-1",
    turns: 1,
    turns_without_usage: 0,
    input_tokens: undefined,
    cached_input_tokens: undefined,
    cache_write_tokens: undefined,
    output_tokens: undefined,
    cost_usd: undefined,
    model: undefined,
    first_call_input_tokens: undefined,
    display_name: null,
    agent_id: null,
    node_id: null,
    created_at: created("2026-10-06T00:00:00.000Z"),
    injection_chars: undefined,
    ...overrides,
  };
}

describe("summarizeTurnUsage", () => {
  it("labels missing agent and model and groups null and empty IDs", () => {
    const result = summarizeTurnUsage([
      row({ session_id: "a", agent_id: null, model: null, session_type: "llm", client_id: "translate", turns: 0, turns_without_usage: 1 }),
      row({ session_id: "b", agent_id: "", model: "", session_type: "llm", client_id: "translate", turns: 0, turns_without_usage: 1 }),
      row({ session_id: "c", agent_id: null, session_type: "llm", client_id: "observer", subagent_models: [{ model: "worker", input_tokens: 1, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0 }] }),
      row({ session_id: "d", agent_id: "", session_type: "claude", client_id: "translate" }),
    ], SINCE, UNTIL);
    expect(result.by_agent_model).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: "llm:translate", model: "(미기록)", sessions: 2, turns_without_usage: 2 }),
      expect.objectContaining({ agent_id: "llm:observer", model: "(미기록)", sessions: 1 }),
      expect.objectContaining({ agent_id: "(미상)", model: "(미기록)", sessions: 1 }),
    ]));
    expect(result.top_sessions.find((item) => item.session_id === "a")).toMatchObject({ agent_id: "llm:translate", model: "(미기록)" });
    expect(result.top_sessions.find((item) => item.session_id === "d")).toMatchObject({ agent_id: "(미상)", model: "(미기록)" });
    expect(result.subagents_by_agent_model?.[0]).toMatchObject({ agent_id: "llm:observer", model: "worker" });
  });
  it("groups totals, rounds cost, computes odd/even new-session medians, and returns the 20 highest-cost sessions", () => {
    const rows = [
      row({
        session_id: "s1", display_name: "세션 1", agent_id: "agent-a", node_id: "node-a", model: "model-a",
        turns: 2, turns_without_usage: 1, input_tokens: 100, cached_input_tokens: 40,
        cache_write_tokens: 5, output_tokens: 12, cost_usd: 1.2345678,
        first_call_input_tokens: 80, injection_chars: 100,
      }),
      row({
        session_id: "s2", display_name: "세션 2", agent_id: "agent-a", node_id: "node-a", model: "model-a",
        turns: 1, input_tokens: 50, cached_input_tokens: 10, output_tokens: 7, cost_usd: 2.0000004,
        first_call_input_tokens: 60, injection_chars: 300,
      }),
      row({
        session_id: "old", agent_id: "agent-b", node_id: "node-b", model: "model-b",
        turns: 1, turns_without_usage: 1, input_tokens: 80, cached_input_tokens: 0,
        output_tokens: 10, cost_usd: 0.5, first_call_input_tokens: 70, injection_chars: 50,
        created_at: created("2026-10-01T00:00:00.000Z"),
      }),
      row({
        session_id: "b1", agent_id: "agent-b", node_id: "node-b", model: "model-b",
        turns: 1, input_tokens: 20, cached_input_tokens: 5, output_tokens: 2, cost_usd: 0.7,
        first_call_input_tokens: 70, injection_chars: 50,
      }),
      row({
        session_id: "b2", agent_id: "agent-b", node_id: "node-b", model: "model-b",
        turns: 0, turns_without_usage: 1, cost_usd: 0.8, first_call_input_tokens: 90,
      }),
      row({
        session_id: "b3", agent_id: "agent-b", node_id: "node-b", model: "model-b",
        turns: 3, input_tokens: 30, cached_input_tokens: 6, cache_write_tokens: 1,
        output_tokens: 3, cost_usd: 0.9, injection_chars: 100,
      }),
      ...Array.from({ length: 16 }, (_, index) => row({
        session_id: `extra-${index + 1}`,
        agent_id: "agent-c",
        node_id: "node-c",
        model: "model-c",
        turns: 0,
        turns_without_usage: 0,
        cost_usd: (index + 1) / 100,
        created_at: created("2026-10-01T00:00:00.000Z"),
      })),
    ];

    const result = summarizeTurnUsage(rows, SINCE, UNTIL);

    expect(result.totals).toMatchObject({
      sessions: 22,
      new_sessions: 5,
      turns: 8,
      turns_without_usage: 3,
      input_tokens: 280,
      cached_input_tokens: 61,
      cache_write_tokens: 6,
      output_tokens: 34,
      cost_usd: 7.494568,
    });
    expect(result.by_agent_model[0]).toMatchObject({
      agent_id: "agent-a",
      model: "model-a",
      sessions: 2,
      new_sessions: 2,
      turns: 3,
      turns_without_usage: 1,
      input_tokens: 150,
      cached_input_tokens: 50,
      output_tokens: 19,
      cost_usd: 3.234568,
      injection_chars_median: 200,
      injection_chars_max: 300,
      first_call_input_median: 70,
    });
    expect(result.by_agent_model[1]).toMatchObject({
      agent_id: "agent-b",
      model: "model-b",
      sessions: 4,
      new_sessions: 3,
      injection_chars_median: 75,
      injection_chars_max: 100,
      first_call_input_median: 80,
    });
    expect(result.by_agent_model[2]).toMatchObject({
      agent_id: "agent-c",
      model: "model-c",
      sessions: 16,
      new_sessions: 0,
    });
    expect(result.top_sessions).toHaveLength(20);
    expect(result.top_sessions.slice(0, 3).map((session) => session.session_id)).toEqual(["s2", "s1", "b3"]);
    expect(result.top_sessions.some((session) => session.session_id === "extra-1" || session.session_id === "extra-2")).toBe(false);
    expect(result.top_sessions.find((session) => session.session_id === "s1")).toMatchObject({
      name: "세션 1",
      first_call_input_tokens: 80,
    });
    expect(result.top_sessions.find((session) => session.session_id === "old")).not.toHaveProperty("first_call_input_tokens");
  });

  it("adds subagent totals, model groups, and total_cost_usd while ordering top sessions by combined cost", () => {
    const rows = [
      row({
        session_id: "s-sub", display_name: "하위 세션", agent_id: "agent-a", node_id: "node-a",
        model: "claude-opus-5-5", turns: 2, input_tokens: 1300, cached_input_tokens: 250,
        output_tokens: 150, cost_usd: 1.25,
        subagent_input_tokens: 2400, subagent_cached_input_tokens: 200,
        subagent_cache_write_tokens: 0, subagent_output_tokens: 130, subagent_cost_usd: 1.125,
        subagent_models: [
          { model: "claude-opus-5-5", input_tokens: 1500, cached_input_tokens: 200, cache_write_tokens: 0, output_tokens: 60, cost_usd: 0.5 },
          { model: "claude-sonnet-5-5", input_tokens: 800, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 60, cost_usd: 0.5 },
          { model: "claude-haiku-5-5", input_tokens: 100, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 10, cost_usd: 0.125 },
        ],
      }),
      row({
        session_id: "s-main", display_name: "주 세션", agent_id: "agent-b", node_id: "node-b",
        model: "claude-sonnet-5-5", turns: 1, input_tokens: 500, output_tokens: 20, cost_usd: 0.5,
      }),
    ];

    const result = summarizeTurnUsage(rows, SINCE, UNTIL);

    expect(result.totals).toMatchObject({
      sessions: 2,
      new_sessions: 2,
      cost_usd: 1.75,
      subagent_input_tokens: 2400,
      subagent_cached_input_tokens: 200,
      subagent_cache_write_tokens: 0,
      subagent_output_tokens: 130,
      subagent_cost_usd: 1.125,
      total_cost_usd: 2.875,
    });
    expect(result.subagents_by_agent_model).toEqual([
      {
        agent_id: "agent-a",
        model: "claude-opus-5-5",
        sessions: 1,
        input_tokens: 1500,
        cached_input_tokens: 200,
        cache_write_tokens: 0,
        output_tokens: 60,
        cost_usd: 0.5,
      },
      {
        agent_id: "agent-a",
        model: "claude-sonnet-5-5",
        sessions: 1,
        input_tokens: 800,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 60,
        cost_usd: 0.5,
      },
      {
        agent_id: "agent-a",
        model: "claude-haiku-5-5",
        sessions: 1,
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 10,
        cost_usd: 0.125,
      },
    ]);
    expect(result.top_sessions.map((session) => session.session_id)).toEqual(["s-sub", "s-main"]);
    expect(result.top_sessions[0]).toMatchObject({
      session_id: "s-sub",
      subagent_input_tokens: 2400,
      subagent_output_tokens: 130,
      subagent_cost_usd: 1.125,
      total_cost_usd: 2.375,
    });
    expect(result.top_sessions[1]).not.toHaveProperty("subagent_cost_usd");
    expect(result.top_sessions[1]).not.toHaveProperty("total_cost_usd");
  });

  it("omits subagent fields when no session carries subagent usage", () => {
    const result = summarizeTurnUsage([row({ session_id: "plain", cost_usd: 0.5 })], SINCE, UNTIL);

    expect(result.totals).not.toHaveProperty("subagent_cost_usd");
    expect(result.totals).not.toHaveProperty("total_cost_usd");
    expect(result).not.toHaveProperty("subagents_by_agent_model");
    expect(result.top_sessions[0]).not.toHaveProperty("subagent_cost_usd");
  });

  it("omits undefined measures while retaining a real zero and handles even medians", () => {
    const result = summarizeTurnUsage([
      row({ session_id: "a", agent_id: "agent", model: "model", input_tokens: 0, cost_usd: 0, injection_chars: 10 }),
      row({ session_id: "b", agent_id: "agent", model: "model", cost_usd: 0, injection_chars: 20 }),
    ], SINCE, UNTIL);

    expect(result.totals).toMatchObject({ sessions: 2, input_tokens: 0, cost_usd: 0 });
    expect(result.totals).not.toHaveProperty("output_tokens");
    expect(result.by_agent_model[0]).toMatchObject({ injection_chars_median: 15, injection_chars_max: 20 });
    expect(result.by_agent_model[0]).not.toHaveProperty("first_call_input_median");
  });
});

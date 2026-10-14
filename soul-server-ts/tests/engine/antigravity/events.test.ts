import { describe, expect, it } from "vitest";
import { AntigravityEventMapper, parseAntigravityEvent } from "../../../src/engine/antigravity/events.js";

const init = { event: "init", conversation_id: "conversation", init: { model: "gemini-3.8-flash" } };
const step = (index: number, extra: object) => ({ event: "step_update", step_update: {
  conversation_id: "conversation", step_index: index, state: "DONE", step_type: "agent_response", ...extra,
} });

describe("AntigravityEventMapper", () => {
  it("maps init, incremental text including DONE and one final assistant message", () => {
    const mapper = new AntigravityEventMapper("turn-a");
    expect(mapper.accept(init)).toMatchObject([{ type: "session", session_id: "conversation", model: "gemini-3.8-flash" }]);
    expect(mapper.accept(step(0, { state: "ACTIVE", text_delta: "한" }))).toMatchObject([{ type: "text_start" }, { type: "text_delta", text: "한" }]);
    expect(mapper.accept(step(0, { text_delta: "글" }))).toMatchObject([{ type: "text_delta", text: "글" }, { type: "assistant_message", content: "한글", _final_for_live_stream: true }, { type: "text_end", _live_only: true }]);
  });
  it("identifies every live and final frame by conversation, turn, and step", () => {
    const mapper = new AntigravityEventMapper("turn-a");
    const active = mapper.accept(step(0, { state: "ACTIVE", text_delta: "이미지와 " }));
    const done = mapper.accept(step(0, { text_delta: "상단 HUD" }));
    const identity = { item_id: "0", thread_id: "conversation", turn_id: "turn-a",
      raw_event_type: "antigravity/agent_response" };
    for (const event of [...active, ...done]) {
      expect(event).toMatchObject(identity);
      if (event.type !== "assistant_message") expect(event._live_only).toBe(true);
    }
    expect(done[1]).toMatchObject({ content: "이미지와 상단 HUD", _final_for_live_stream: true });
    expect(mapper.accept(step(1, { text_delta: "next" }))[0]?.item_id).toBe("1");
    expect(new AntigravityEventMapper("turn-b").accept(step(0, { text_delta: "resume" }))[0]?.turn_id).toBe("turn-b");
  });
  it("counts each model DONE once, adds cache to input, keeps thinking inside output, ignores result cumulative usage", () => {
    const mapper = new AntigravityEventMapper("turn-a");
    mapper.accept(init);
    const done = step(1, { usage: { input_tokens: 10, cache_read_tokens: 100, output_tokens: 20, thinking_tokens: 15, total_tokens: 30 } });
    mapper.accept(done); mapper.accept(done);
    mapper.accept(step(2, { usage: { input_tokens: 5, cache_read_tokens: 50, output_tokens: 10, thinking_tokens: 8 } }));
    mapper.accept({ event: "result", result: { status: "SUCCESS", response: "끝", usage: { input_tokens: 9999 } } });
    expect(mapper.usage).toEqual({ input_tokens: 165, cached_input_tokens: 150, output_tokens: 30, reasoning_output_tokens: 23 });
    expect(mapper.terminal({ code: 0, signal: null }, false)).toMatchObject({ type: "complete", result: "끝", model: "gemini-3.8-flash", usage: mapper.usage });
  });
  it("pairs repeated ACTIVE and DONE-only tools, unwraps MCP to the existing Codex naming, gives resumed turns distinct IDs", () => {
    const call = step(3, { step_type: "tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: "probe", ToolName: "echo", Arguments: { text: "한글" } }, output: "답" } });
    const first = new AntigravityEventMapper("turn-a");
    const second = new AntigravityEventMapper("turn-b");
    const events = first.accept(call);
    expect(events).toMatchObject([{ type: "tool_start", tool_name: "mcp/probe/echo", tool_input: { text: "한글" } }, { type: "tool_result", result: "답", is_error: false }]);
    expect(events[0]?.tool_use_id).toBe(events[1]?.tool_use_id);
    expect(events[0]?.tool_use_id).not.toBe(second.accept(call)[0]?.tool_use_id);
    expect(first.accept(call)).toEqual([]);
    const active = step(4, { state: "ACTIVE", step_type: "tool", tool_info: { name: "view_file", parameters: {} } });
    expect(first.accept(active)).toHaveLength(1);
    expect(first.accept(active)).toEqual([]);
    expect(first.accept(step(4, { step_type: "tool", tool_info: { name: "view_file" } }))[0]).not.toHaveProperty("result");
  });
  it("holds result until close and emits one failure for missing or inconsistent result", () => {
    const mapper = new AntigravityEventMapper("turn");
    expect(mapper.accept({ event: "result", result: { status: "SUCCESS", response: "x" } })).toEqual([]);
    expect(mapper.terminal({ code: 1, signal: null }, false)).toMatchObject({ type: "error", fatal: true });
    expect(new AntigravityEventMapper("turn").terminal({ code: 0, signal: null }, false)).toMatchObject({ type: "error", fatal: true });
  });
  it("suppresses expected SIGINT only, carries no success terminal, and gives a short registry failure", () => {
    const mapper = new AntigravityEventMapper("turn");
    mapper.accept({ event: "result", result: { status: "ERROR", error: "interrupted" } });
    expect(mapper.terminal({ code: 1, signal: null }, true)).toBeUndefined();
    expect(mapper.terminal({ code: 1, signal: null }, false)).toMatchObject({ type: "error", message: "interrupted" });
    const invalid = new AntigravityEventMapper("turn");
    invalid.accept({ event: "result", result: { status: "ERROR", error: "failed to construct executor: bad_tool not found in registry" } });
    expect(invalid.terminal({ code: 3, signal: null }, false)).toMatchObject({ type: "error", message: "안티그라비티 도구 구성이 현재 CLI와 맞지 않아 실행을 시작하지 못했습니다." });
  });
  it("rejects malformed external envelopes", () => {
    expect(() => parseAntigravityEvent('{"wrong":1}')).toThrow();
    expect(() => parseAntigravityEvent('bad json')).toThrow();
  });
});

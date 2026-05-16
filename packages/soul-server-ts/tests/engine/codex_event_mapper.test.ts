/**
 * Codex ThreadEvent → SSEEvent 매핑 단위 테스트.
 *
 * 8 top-level event × 8 sub-type item 각각 검증.
 * 분석 캐시 §4.1·§4.2 매핑 표 그대로 enumerate.
 */

import { describe, expect, it } from "vitest";

import { mapThreadEvent } from "../../src/engine/codex_event_mapper.js";

describe("ThreadEvent top-level 매핑 (§4.1)", () => {
  it("thread.started → session (session_id=thread_id)", () => {
    const sse = mapThreadEvent({
      type: "thread.started",
      thread_id: "thr-abc-123",
    });
    expect(sse).toEqual([{ type: "session", session_id: "thr-abc-123" }]);
  });

  it("turn.started → no-op", () => {
    expect(mapThreadEvent({ type: "turn.started" })).toEqual([]);
  });

  it("turn.completed → complete (usage 운반)", () => {
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 200,
      reasoning_output_tokens: 30,
    };
    const sse = mapThreadEvent({ type: "turn.completed", usage });
    expect(sse).toEqual([{ type: "complete", usage }]);
  });

  it("turn.failed → error (fatal=false)", () => {
    const sse = mapThreadEvent({
      type: "turn.failed",
      error: { message: "rate limit" },
    });
    expect(sse).toEqual([{ type: "error", message: "rate limit", fatal: false }]);
  });

  it("error (ThreadErrorEvent) → error (fatal=true)", () => {
    const sse = mapThreadEvent({ type: "error", message: "unrecoverable" });
    expect(sse).toEqual([{ type: "error", message: "unrecoverable", fatal: true }]);
  });
});

describe("item.started 매핑 (§4.2)", () => {
  it("agent_message → no-op (streaming 보류, spec-reviewer 1차 P1)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: { id: "i1", type: "agent_message", text: "" },
    });
    expect(sse).toEqual([]);
  });

  it("reasoning → no-op (완료 시 thinking 발행)", () => {
    expect(
      mapThreadEvent({
        type: "item.started",
        item: { id: "i2", type: "reasoning", text: "" },
      }),
    ).toEqual([]);
  });

  it("command_execution → tool_start (tool_name=command)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: {
        id: "i3",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "",
        status: "in_progress",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_start",
        tool_use_id: "i3",
        tool_name: "command",
        input: { command: "ls -la" },
      },
    ]);
  });

  it("file_change → tool_start (changes_count)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: {
        id: "i4",
        type: "file_change",
        changes: [
          { path: "a.ts", kind: "update" },
          { path: "b.ts", kind: "add" },
        ],
        status: "completed",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_start",
        tool_use_id: "i4",
        tool_name: "file_change",
        input: { changes_count: 2 },
      },
    ]);
  });

  it("mcp_tool_call → tool_start (tool_name=mcp/server/tool)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: {
        id: "i5",
        type: "mcp_tool_call",
        server: "trello",
        tool: "create_card",
        arguments: { name: "x" },
        status: "in_progress",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_start",
        tool_use_id: "i5",
        tool_name: "mcp/trello/create_card",
        input: { name: "x" },
      },
    ]);
  });

  it("web_search → tool_start (query)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: { id: "i6", type: "web_search", query: "rust async" },
    });
    expect(sse).toEqual([
      {
        type: "tool_start",
        tool_use_id: "i6",
        tool_name: "web_search",
        input: { query: "rust async" },
      },
    ]);
  });

  it("todo_list → no-op (본 PR 범위 외, B-3에서 신규 SSE type 고려)", () => {
    expect(
      mapThreadEvent({
        type: "item.started",
        item: { id: "i7", type: "todo_list", items: [] },
      }),
    ).toEqual([]);
  });

  it("error (ErrorItem) → no-op (완료 시 error 발행)", () => {
    expect(
      mapThreadEvent({
        type: "item.started",
        item: { id: "i8", type: "error", message: "..." },
      }),
    ).toEqual([]);
  });
});

describe("item.updated 매핑 — 모든 sub-type no-op (streaming 보류)", () => {
  it("agent_message updated → no-op", () => {
    expect(
      mapThreadEvent({
        type: "item.updated",
        item: { id: "i1", type: "agent_message", text: "partial" },
      }),
    ).toEqual([]);
  });

  it("command_execution updated → no-op", () => {
    expect(
      mapThreadEvent({
        type: "item.updated",
        item: {
          id: "i3",
          type: "command_execution",
          command: "ls",
          aggregated_output: "partial output",
          status: "in_progress",
        },
      }),
    ).toEqual([]);
  });
});

describe("item.completed 매핑 (§4.2)", () => {
  it("agent_message → text_end (text + item_id)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Hello world" },
    });
    expect(sse).toEqual([
      { type: "text_end", text: "Hello world", item_id: "i1" },
    ]);
  });

  it("reasoning → thinking (text + signature='')", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i2", type: "reasoning", text: "thinking..." },
    });
    expect(sse).toEqual([
      { type: "thinking", thinking: "thinking...", signature: "" },
    ]);
  });

  it("command_execution success → tool_result (is_error=false, exit_code 운반)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i3",
        type: "command_execution",
        command: "echo hi",
        aggregated_output: "hi\n",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_result",
        tool_use_id: "i3",
        content: { output: "hi\n", exit_code: 0 },
        is_error: false,
      },
    ]);
  });

  it("command_execution failed → tool_result (is_error=true, exit_code 운반)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i3b",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_result",
        tool_use_id: "i3b",
        content: { output: "", exit_code: 1 },
        is_error: true,
      },
    ]);
  });

  it("command_execution without exit_code → exit_code: null", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i3c",
        type: "command_execution",
        command: "x",
        aggregated_output: "",
        status: "completed",
      },
    });
    expect((sse[0] as { content: { exit_code: number | null } }).content.exit_code).toBe(null);
  });

  it("file_change completed → tool_result (changes 운반)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i4",
        type: "file_change",
        changes: [{ path: "a.ts", kind: "update" }],
        status: "completed",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_result",
        tool_use_id: "i4",
        content: {
          changes: [{ path: "a.ts", kind: "update" }],
          status: "completed",
        },
        is_error: false,
      },
    ]);
  });

  it("mcp_tool_call success → tool_result (result 운반)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i5",
        type: "mcp_tool_call",
        server: "trello",
        tool: "create_card",
        arguments: {},
        result: { content: [], structured_content: { ok: true } },
        status: "completed",
      },
    });
    expect((sse[0] as { is_error: boolean }).is_error).toBe(false);
  });

  it("mcp_tool_call failed → tool_result (error 운반)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i5b",
        type: "mcp_tool_call",
        server: "x",
        tool: "y",
        arguments: {},
        error: { message: "boom" },
        status: "failed",
      },
    });
    expect(sse).toEqual([
      {
        type: "tool_result",
        tool_use_id: "i5b",
        content: { error: "boom" },
        is_error: true,
      },
    ]);
  });

  it("web_search completed → tool_result (query 그대로)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i6", type: "web_search", query: "openai sdk" },
    });
    expect(sse).toEqual([
      {
        type: "tool_result",
        tool_use_id: "i6",
        content: { query: "openai sdk" },
        is_error: false,
      },
    ]);
  });

  it("todo_list completed → no-op", () => {
    expect(
      mapThreadEvent({
        type: "item.completed",
        item: {
          id: "i7",
          type: "todo_list",
          items: [{ text: "step 1", completed: true }],
        },
      }),
    ).toEqual([]);
  });

  it("error (ErrorItem) → error (fatal=false)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i8", type: "error", message: "non-fatal warn" },
    });
    expect(sse).toEqual([
      { type: "error", message: "non-fatal warn", fatal: false },
    ]);
  });
});

describe("매퍼 stateless 검증", () => {
  it("동일 ThreadEvent 입력에 항상 동일 출력 (상태 의존 없음)", () => {
    const event = {
      type: "thread.started" as const,
      thread_id: "thr-1",
    };
    const out1 = mapThreadEvent(event);
    const out2 = mapThreadEvent(event);
    expect(out1).toEqual(out2);
  });

  it("agent_message item.completed가 연속 호출에도 동일 출력 (state 없음)", () => {
    const ev = {
      type: "item.completed" as const,
      item: { id: "a1", type: "agent_message" as const, text: "Hello" },
    };
    const out1 = mapThreadEvent(ev);
    const out2 = mapThreadEvent(ev);
    expect(out1).toEqual(out2);
  });
});

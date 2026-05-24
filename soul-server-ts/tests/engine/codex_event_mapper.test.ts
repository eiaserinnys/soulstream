/**
 * Codex ThreadEvent → SSEEvent 매핑 단위 테스트 (Phase B-3 갱신).
 *
 * 본 PR 갱신점 (B-2 대비):
 *   - text_end: text/item_id 제거, timestamp 추가 (Python wire 정본 정합)
 *   - text_start 신설 (item.started agent_message)
 *   - text_delta 신설 (item.updated agent_message, 누적 텍스트 그대로)
 *   - tool_start: tool_input (Python wire 정본) — B-2의 `input` 키 정정
 *   - 모든 payload에 timestamp 박힘
 */

import { describe, expect, it } from "vitest";

import { mapThreadEvent } from "../../src/engine/codex_event_mapper.js";

describe("ThreadEvent top-level 매핑", () => {
  it("thread.started → session (session_id=thread_id, no timestamp)", () => {
    const sse = mapThreadEvent({
      type: "thread.started",
      thread_id: "thr-abc-123",
    });
    expect(sse).toEqual([{ type: "session", session_id: "thr-abc-123" }]);
  });

  it("turn.started → no-op", () => {
    expect(mapThreadEvent({ type: "turn.started" })).toEqual([]);
  });

  it("turn.completed → complete (usage + timestamp)", () => {
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 200,
      reasoning_output_tokens: 30,
    };
    const sse = mapThreadEvent({ type: "turn.completed", usage });
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({ type: "complete", usage });
    expect(typeof (sse[0] as { timestamp: number }).timestamp).toBe("number");
  });

  it("turn.failed → error (fatal=false, timestamp)", () => {
    const sse = mapThreadEvent({
      type: "turn.failed",
      error: { message: "rate limit" },
    });
    expect(sse[0]).toMatchObject({
      type: "error",
      message: "rate limit",
      fatal: false,
    });
  });

  it("error (ThreadErrorEvent) → error (fatal=true, timestamp)", () => {
    const sse = mapThreadEvent({ type: "error", message: "unrecoverable" });
    expect(sse[0]).toMatchObject({
      type: "error",
      message: "unrecoverable",
      fatal: true,
    });
  });
});

describe("Codex raw response_item 매핑 (SDK d.ts 밖 이벤트)", () => {
  it("response_item.function_call → tool_start (spawn_agent 회귀)", () => {
    const sse = mapThreadEvent({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        call_id: "call-1",
        arguments: "{\"agent_type\":\"worker\",\"reasoning_effort\":\"medium\"}",
      },
    } as never);

    expect(Array.isArray(sse)).toBe(true);
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "call-1",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "worker",
        reasoning_effort: "medium",
      },
    });
  });

  it("response_item.function_call_output → tool_result", () => {
    const sse = mapThreadEvent({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "spawned worker",
      },
    } as never);

    expect(Array.isArray(sse)).toBe(true);
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call-1",
      tool_name: "function_call",
      result: "spawned worker",
      is_error: false,
    });
  });

  it("response_item.message assistant output → assistant_message", () => {
    const sse = mapThreadEvent({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "raw assistant text" }],
      },
    } as never);

    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({
      type: "assistant_message",
      content: "raw assistant text",
      raw_event_type: "response_item.message",
    });
  });

  it("알 수 없는 top-level event/item은 no-op 배열로 격리한다", () => {
    expect(mapThreadEvent({ type: "future.event", payload: {} } as never)).toEqual([]);
    expect(
      mapThreadEvent({
        type: "item.completed",
        item: { type: "future_item", id: "x", payload: {} },
      } as never),
    ).toEqual([]);
  });
});

describe("item.started 매핑 (B-3 streaming 활성)", () => {
  it("agent_message → live-only text_start (text 필드 없음, timestamp 박힘)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: { id: "i1", type: "agent_message", text: "" },
    });
    expect(sse).toHaveLength(1);
    const ev = sse[0] as Record<string, unknown>;
    expect(ev.type).toBe("text_start");
    expect(ev._live_only).toBe(true);
    expect(ev.item_id).toBe("i1");
    expect(ev.text).toBeUndefined();  // Python schemas.py L155-159 정합
    expect(typeof ev.timestamp).toBe("number");
  });

  it("reasoning → no-op (완료 시 thinking 발행)", () => {
    expect(
      mapThreadEvent({
        type: "item.started",
        item: { id: "i2", type: "reasoning", text: "" },
      }),
    ).toEqual([]);
  });

  it("command_execution → tool_start (tool_name=command, tool_input)", () => {
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
    expect(sse[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "i3",
      tool_name: "command",
      tool_input: { command: "ls -la" },
    });
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
    expect(sse[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "i4",
      tool_name: "file_change",
      tool_input: { changes_count: 2 },
    });
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
    expect(sse[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "i5",
      tool_name: "mcp/trello/create_card",
      tool_input: { name: "x" },
    });
  });

  it("web_search → tool_start (query)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: { id: "i6", type: "web_search", query: "rust async" },
    });
    expect(sse[0]).toMatchObject({
      type: "tool_start",
      tool_use_id: "i6",
      tool_name: "web_search",
      tool_input: { query: "rust async" },
    });
  });

  it("todo_list → no-op", () => {
    expect(
      mapThreadEvent({
        type: "item.started",
        item: { id: "i7", type: "todo_list", items: [] },
      }),
    ).toEqual([]);
  });

  it("error item → no-op (완료 시 error 발행)", () => {
    expect(
      mapThreadEvent({
        type: "item.started",
        item: { id: "i8", type: "error", message: "..." },
      }),
    ).toEqual([]);
  });
});

describe("item.updated 매핑 (B-3 streaming)", () => {
  it("agent_message → text_delta (text = item.text 누적값 그대로, timestamp)", () => {
    const sse = mapThreadEvent({
      type: "item.updated",
      item: { id: "i1", type: "agent_message", text: "Hello partial" },
    });
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({
      type: "text_delta",
      text: "Hello partial",
      _live_only: true,
      item_id: "i1",
    });
    expect(typeof (sse[0] as { timestamp: number }).timestamp).toBe("number");
  });

  it("연속 호출 — 누적 텍스트 그대로 운반 (mapper stateless)", () => {
    const a = mapThreadEvent({
      type: "item.updated",
      item: { id: "i1", type: "agent_message", text: "A" },
    });
    const b = mapThreadEvent({
      type: "item.updated",
      item: { id: "i1", type: "agent_message", text: "AB" },
    });
    const c = mapThreadEvent({
      type: "item.updated",
      item: { id: "i1", type: "agent_message", text: "ABC" },
    });
    expect((a[0] as { text: string }).text).toBe("A");
    expect((b[0] as { text: string }).text).toBe("AB");
    expect((c[0] as { text: string }).text).toBe("ABC");
  });

  it("command_execution updated → no-op (completed 시 일괄 발행)", () => {
    expect(
      mapThreadEvent({
        type: "item.updated",
        item: {
          id: "i3",
          type: "command_execution",
          command: "ls",
          aggregated_output: "partial",
          status: "in_progress",
        },
      }),
    ).toEqual([]);
  });
});

describe("item.completed 매핑", () => {
  it("agent_message (text 있음) → assistant_message durable final", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Hello world" },
    });
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({
      type: "assistant_message",
      content: "Hello world",
      raw_event_type: "item.completed",
      item_id: "i1",
      _final_for_live_stream: true,
    });
    expect(typeof (sse[0] as { timestamp: number }).timestamp).toBe("number");
  });

  it("agent_message (text 빈 문자열) → assistant_message content=''", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "" },
    });
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({ type: "assistant_message", content: "" });
  });

  it("agent_message — 한글·이모지·multiline verbatim 보존 (인코딩 변조 금지)", () => {
    const text = "안녕하세요 🌸\n두 번째 줄\n세 번째 줄";
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text },
    });
    expect(sse).toHaveLength(1);
    expect((sse[0] as { content: string }).content).toBe(text);
  });

  it("agent_message — assistant_message timestamp를 가진다", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "x" },
    });
    const t0 = (sse[0] as { timestamp: number }).timestamp;
    expect(typeof t0).toBe("number");
  });

  it("reasoning → thinking (text + signature='')", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i2", type: "reasoning", text: "thinking..." },
    });
    expect(sse[0]).toMatchObject({
      type: "thinking",
      thinking: "thinking...",
      signature: "",
    });
  });

  // F2 (PR fix/soul-server-ts-chat-sse-python-parity): tool_result payload는 Python
  // `ToolResultEngineEvent.to_sse()` 정합으로 `tool_name` + 문자열 `result` + `is_error` +
  // `tool_use_id` + `timestamp` 형태. soul-ui `node-factory.ts:323`이 `e.result`를 string으로
  // 가정(`.length`, `.slice`)하므로 boundary에서 stringify 보장. 기존 `content` 필드는 제거.
  it("F2: command_execution success → tool_result (tool_name=command, result=aggregated_output string)", () => {
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
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_name: "command",
      tool_use_id: "i3",
      result: "hi\n",
      is_error: false,
    });
    // `content` 키는 *제거됨* (design-principles §3 정본 둘 안티패턴 회피)
    expect(sse[0] as Record<string, unknown>).not.toHaveProperty("content");
    expect(typeof (sse[0] as { result: unknown }).result).toBe("string");
  });

  it("F2: command_execution failed + 빈 출력 → result에 exit_code 단서 prefix (is_error=true)", () => {
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
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_name: "command",
      tool_use_id: "i3b",
      result: "[exit 1]",  // 빈 출력 + 실패 시 사용자 단서
      is_error: true,
    });
  });

  it("F2: file_change completed → tool_result (tool_name=file_change, result=JSON.stringify(changes))", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i4",
        type: "file_change",
        changes: [{ path: "a.ts", kind: "update" }],
        status: "completed",
      },
    });
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_name: "file_change",
      tool_use_id: "i4",
      result: JSON.stringify([{ path: "a.ts", kind: "update" }]),
      is_error: false,
    });
    expect(sse[0] as Record<string, unknown>).not.toHaveProperty("content");
  });

  it("F2: mcp_tool_call success → tool_result (tool_name=mcp/server/tool, result=JSON.stringify(result))", () => {
    const mcpResult = { content: [], structured_content: { ok: true } };
    const sse = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i5",
        type: "mcp_tool_call",
        server: "trello",
        tool: "create_card",
        arguments: {},
        result: mcpResult,
        status: "completed",
      },
    });
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_name: "mcp/trello/create_card",
      tool_use_id: "i5",
      result: JSON.stringify(mcpResult),
      is_error: false,
    });
    expect(sse[0] as Record<string, unknown>).not.toHaveProperty("content");
  });

  it("F2: mcp_tool_call failed → tool_result (result = error.message)", () => {
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
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_name: "mcp/x/y",
      tool_use_id: "i5b",
      result: "boom",
      is_error: true,
    });
    expect(sse[0] as Record<string, unknown>).not.toHaveProperty("content");
  });

  it("F2: web_search completed → tool_result (tool_name=web_search, result='Search: {query}')", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i6", type: "web_search", query: "openai sdk" },
    });
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_name: "web_search",
      tool_use_id: "i6",
      result: "Search: openai sdk",
      is_error: false,
    });
    expect(sse[0] as Record<string, unknown>).not.toHaveProperty("content");
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
      item: { id: "i8", type: "error", message: "non-fatal" },
    });
    expect(sse[0]).toMatchObject({
      type: "error",
      message: "non-fatal",
      fatal: false,
    });
  });
});

describe("claude·codex wire 대칭성 (백엔드 간 정합 가드)", () => {
  it("completed agent_message는 durable assistant_message 단일 이벤트로 emit한다", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "non-empty content" },
    });
    const codexTypeSequence = sse.map((p) => (p as { type: string }).type);
    expect(codexTypeSequence).toEqual(["assistant_message"]);
    expect(sse[0]).toMatchObject({
      type: "assistant_message",
      content: "non-empty content",
      _final_for_live_stream: true,
    });
  });
});

describe("매퍼 stateless 검증", () => {
  it("동일 ThreadEvent 입력에 동일 출력 (timestamp는 매번 갱신)", () => {
    const event = { type: "thread.started" as const, thread_id: "thr-1" };
    const out1 = mapThreadEvent(event);
    const out2 = mapThreadEvent(event);
    // session payload는 timestamp 없음 — 완전 동일
    expect(out1).toEqual(out2);
  });

  it("text_delta 시퀀스는 누적 텍스트 그대로 — state 없음", () => {
    const e1 = { type: "item.updated" as const, item: { id: "x", type: "agent_message" as const, text: "A" } };
    const e2 = { type: "item.updated" as const, item: { id: "x", type: "agent_message" as const, text: "AB" } };
    expect((mapThreadEvent(e1)[0] as { text: string }).text).toBe("A");
    expect((mapThreadEvent(e2)[0] as { text: string }).text).toBe("AB");
  });
});

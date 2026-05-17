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

describe("item.started 매핑 (B-3 streaming 활성)", () => {
  it("agent_message → text_start (text 필드 없음, timestamp 박힘)", () => {
    const sse = mapThreadEvent({
      type: "item.started",
      item: { id: "i1", type: "agent_message", text: "" },
    });
    expect(sse).toHaveLength(1);
    const ev = sse[0] as Record<string, unknown>;
    expect(ev.type).toBe("text_start");
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
  it("agent_message (text 있음) → text_start + text_delta(text) + text_end — claude 정본 시퀀스 정합", () => {
    // 분석 캐시 `20260517-1325-codex-ts-sse-ui-routing.md`:
    // soul-ui tree-placer.handleTextStart가 text_start 수신 시 activeTextTarget 설정.
    // 후속 text_delta·text_end가 activeTextTarget을 통해 같은 노드에 누적·완료.
    // text_start 없이는 두 이벤트 모두 silent drop (`node-factory.ts:296-312`).
    // 따라서 codex-rs가 item.started를 emit하지 않을 때 mapper가 text_start까지
    // 합성해야 채팅 UI에 본문이 표시된다 — claude `engine/types.py:90` 정본 시퀀스와 정합.
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Hello world" },
    });
    expect(sse).toHaveLength(3);
    const startEv = sse[0] as Record<string, unknown>;
    expect(startEv.type).toBe("text_start");
    expect(startEv.text).toBeUndefined();  // Python schemas.py L155-159 정합
    expect(typeof startEv.timestamp).toBe("number");
    expect(sse[1]).toMatchObject({
      type: "text_delta",
      text: "Hello world",
    });
    const endEv = sse[2] as Record<string, unknown>;
    expect(endEv.type).toBe("text_end");
    expect(endEv.text).toBeUndefined();  // Python schemas.py L170-174 정합
    expect(endEv.item_id).toBeUndefined();
    expect(typeof endEv.timestamp).toBe("number");
  });

  it("agent_message (text 빈 문자열) → text_end만 (sequence 합성 안 함)", () => {
    // text가 없으면 text_start·text_delta 합성은 클라이언트 누적 모델에 noise.
    // text_end만 발행 — text_start 없는 text_end는 클라이언트 no-op이고 history 종결 신호로 정합.
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "" },
    });
    expect(sse).toHaveLength(1);
    expect((sse[0] as { type: string }).type).toBe("text_end");
    expect((sse[0] as { text?: unknown }).text).toBeUndefined();
  });

  it("agent_message — 한글·이모지·multiline verbatim 보존 (인코딩 변조 금지)", () => {
    const text = "안녕하세요 🌸\n두 번째 줄\n세 번째 줄";
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text },
    });
    expect(sse).toHaveLength(3);
    expect((sse[1] as { text: string }).text).toBe(text);
  });

  it("agent_message — text_start·text_delta·text_end의 timestamp는 모두 동일 (atomic 묶음, claude 정본 정합)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "x" },
    });
    const t0 = (sse[0] as { timestamp: number }).timestamp;
    const t1 = (sse[1] as { timestamp: number }).timestamp;
    const t2 = (sse[2] as { timestamp: number }).timestamp;
    expect(t0).toBe(t1);
    expect(t1).toBe(t2);
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
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "i3",
      content: { output: "hi\n", exit_code: 0 },
      is_error: false,
    });
  });

  it("command_execution failed → tool_result (is_error=true)", () => {
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
      tool_use_id: "i3b",
      is_error: true,
    });
  });

  it("file_change completed → tool_result", () => {
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
      tool_use_id: "i4",
      is_error: false,
    });
  });

  it("mcp_tool_call success → tool_result (is_error=false)", () => {
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
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "i5b",
      content: { error: "boom" },
      is_error: true,
    });
  });

  it("web_search completed → tool_result (query)", () => {
    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i6", type: "web_search", query: "openai sdk" },
    });
    expect(sse[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "i6",
      content: { query: "openai sdk" },
      is_error: false,
    });
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
  it("agent_message 텍스트 블록은 claude 정본 시퀀스 'text_start → text_delta → text_end'와 동일 type 순서로 emit한다", () => {
    // Python 정본: `soul-server/src/soul_server/engine/types.py:90`
    //   """텍스트 블록 이벤트 (text_start → text_delta → text_end 시퀀스 생성)"""
    // DB 라이브 claude 샘플 (`sess-20260322110817-20ec409b`)도 동일 순서를 따른다.
    // codex 매퍼가 이 시퀀스를 정합 emit하지 않으면 다운스트림(soul-ui, DB 검색, dashboard)에서
    // 백엔드 비대칭으로 인한 결함이 누적된다 (분석 캐시 `20260517-1325` §A 가설 S3 채택 근거).
    const CLAUDE_CANONICAL_TEXT_SEQUENCE = [
      "text_start",
      "text_delta",
      "text_end",
    ] as const;

    const sse = mapThreadEvent({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "non-empty content" },
    });
    const codexTypeSequence = sse.map((p) => (p as { type: string }).type);
    expect(codexTypeSequence).toEqual([...CLAUDE_CANONICAL_TEXT_SEQUENCE]);
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

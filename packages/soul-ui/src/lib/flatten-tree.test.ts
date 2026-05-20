/**
 * flatten-tree 테스트
 *
 * 트리 → flat ChatMessage 리스트 변환의 정확성을 검증합니다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { flattenTree, clearFlattenTreeCache, extractEventId, type ChatMessage } from "./flatten-tree";
import type { EventTreeNode, SessionNode, UserMessageNode, SystemMessageNode, ThinkingNode, TextNode, ToolNode, ResultNode, ErrorNode, CompactNode, CompleteNode } from "@shared/types";

function makeSession(children: EventTreeNode[] = []): SessionNode {
  return { type: "session", id: "session-root", content: "", completed: false, children };
}

function makeUserMessage(id: string, text: string, children: EventTreeNode[] = []): UserMessageNode {
  return { type: "user_message", id, content: text, completed: true, user: "dashboard", children };
}

function makeThinking(id: string, thinking: string): ThinkingNode {
  return {
    type: "thinking", id, content: thinking, completed: true, children: [],
  };
}

function makeText(id: string, text: string, opts?: { textCompleted?: boolean }): TextNode {
  return {
    type: "text", id, content: text, completed: opts?.textCompleted ?? true, children: [],
    textCompleted: opts?.textCompleted ?? true,
  };
}

function makeTool(id: string, name: string, opts?: { completed?: boolean; isError?: boolean; durationMs?: number }): ToolNode {
  return {
    type: "tool", id, content: "", completed: opts?.completed ?? true, children: [],
    toolName: name, toolInput: {}, isError: opts?.isError, durationMs: opts?.durationMs,
  };
}

function makeResult(id: string, opts?: { usage?: { input_tokens: number; output_tokens: number }; totalCostUsd?: number }): ResultNode {
  return {
    type: "result", id, content: "done", completed: true, children: [],
    usage: opts?.usage, totalCostUsd: opts?.totalCostUsd,
  };
}

function makeError(id: string, message: string): ErrorNode {
  return { type: "error", id, content: message, completed: true, children: [], isError: true };
}

function makeCompact(id: string, message: string): CompactNode {
  return { type: "compact", id, content: message, completed: true, children: [] };
}

function makeComplete(
  id: string,
  message: string,
  opts?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens?: number;
      reasoning_output_tokens?: number;
    };
    totalCostUsd?: number;
  },
): CompleteNode {
  return {
    type: "complete",
    id,
    content: message,
    completed: true,
    children: [],
    usage: opts?.usage,
    totalCostUsd: opts?.totalCostUsd,
  };
}

function makeSystemMessage(id: string, text: string): SystemMessageNode {
  return { type: "system_message", id, content: text, completed: true, children: [] };
}

function makeAgentUserMessage(
  id: string,
  text: string,
  agentInfo: { agent_node: string; agent_id: string | null; agent_name: string | null },
): UserMessageNode {
  return {
    type: "user_message",
    id,
    content: text,
    completed: true,
    user: "agent",
    children: [],
    agentInfo: { source: "agent", ...agentInfo },
  };
}

// === Tests ===

describe("flattenTree", () => {
  it("null 트리 → 빈 배열", () => {
    expect(flattenTree(null)).toEqual([]);
  });

  it("session 루트만 있으면 빈 배열", () => {
    expect(flattenTree(makeSession())).toEqual([]);
  });

  it("user_message + thinking + text + tool 조합", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hello", [
        makeThinking("t1", "내면 사고"),
        makeText("txt1", "응답 텍스트", { textCompleted: true }),
        makeTool("tool1", "Read", { completed: true, durationMs: 300 }),
      ]),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs).toHaveLength(4);

    // user
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");

    // thinking
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("내면 사고");
    expect(msgs[1].thinkingContent).toBe("내면 사고");

    // text (independent)
    expect(msgs[2].role).toBe("assistant");
    expect(msgs[2].content).toBe("응답 텍스트");

    // tool
    expect(msgs[3].role).toBe("tool");
    expect(msgs[3].toolName).toBe("Read");
    expect(msgs[3].content).toContain("Read");
    expect(msgs[3].content).toContain("0.3s");
  });

  it("thinking만 단독 → content를 직접 표시", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeThinking("t1", "사고 내용만"),
      ]),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[1].content).toBe("사고 내용만");
    expect(msgs[1].thinkingContent).toBe("사고 내용만");
  });

  it("독립 text 노드", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeText("txt1", "독립 응답", { textCompleted: true }),
      ]),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("독립 응답");
    expect(msgs[1].isStreaming).toBe(false);
  });

  it("스트리밍 중인 text 노드", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeText("txt1", "스트리밍 중...", { textCompleted: false }),
      ]),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[1].isStreaming).toBe(true);
  });

  it("서브에이전트 children도 flat하게 포함", () => {
    const subTool = makeTool("sub-tool1", "Bash", { completed: true });
    const parentTool = makeTool("tool1", "Task", { completed: true });
    parentTool.children = [subTool];

    const tree = makeSession([
      makeUserMessage("u1", "hi", [parentTool]),
    ]);

    const msgs = flattenTree(tree);
    // user + Task + Bash = 3
    expect(msgs).toHaveLength(3);
    expect(msgs[1].toolName).toBe("Task");
    expect(msgs[2].toolName).toBe("Bash");
  });

  it("result 노드의 usage/cost 매핑", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeResult("r1", {
          usage: { input_tokens: 1000, output_tokens: 500 },
          totalCostUsd: 0.0234,
        }),
      ]),
    ]);

    const msgs = flattenTree(tree);
    const result = msgs.find((m) => m.treeNodeType === "result")!;
    expect(result.role).toBe("system");
    expect(result.usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
    expect(result.totalCostUsd).toBe(0.0234);
    expect(result.content).toContain("$0.0234");
  });

  it("error 노드", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeError("e1", "Something went wrong"),
      ]),
    ]);

    const msgs = flattenTree(tree);
    const err = msgs.find((m) => m.treeNodeType === "error")!;
    expect(err.role).toBe("system");
    expect(err.isError).toBe(true);
    expect(err.content).toBe("Something went wrong");
  });

  it("intervention 노드", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", []),
      { type: "intervention" as const, id: "int1", content: "잠깐만", completed: true, children: [] },
    ]);

    const msgs = flattenTree(tree);
    const intervention = msgs.find((m) => m.role === "intervention")!;
    expect(intervention.content).toBe("잠깐만");
  });

  it("intervention 노드 callerInfo·agentInfo forward (F-9 fix)", () => {
    // F-9 fix(2026-05-08): 2차+ 메시지의 발신자 신원이 ChatMessage까지 전파되는지 검증.
    // InterventionMessage가 메시지-단위 caller_info로 발신자 아바타를 표시하려면
    // flatten-tree가 InterventionNode의 callerInfo·agentInfo를 ChatMessage에 forward해야 한다.
    const slackCaller = {
      source: "slack" as const,
      display_name: "동료",
      avatar_url: "https://example.com/avatar.png",
      user_id: "U123",
    };
    const agentCaller = {
      source: "agent" as const,
      agent_node: "node-a",
      agent_id: "agent-x",
      agent_name: "Roselin",
    };
    const tree = makeSession([
      {
        type: "intervention" as const,
        id: "int-slack",
        content: "슬랙 2차 메시지",
        completed: true,
        children: [],
        callerInfo: slackCaller,
      },
      {
        type: "intervention" as const,
        id: "int-agent",
        content: "위임 메시지",
        completed: true,
        children: [],
        callerInfo: agentCaller,
        agentInfo: agentCaller,
      },
    ]);

    const msgs = flattenTree(tree);
    const slack = msgs.find((m) => m.id === "int-slack")!;
    const agent = msgs.find((m) => m.id === "int-agent")!;

    expect(slack.callerInfo).toEqual(slackCaller);
    expect(slack.agentInfo).toBeUndefined();

    expect(agent.callerInfo).toEqual(agentCaller);
    expect(agent.agentInfo).toEqual(agentCaller);
  });

  it("T-4 (Phase A): intervention 노드 context를 ChatMessage.contextItems로 forward (atom d7a1ad86 차단)", () => {
    // Phase A context 정본 (Y-8): UserMessage와 대칭으로 InterventionMessage가
    // ContextBlock 렌더링하도록 contextItems를 forward. 본 사이클 이전엔 intervention case에서
    // contextItems forward가 없어 Python `on_intervention_sent`가 박은 context가 UI에 도달하지 않음.
    const ctxItems = [
      { key: "soulstream_session", label: "Soulstream", content: { folder: "X" } },
    ];
    const tree = makeSession([
      {
        type: "intervention" as const,
        id: "int-with-ctx",
        content: "context 운반 케이스",
        completed: true,
        children: [],
        context: ctxItems,
      },
      {
        type: "intervention" as const,
        id: "int-without-ctx",
        content: "context 없는 케이스",
        completed: true,
        children: [],
      },
    ]);

    const msgs = flattenTree(tree);
    const withCtx = msgs.find((m) => m.id === "int-with-ctx")!;
    const withoutCtx = msgs.find((m) => m.id === "int-without-ctx")!;

    expect(withCtx.contextItems).toEqual(ctxItems);
    expect(withoutCtx.contextItems).toBeUndefined();
  });

  it("compact 노드", () => {
    const tree = makeSession([
      makeCompact("c1", "Context compacted"),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Context compacted");
  });

  it("complete 노드", () => {
    const tree = makeSession([
      makeComplete("cmp1", "Turn done"),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Turn done");
  });

  it("complete 노드의 usage/cost를 완료 줄에 표시한다", () => {
    const tree = makeSession([
      makeComplete("cmp1", "Turn done", {
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cached_input_tokens: 300,
          reasoning_output_tokens: 50,
        },
        totalCostUsd: 0.0123,
      }),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe(
      "Turn Complete  $0.0123  1,500 tokens (1,000 in / 500 out / 300 cached / 50 reasoning)",
    );
    expect(msgs[0].usage).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      cached_input_tokens: 300,
      reasoning_output_tokens: 50,
    });
    expect(msgs[0].totalCostUsd).toBe(0.0123);
  });

  it("tool 에러 상태 표시", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeTool("tool1", "Write", { completed: true, isError: true }),
      ]),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[1].content).toContain("error");
    expect(msgs[1].isError).toBe(true);
  });

  it("tool 진행 중 상태", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hi", [
        makeTool("tool1", "Bash", { completed: false }),
      ]),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[1].content).toContain("running");
  });

  it("system_message 노드 → role='system_message'", () => {
    const tree = makeSession([
      makeSystemMessage("sm1", "당신은 유용한 AI 어시스턴트입니다."),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system_message");
    expect(msgs[0].content).toBe("당신은 유용한 AI 어시스턴트입니다.");
    expect(msgs[0].treeNodeType).toBe("system_message");
  });

  it("user_message agentInfo 전파", () => {
    const tree = makeSession([
      makeAgentUserMessage("u1", "에이전트가 보낸 메시지", {
        agent_node: "node-1",
        agent_id: "agent-abc",
        agent_name: "TestAgent",
      }),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].agentInfo).toEqual({
      source: "agent",
      agent_node: "node-1",
      agent_id: "agent-abc",
      agent_name: "TestAgent",
    });
  });

  it("user_message agentInfo 없을 때 undefined", () => {
    const tree = makeSession([
      makeUserMessage("u1", "일반 사용자 메시지"),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[0].agentInfo).toBeUndefined();
  });

  // === callerInfo propagation (atom ed3a216d 후속 fix) ===

  it("user_message callerInfo 전파 (browser source)", () => {
    const callerInfo = {
      source: "browser" as const,
      display_name: "Jubok Kim",
      avatar_url: "https://lh3.googleusercontent.com/a/X",
      email: "eias@example.com",
    };
    const node: UserMessageNode = {
      type: "user_message",
      id: "u1",
      content: "hello from browser",
      completed: true,
      user: "dashboard",
      children: [],
      callerInfo,
    };
    const tree = makeSession([node]);

    const msgs = flattenTree(tree);
    expect(msgs[0].callerInfo).toBe(callerInfo);
    expect(msgs[0].callerInfo?.avatar_url).toBe("https://lh3.googleusercontent.com/a/X");
  });

  it("user_message callerInfo + agentInfo 둘 다 propagate (agent source)", () => {
    const callerInfo = {
      source: "agent" as const,
      display_name: "shay",
      avatar_url: "/api/agents/shay/portrait",
      agent_node: "eias",
      agent_id: "shay",
      agent_name: "Shay",
    };
    const node: UserMessageNode = {
      type: "user_message",
      id: "u1",
      content: "delegated",
      completed: true,
      user: "agent",
      children: [],
      agentInfo: { source: "agent", agent_node: "eias", agent_id: "shay", agent_name: "Shay" },
      callerInfo,
    };
    const tree = makeSession([node]);

    const msgs = flattenTree(tree);
    expect(msgs[0].agentInfo?.agent_id).toBe("shay");
    expect(msgs[0].callerInfo).toBe(callerInfo);
  });

  it("user_message callerInfo 없을 때 undefined (회귀 보호)", () => {
    const tree = makeSession([
      makeUserMessage("u1", "plain"),
    ]);

    const msgs = flattenTree(tree);
    expect(msgs[0].callerInfo).toBeUndefined();
  });
});

// === Identity 보존 캐시 ===

describe("flattenTree identity 보존", () => {
  beforeEach(() => {
    clearFlattenTreeCache();
  });

  it("같은 트리를 두 번 호출하면 모든 ChatMessage가 동일 reference (===)", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hello", [
        makeThinking("t1", "thinking"),
        makeText("txt1", "response", { textCompleted: true }),
        makeTool("tool1", "Read", { completed: true }),
      ]),
    ]);

    const first = flattenTree(tree);
    const second = flattenTree(tree);
    expect(first).toHaveLength(second.length);
    for (let i = 0; i < first.length; i++) {
      expect(first[i]).toBe(second[i]);
    }
  });

  it("자식 push로 트리를 mutate한 후 — 변경되지 않은 노드는 동일 reference, 새 노드만 새 reference", () => {
    const userNode = makeUserMessage("u1", "hello", [
      makeThinking("t1", "thinking"),
      makeText("txt1", "response", { textCompleted: true }),
    ]);
    const tree = makeSession([userNode]);

    const before = flattenTree(tree);

    // 자식 push (in-place mutation)
    userNode.children.push(makeTool("tool1", "Read", { completed: true }));

    const after = flattenTree(tree);
    expect(after).toHaveLength(before.length + 1);
    // 기존 노드들 reference 보존
    expect(after[0]).toBe(before[0]); // user
    expect(after[1]).toBe(before[1]); // thinking
    expect(after[2]).toBe(before[2]); // text
    // 새 노드는 추가됨
    expect(after[3].toolName).toBe("Read");
  });

  it("text content가 변경된 노드만 새 reference, 나머지는 보존 (text_delta 시뮬)", () => {
    const textNode = makeText("txt1", "initial", { textCompleted: false });
    const userNode = makeUserMessage("u1", "hello", [textNode]);
    const tree = makeSession([userNode]);

    const before = flattenTree(tree);

    // text_delta 적용 시뮬레이션 (content 변경)
    textNode.content = "updated content";

    const after = flattenTree(tree);
    expect(after[0]).toBe(before[0]); // user 노드 보존
    expect(after[1]).not.toBe(before[1]); // text 노드는 새 reference
    expect(after[1].content).toBe("updated content");
  });

  it("clearFlattenTreeCache() 호출 후 — 모든 ChatMessage가 새 reference로 갱신", () => {
    const tree = makeSession([
      makeUserMessage("u1", "hello", [
        makeThinking("t1", "thinking"),
      ]),
    ]);

    const before = flattenTree(tree);
    clearFlattenTreeCache();
    const after = flattenTree(tree);

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      // 캐시 클리어 후이므로 reference는 모두 새것
      expect(after[i]).not.toBe(before[i]);
      // 단 값은 동일
      expect(after[i].id).toBe(before[i].id);
      expect(after[i].content).toBe(before[i].content);
    }
  });

  // === callerInfo reference 보존 (atom b0c41f5c shallowEqual 안전) ===

  it("같은 callerInfo reference 유지 시 ChatMessage reference 보존", () => {
    const callerInfo = {
      source: "browser" as const,
      avatar_url: "/x.png",
    };
    const userNode: UserMessageNode = {
      type: "user_message",
      id: "u1",
      content: "hello",
      completed: true,
      user: "dashboard",
      children: [],
      callerInfo,
    };
    const tree = makeSession([userNode]);

    const before = flattenTree(tree);
    const after = flattenTree(tree);

    expect(after[0]).toBe(before[0]);
    expect(after[0].callerInfo).toBe(callerInfo);
  });

  it("callerInfo가 다른 reference로 바뀌면 ChatMessage 새 reference (shallowEqual miss)", () => {
    const ci1 = { source: "browser" as const, avatar_url: "/old.png" };
    const userNode: UserMessageNode = {
      type: "user_message",
      id: "u1",
      content: "hello",
      completed: true,
      user: "dashboard",
      children: [],
      callerInfo: ci1,
    };
    const tree = makeSession([userNode]);

    const before = flattenTree(tree);
    // caller_info를 새 reference로 교체 (서버에서 새 update 도착 시뮬)
    userNode.callerInfo = { source: "browser", avatar_url: "/new.png" };
    const after = flattenTree(tree);

    expect(after[0]).not.toBe(before[0]); // shallowEqual이 callerInfo reference 비교 → miss
    expect(after[0].callerInfo?.avatar_url).toBe("/new.png");
  });
});

// === extractEventId — node ID 끝자리 숫자 추출 (H-1 정본) ===
//
// 260508.05.tree-placer-hygiene: extractEventId 가 정규식 정본의 단일 export.
// tree-placer.ts 의 extractNodeEventId 가 caller-local adapter 로 본 함수를 호출한다.

describe("extractEventId — node ID 끝자리 숫자 추출 (H-1 정본)", () => {
  it("createNodeFromEvent 패턴 — 끝자리 숫자 추출", () => {
    expect(extractEventId("user-msg-100")).toBe(100);
    expect(extractEventId("tool-7")).toBe(7);
    expect(extractEventId("text-42")).toBe(42);
    expect(extractEventId("input-request-20")).toBe(20);
    expect(extractEventId("away-summary-999")).toBe(999);
  });

  it("매칭 실패 시 undefined 반환", () => {
    expect(extractEventId("session-root")).toBeUndefined();
    expect(extractEventId("")).toBeUndefined();
    expect(extractEventId("plain-id")).toBeUndefined();
    expect(extractEventId("trailing-number-but-no-dash100")).toBeUndefined();
  });

  it("eventId === 0 도 매칭 (fall-through 와 구분)", () => {
    // 0 은 dedup 가드(eventId > 0)에서 차단되지만 추출 자체는 0 반환.
    expect(extractEventId("user-msg-0")).toBe(0);
  });
});

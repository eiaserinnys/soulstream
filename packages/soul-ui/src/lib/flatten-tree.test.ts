/**
 * flatten-tree 테스트
 *
 * 트리 → flat ChatMessage 리스트 변환의 정확성을 검증합니다.
 */

import { describe, it, expect } from "vitest";
import { flattenTree, type ChatMessage } from "./flatten-tree";
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

function makeComplete(id: string, message: string): CompleteNode {
  return { type: "complete", id, content: message, completed: true, children: [] };
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
});

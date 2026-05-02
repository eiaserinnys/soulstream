/**
 * tree-placer historyMode children 정렬 테스트
 *
 * historyMode=true일 때 부모의 children에 eventId ASC 기준 sorted insert로 자식이 들어가는지 검증.
 * historyMode=false(라이브 SSE 경로)는 push 동작이 그대로 보존되는지 검증.
 *
 * 결함 배경:
 *   prepend 페이지는 기존 children보다 시간상 이전이므로, push로 끝에 매달면 화면 위→아래 순서가
 *   [기존 새 메시지들, prepend 옛 메시지들]이 되어 사용자에게 "옛 메시지가 화면 아래로 붙는" 결함이 발생.
 *   tree-placer.ts:attachToParent의 일반 attach 경로와 adoptees 합류 경로 모두에서 historyMode 분기 필요.
 */

import { describe, it, expect } from "vitest";
import { placeInTree } from "./tree-placer";
import { createProcessingContext, makeNode, registerNode } from "./processing-context";
import type { ProcessingContext } from "./processing-context";
import type {
  EventTreeNode,
  UserMessageEvent,
  ThinkingEvent,
  ToolStartEvent,
} from "../../shared/types";

function makeCtxWithRoot(): { ctx: ProcessingContext; root: EventTreeNode } {
  const ctx = createProcessingContext();
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return { ctx, root };
}

function userEvent(): UserMessageEvent {
  return { type: "user_message", content: "u" } as UserMessageEvent;
}

function thinkingEvent(parentEventId: string | null): ThinkingEvent {
  return {
    type: "thinking",
    content: "t",
    ...(parentEventId !== null ? { parent_event_id: parentEventId } : {}),
  } as ThinkingEvent;
}

function toolEvent(parentEventId: string): ToolStartEvent {
  return {
    type: "tool_start",
    tool_name: "test",
    parent_event_id: parentEventId,
  } as ToolStartEvent;
}

/** node.id 끝 숫자 추출 — flatten-tree.ts의 extractEventId와 동일 시맨틱. */
function idEventId(node: EventTreeNode): number {
  const m = node.id.match(/-(\d+)$/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

describe("tree-placer historyMode — children eventId ASC sorted insert", () => {
  it("Case A — root 자식 sorted insert (도착 순서 100 → 50)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // user_message(100) 먼저 도착 (parent=null → root)
    const u100 = makeNode("user-msg-100", "user_message", "u100");
    placeInTree(u100, userEvent(), 100, ctx, root);

    // 그 다음 더 오래된 user_message(50) 도착
    const u50 = makeNode("user-msg-50", "user_message", "u50");
    placeInTree(u50, userEvent(), 50, ctx, root);

    // 기대: root.children eventId ASC = [50, 100]
    expect(root.children.map((c) => c.id)).toEqual(["user-msg-50", "user-msg-100"]);
    expect(root.children.map(idEventId)).toEqual([50, 100]);
  });

  it("Case B — 내부 노드 자식 sorted insert (기존 자식 사이 삽입)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // 부모 user_message(50)을 먼저 root에 attach
    const u50 = makeNode("user-msg-50", "user_message", "u50");
    placeInTree(u50, userEvent(), 50, ctx, root);

    // tool(80), tool(90)을 user-msg-50의 자식으로 추가 (ASC 순서로 도착)
    const t80 = makeNode("tool-80", "tool", "t80");
    placeInTree(t80, toolEvent("50"), 80, ctx, root);
    const t90 = makeNode("tool-90", "tool", "t90");
    placeInTree(t90, toolEvent("50"), 90, ctx, root);

    // 시점에서 user-msg-50.children = [tool-80, tool-90]
    expect(u50.children.map((c) => c.id)).toEqual(["tool-80", "tool-90"]);

    // 다음 페이지에서 더 오래된 thinking(70)이 도착 (parent="50")
    const th70 = makeNode("thinking-70", "thinking", "th70");
    placeInTree(th70, thinkingEvent("50"), 70, ctx, root);

    // 기대: u50.children eventId ASC = [70, 80, 90] (binary search idx=0, splice)
    expect(u50.children.map((c) => c.id)).toEqual(["thinking-70", "tool-80", "tool-90"]);
    expect(u50.children.map(idEventId)).toEqual([70, 80, 90]);
  });

  it("Case C — 같은 페이지 부모→자식 도착 (시간 ASC, 단순 push와 결과 동일)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // user_message(50) → thinking(55) → text(60) 시간 ASC 순으로 도착
    const u50 = makeNode("user-msg-50", "user_message", "u50");
    placeInTree(u50, userEvent(), 50, ctx, root);

    const th55 = makeNode("thinking-55", "thinking", "th55");
    placeInTree(th55, thinkingEvent("50"), 55, ctx, root);

    const th60 = makeNode("thinking-60", "thinking", "th60");
    placeInTree(th60, thinkingEvent("50"), 60, ctx, root);

    // 기대: u50.children = [thinking-55, thinking-60] (sorted insert가 ASC 도착에서도 안전)
    expect(u50.children.map((c) => c.id)).toEqual(["thinking-55", "thinking-60"]);
    expect(u50.children.map(idEventId)).toEqual([55, 60]);
  });

  it("Case D — orphan adopt 시 sorted insert (도착 순서 ≠ eventId 순서)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // 1. thinking(70), parent="50" — 부모 부재 → orphan["50"] = [thinking-70]
    const th70 = makeNode("thinking-70", "thinking", "th70");
    placeInTree(th70, thinkingEvent("50"), 70, ctx, root);

    // 2. tool(60), parent="50" — 부모 부재 → orphan["50"] = [thinking-70, tool-60]
    const t60 = makeNode("tool-60", "tool", "t60");
    placeInTree(t60, toolEvent("50"), 60, ctx, root);

    // 3. tool(90), parent="50" — 부모 부재 → orphan["50"] = [thinking-70, tool-60, tool-90]
    const t90 = makeNode("tool-90", "tool", "t90");
    placeInTree(t90, toolEvent("50"), 90, ctx, root);

    // 도착 순서대로 orphan 큐에 쌓임
    expect(ctx.orphans.get("50")?.map((n) => n.id)).toEqual(["thinking-70", "tool-60", "tool-90"]);

    // 4. user_message(50) 도착 → root에 sorted insert + adoptees 합류
    const u50 = makeNode("user-msg-50", "user_message", "u50");
    placeInTree(u50, userEvent(), 50, ctx, root);

    // 기대: u50.children eventId ASC = [60, 70, 90] (도착 순서와 무관)
    expect(u50.children.map((c) => c.id)).toEqual(["tool-60", "thinking-70", "tool-90"]);
    expect(u50.children.map(idEventId)).toEqual([60, 70, 90]);
    expect(ctx.orphans.has("50")).toBe(false);
  });

  it("Case E — 라이브 회귀 (historyMode=false에서 push 보존)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = false;

    // 라이브에서는 시간상 ASC가 자연스러우나, 회귀 검증을 위해 일부러 비-ASC로 push 동작 확인
    const u50 = makeNode("user-msg-50", "user_message", "u50");
    placeInTree(u50, userEvent(), 50, ctx, root);
    const u100 = makeNode("user-msg-100", "user_message", "u100");
    placeInTree(u100, userEvent(), 100, ctx, root);
    const u30 = makeNode("user-msg-30", "user_message", "u30");
    placeInTree(u30, userEvent(), 30, ctx, root);

    // 기대: 도착 순서대로 push 보존 (sorted insert 적용 안 됨)
    expect(root.children.map((c) => c.id)).toEqual([
      "user-msg-50",
      "user-msg-100",
      "user-msg-30",
    ]);
    expect(root.children.map(idEventId)).toEqual([50, 100, 30]);
  });
});

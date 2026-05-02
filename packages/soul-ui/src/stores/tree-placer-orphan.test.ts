/**
 * tree-placer orphan 테스트
 *
 * historyMode 진입 시 부모 부재 자식 노드를 ctx.orphans 큐에 보관하고,
 * 부모 도착 시 자동으로 attach하는 동작을 검증한다.
 *
 * 검증 케이스:
 *   1. historyMode + 부모 부재 → orphans에 보관
 *   2. historyMode + 부모 도착 → orphans에서 꺼내 attach
 *   3. liveMode + 부모 부재 → root fallback (기존 동작 보존)
 *   4. 다층 부모-자식 체인 자동 처리 (A→B→C, B가 orphan일 때)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolveParent, placeInTree, ORPHAN_PARENT } from "./tree-placer";
import { createProcessingContext, makeNode, registerNode } from "./processing-context";
import type { ProcessingContext } from "./processing-context";
import type { EventTreeNode, UserMessageEvent, ThinkingEvent } from "../../shared/types";

function makeCtxWithRoot(): { ctx: ProcessingContext; root: EventTreeNode } {
  const ctx = createProcessingContext();
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return { ctx, root };
}

describe("resolveParent - historyMode", () => {
  it("returns ORPHAN_PARENT sentinel when parent missing in historyMode", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    const parent = resolveParent("missing-parent-id", ctx, root);

    expect(parent).toBe(ORPHAN_PARENT);
  });

  it("returns root with warning when parent missing in liveMode (기존 동작)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = false;

    const parent = resolveParent("missing-parent-id", ctx, root);

    expect(parent).toBe(root);
    expect(parent).not.toBe(ORPHAN_PARENT);
  });

  it("returns actual parent regardless of historyMode when parent exists", () => {
    const { ctx, root } = makeCtxWithRoot();
    const existingParent = makeNode("existing", "user_message", "u");
    registerNode(ctx, existingParent);
    ctx.nodeMap.set("100", existingParent);

    ctx.historyMode = true;
    const parent = resolveParent("100", ctx, root);
    expect(parent).toBe(existingParent);
  });
});

describe("placeInTree - orphan 보관", () => {
  it("부모 부재 자식 노드를 ctx.orphans에 parent_event_id 키로 보관", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // 부모 100이 없는 상태에서 자식(eventId 200) 도착
    const childNode = makeNode("thinking-200", "thinking", "child");
    const childEvent: ThinkingEvent = {
      type: "thinking",
      content: "child",
      parent_event_id: "100",
    };

    placeInTree(childNode, childEvent, 200, ctx, root);

    // root에 attach되지 않아야 함
    expect(root.children).not.toContain(childNode);

    // orphans["100"]에 보관됨
    const stored = ctx.orphans.get("100");
    expect(stored).toBeDefined();
    expect(stored).toContain(childNode);

    // 노드 자신은 nodeMap에 등록 (후속 자식의 부모 조회를 위해)
    expect(ctx.nodeMap.get("200")).toBe(childNode);
  });

  it("새 노드가 orphans의 부모일 때 자동 adoption", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // 자식이 먼저 도착 (부모 100 없음)
    const childNode = makeNode("thinking-200", "thinking", "child");
    placeInTree(
      childNode,
      { type: "thinking", content: "child", parent_event_id: "100" } as ThinkingEvent,
      200,
      ctx,
      root,
    );
    expect(ctx.orphans.get("100")).toEqual([childNode]);

    // 부모(eventId 100) 도착
    const parentNode = makeNode("user-100", "user_message", "parent");
    placeInTree(
      parentNode,
      { type: "user_message", content: "parent" } as UserMessageEvent,
      100,
      ctx,
      root,
    );

    // 부모는 root에 attach
    expect(root.children).toContain(parentNode);
    // 자식은 부모로 이동 (orphans에서 제거됨)
    expect(parentNode.children).toContain(childNode);
    expect(ctx.orphans.has("100")).toBe(false);
  });

  it("liveMode에서 부모 부재는 root fallback (orphans 미사용)", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = false;

    const childNode = makeNode("thinking-200", "thinking", "child");
    placeInTree(
      childNode,
      { type: "thinking", content: "child", parent_event_id: "missing" } as ThinkingEvent,
      200,
      ctx,
      root,
    );

    // 기존 동작: root에 직접 attach
    expect(root.children).toContain(childNode);
    expect(ctx.orphans.size).toBe(0);
  });
});

describe("placeInTree - 다층 체인 자동 처리", () => {
  it("A→B→C 시나리오: B가 먼저 orphan이 되어도 A는 B에 attach, C 도착 시 통째로 이동", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // parent_event_id는 부모 eventId의 String 표현이어야 한다.
    // C의 eventId=100, B의 eventId=200, A의 eventId=300.
    // B의 parent="100" (C 가리킴), A의 parent="200" (B 가리킴).

    // 1단계: B 도착 (parent="100", C 미존재) → B는 orphan map["100"]에 보관, nodeMap에 등록
    const nodeB = makeNode("thinking-B", "thinking", "B");
    placeInTree(
      nodeB,
      { type: "thinking", content: "B", parent_event_id: "100" } as ThinkingEvent,
      200,
      ctx,
      root,
    );
    expect(ctx.orphans.get("100")).toContain(nodeB);
    expect(ctx.nodeMap.get("200")).toBe(nodeB); // 핵심: nodeMap에 등록됨

    // 2단계: A 도착 (parent="200"). B는 nodeMap에 있으니 정상 lookup → B.children에 attach
    const nodeA = makeNode("thinking-A", "thinking", "A");
    placeInTree(
      nodeA,
      { type: "thinking", content: "A", parent_event_id: "200" } as ThinkingEvent,
      300,
      ctx,
      root,
    );
    expect(nodeB.children).toContain(nodeA);
    expect(ctx.orphans.has("300")).toBe(false); // A는 orphan 아님
    // B는 여전히 orphans에 있음 (C 도착 대기)
    expect(ctx.orphans.get("100")).toContain(nodeB);

    // 3단계: C 도착 (eventId=100) → adoptees 조회 키 "100" → B 발견 → C.children.push(B)
    //         B의 children에 A가 이미 매달려 있으므로 통째로 이동
    const nodeC = makeNode("user-C", "user_message", "C");
    placeInTree(
      nodeC,
      { type: "user_message", content: "C" } as UserMessageEvent,
      100,
      ctx,
      root,
    );
    // C가 root에 attach (parent_event_id 없음)
    expect(root.children).toContain(nodeC);
    // B가 C로 이동, A는 그대로 B에 매달려 따라옴
    expect(nodeC.children).toContain(nodeB);
    expect(nodeB.children).toContain(nodeA);
    // orphans["100"] 삭제
    expect(ctx.orphans.has("100")).toBe(false);
  });

  it("같은 부모를 가진 여러 orphan이 모두 attach", () => {
    const { ctx, root } = makeCtxWithRoot();
    ctx.historyMode = true;

    // 자식 두 개가 같은 부모 100을 기다림
    const child1 = makeNode("c1", "thinking", "c1");
    const child2 = makeNode("c2", "thinking", "c2");

    placeInTree(
      child1,
      { type: "thinking", content: "c1", parent_event_id: "100" } as ThinkingEvent,
      201,
      ctx,
      root,
    );
    placeInTree(
      child2,
      { type: "thinking", content: "c2", parent_event_id: "100" } as ThinkingEvent,
      202,
      ctx,
      root,
    );
    expect(ctx.orphans.get("100")).toEqual([child1, child2]);

    // 부모 도착
    const parent = makeNode("p", "user_message", "p");
    placeInTree(parent, { type: "user_message", content: "p" } as UserMessageEvent, 100, ctx, root);

    expect(parent.children).toContain(child1);
    expect(parent.children).toContain(child2);
    expect(ctx.orphans.has("100")).toBe(false);
  });
});

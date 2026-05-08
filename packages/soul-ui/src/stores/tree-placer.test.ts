/**
 * tree-placer 테스트 — Phase 2-A 평탄화 + 260508.03 cross-page 정렬 보존 후
 *
 * Phase 2-A (atom 작업 이력 260507.01.fe-tree-flattening, §11.1 옵션 C):
 *   placeInTree와 handleTextStart는 parent_event_id를 무시하고 모든 노드를 root.children에
 *   시간순 삽입한다. orphan 큐, adoptees, historyMode, ORPHAN_PARENT, resolveParent는
 *   모두 폐기되었다.
 *
 * Cross-page 정렬 보존 (atom 작업 이력 260508.03.soul-ui-prepend-cross-page-order):
 *   placeInTree / handleTextStart 는 root.children 을 eventId ASC 로 유지한다.
 *   라이브 SSE 의 일반 시간순 도착은 fast-path push (마지막 자식 비교 1회) 로 처리되며,
 *   본 파일의 모든 케이스가 fast-path 경로 (root 가 비었거나 새 eventId 가 마지막
 *   자식보다 큼) 라 array 결과는 push 와 동일. cross-page slow-path (binary search →
 *   splice) 는 dashboard-store.test.ts 의 케이스 A·C·H·I 가 검증한다.
 *
 *   본 테스트는 Phase 2-A 후의 의도를 검증한다:
 *   1. 모든 노드 타입이 root.children에 (시간순) 삽입되는가
 *   2. nodeMap에 node.id, String(eventId)가 등록되는가
 *   3. tool_start의 tool_use_id 보조 등록 (tool_result 매칭용)
 *   4. input_request의 request_id 보조 등록 (input_request_expired 매칭용)
 *   5. ancestor 동봉 중복(같은 eventId 재진입)은 silent skip 가드로 차단되는가
 *   6. handleTextStart가 활성 text 노드 설정 + 중복 시 false 반환
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { placeInTree, handleTextStart } from "./tree-placer";
import { diag } from "../lib/diag";
import { createProcessingContext, makeNode, registerNode } from "./processing-context";
import type { ProcessingContext } from "./processing-context";
import type {
  EventTreeNode,
  UserMessageEvent,
  InterventionSentEvent,
  ThinkingEvent,
  TextStartEvent,
  ToolStartEvent,
  CompleteEvent,
  ErrorEvent,
  ResultEvent,
  InputRequestEvent,
  SoulSSEEvent,
} from "../../shared/types";

// 260508.05.tree-placer-hygiene H-2: handleTextStart diag 대칭화 검증을 위해
// diag 모듈 전체를 mock. vitest environment="node" 환경에서 lib/diag.ts 의
// `typeof window === "undefined"` 가드가 게이트를 차단하므로, 본 사이클의
// 검증 의도(handleTextStart 가 어떤 인자로 diag 를 호출하는가) 만 검증.
//
// vi.mock 영향 범위는 *해당 test 파일 내* 로 한정 — placeInTree 의 기존 케이스
// (skip 가드, ancestor 동봉 등) 도 diag 가 호출되지만 mock 함수가 silent 하게
// 받아 처리하므로 행동 변경 없음 (기존 케이스 GREEN 유지).
vi.mock("../lib/diag", () => ({
  diag: vi.fn(),
  _resetDiagCache: vi.fn(),
}));

// === Helpers ===

function makeCtxWithRoot(): { ctx: ProcessingContext; root: EventTreeNode } {
  const ctx = createProcessingContext();
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return { ctx, root };
}

// === placeInTree — 모든 노드 타입은 root.children에 push ===

describe("placeInTree (Phase 2-A 평탄화)", () => {
  describe("모든 노드 타입이 root.children에 push", () => {
    it("user_message → root.children", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      const event: UserMessageEvent = { type: "user_message", user: "alice", text: "hello" };

      placeInTree(node, event, 1, ctx, root);

      expect(root.children).toContain(node);
      expect(root.children).toHaveLength(1);
    });

    it("intervention_sent → root.children", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("intervention-2", "intervention", "stop", { completed: true });
      const event: InterventionSentEvent = { type: "intervention_sent", user: "bob", text: "stop" };

      placeInTree(node, event, 2, ctx, root);

      expect(root.children).toContain(node);
    });

    it("thinking → root.children (parent_event_id 무시)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const parent = makeNode("user-msg-1", "user_message", "hi", { completed: true });
      registerNode(ctx, parent);
      ctx.nodeMap.set("100", parent);
      root.children.push(parent);

      const node = makeNode("thinking-3", "thinking", "hmm");
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "hmm",
        parent_event_id: "100", // 무시됨
      };

      placeInTree(node, event, 3, ctx, root);

      // parent.children에 들어가지 *않음*. 모두 root.children 평면.
      expect(parent.children).toHaveLength(0);
      expect(root.children).toContain(node);
      expect(root.children).toEqual([parent, node]);
    });

    it("complete → root.children (parent_event_id 무시)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("complete-12", "complete", "Done", { completed: true });
      const event: CompleteEvent = {
        type: "complete",
        result: "Done",
        attachments: [],
        parent_event_id: "100", // 무시됨
      };

      placeInTree(node, event, 12, ctx, root);

      expect(root.children).toContain(node);
    });

    it("error → root.children (parent_event_id 무시)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("error-14", "error", "boom", { completed: true, isError: true });
      const event: ErrorEvent = { type: "error", message: "boom", parent_event_id: "100" };

      placeInTree(node, event, 14, ctx, root);

      expect(root.children).toContain(node);
    });

    it("result → root.children (parent_event_id 무시)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("result-17", "result", "out", { completed: true });
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "out",
        parent_event_id: "toolu_res", // 무시됨
      };

      placeInTree(node, event, 17, ctx, root);

      expect(root.children).toContain(node);
    });

    it("default unknown event → root.children", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("unknown-19", "text", "fallback");
      const event = { type: "some_future_type" } as unknown as SoulSSEEvent;

      placeInTree(node, event, 19, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("nodeMap 등록", () => {
    it("node.id로 등록", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-99", "user_message", "test");
      const event: UserMessageEvent = { type: "user_message", user: "u", text: "test" };

      placeInTree(node, event, 99, ctx, root);

      expect(ctx.nodeMap.get("user-msg-99")).toBe(node);
    });

    it("String(eventId)로도 등록 (applyUpdate가 _event_id로 lookup)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-1", "user_message", "test");
      const event: UserMessageEvent = { type: "user_message", user: "u", text: "test" };

      placeInTree(node, event, 42, ctx, root);

      expect(ctx.nodeMap.get("42")).toBe(node);
    });

    it("tool_start의 tool_use_id 보조 등록 (tool_result 매칭용)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("tool-1", "tool", "", { toolUseId: "toolu_xyz" });
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "toolu_xyz",
      };

      placeInTree(node, event, 10, ctx, root);

      // 세 가지 키로 등록: node.id, String(eventId), tool_use_id
      expect(ctx.nodeMap.get("tool-1")).toBe(node);
      expect(ctx.nodeMap.get("10")).toBe(node);
      expect(ctx.nodeMap.get("toolu_xyz")).toBe(node);
    });

    it("tool_use_id가 undefined면 tool_use_id 키 등록 없음", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("tool-7", "tool", "");
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
      };

      placeInTree(node, event, 7, ctx, root);

      const toolUseKeys = [...ctx.nodeMap.keys()].filter((k) => k.startsWith("toolu_"));
      expect(toolUseKeys).toHaveLength(0);
      expect(root.children).toContain(node);
    });

    it("input_request의 request_id 보조 등록 (input_request_expired 매칭용)", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("input-request-20", "input_request", "Select option", {
        requestId: "req-001",
        responded: false,
      });
      const event: InputRequestEvent = {
        type: "input_request",
        timestamp: 1700000000,
        request_id: "req-001",
        questions: [{ question: "Select option", options: [{ label: "A" }] }],
      };

      placeInTree(node, event, 20, ctx, root);

      expect(ctx.nodeMap.get("input-request-20")).toBe(node);
      expect(ctx.nodeMap.get("20")).toBe(node);
      expect(ctx.nodeMap.get("req-001")).toBe(node);
      expect(root.children).toContain(node);
    });
  });

  describe("ancestor 동봉 중복 skip 가드", () => {
    it("같은 eventId로 두 번 placeInTree하면 두 번째는 silent skip", () => {
      const { ctx, root } = makeCtxWithRoot();
      const nodeA = makeNode("user-msg-1", "user_message", "first");
      const nodeB = makeNode("user-msg-1-dup", "user_message", "second");
      const event: UserMessageEvent = { type: "user_message", user: "u", text: "first" };

      placeInTree(nodeA, event, 50, ctx, root);
      placeInTree(nodeB, event, 50, ctx, root); // 같은 eventId 재진입

      // 두 번째 호출은 nodeMap.has("50") 가드로 skip됨
      expect(root.children).toContain(nodeA);
      expect(root.children).not.toContain(nodeB);
      expect(root.children).toHaveLength(1);
      expect(ctx.nodeMap.get("50")).toBe(nodeA);
    });
  });
});

// === handleTextStart — 활성 text 노드 설정 ===

describe("handleTextStart (Phase 2-A 평탄화)", () => {
  it("새 text 노드를 root.children에 push하고 activeTextTarget 설정", () => {
    const { ctx, root } = makeCtxWithRoot();

    const event: TextStartEvent = { type: "text_start", timestamp: 0 };
    const changed = handleTextStart(event, 12, ctx, root);

    expect(changed).toBe(true);
    expect(ctx.activeTextTarget).not.toBeNull();
    expect(ctx.activeTextTarget!.id).toBe("text-12");
    expect(ctx.activeTextTarget!.type).toBe("text");
    expect(ctx.nodeMap.has("text-12")).toBe(true);
    expect(ctx.nodeMap.get("12")).toBe(ctx.activeTextTarget);
    expect(root.children).toContain(ctx.activeTextTarget);
  });

  it("thinking과 text는 형제 노드 (root.children에 둘 다 평면)", () => {
    const { ctx, root } = makeCtxWithRoot();
    const thinkingNode = makeNode("thinking-1", "thinking", "inner thoughts", {
      completed: true,
    });
    registerNode(ctx, thinkingNode);
    root.children.push(thinkingNode);

    const event: TextStartEvent = { type: "text_start", timestamp: 0 };
    const changed = handleTextStart(event, 10, ctx, root);

    expect(changed).toBe(true);
    expect(ctx.activeTextTarget!.id).toBe("text-10");
    // 둘 다 root.children에 있음 (트리 부모-자식 없음)
    expect(root.children).toContain(thinkingNode);
    expect(root.children).toContain(ctx.activeTextTarget);
    expect(root.children).toHaveLength(2);
  });

  it("parent_event_id가 있어도 root.children에 push (parent 매칭 무시)", () => {
    const { ctx, root } = makeCtxWithRoot();
    const parentNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
    registerNode(ctx, parentNode);
    ctx.nodeMap.set("100", parentNode);
    root.children.push(parentNode);

    const event: TextStartEvent = { type: "text_start", timestamp: 0, parent_event_id: "100" };
    handleTextStart(event, 13, ctx, root);

    // parent.children에 들어가지 *않음*
    expect(parentNode.children).toHaveLength(0);
    expect(root.children).toContain(ctx.activeTextTarget);
  });

  it("같은 eventId 재진입 시 false 반환 + activeTextTarget 변경 없음", () => {
    const { ctx, root } = makeCtxWithRoot();
    const event: TextStartEvent = { type: "text_start", timestamp: 0 };

    const first = handleTextStart(event, 30, ctx, root);
    const firstTarget = ctx.activeTextTarget;
    const second = handleTextStart(event, 30, ctx, root);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(ctx.activeTextTarget).toBe(firstTarget); // 변경 없음
    expect(root.children).toHaveLength(1); // 두 번째 push 없음
  });
});

// === handleTextStart diag 대칭화 (260508.05 H-2) ===
//
// placeInTree 정상 경로(:145)에는 `→ insert` diag 가 있으나 handleTextStart
// 정상 경로엔 없던 비대칭을 해소. placeInTree 와 동일 키 셋
// ({ eventId, nodeType, nodeId }) 으로 grep 친화적 일관성을 유지한다.

describe("handleTextStart diag 대칭화 (H-2)", () => {
  beforeEach(() => {
    vi.mocked(diag).mockClear();
  });

  it("정상 경로에서 → insert diag 발행 (placeInTree 와 동일 키 셋)", () => {
    const { ctx, root } = makeCtxWithRoot();
    const event: TextStartEvent = { type: "text_start", timestamp: 0 };

    handleTextStart(event, 12, ctx, root);

    expect(diag).toHaveBeenCalledWith(
      "tree-placer",
      "→ insert",
      { eventId: 12, nodeType: "text", nodeId: "text-12" },
    );
  });

  it("skip 경로에서는 → insert diag 미발행", () => {
    const { ctx, root } = makeCtxWithRoot();
    const event: TextStartEvent = { type: "text_start", timestamp: 0 };

    handleTextStart(event, 30, ctx, root); // 1차 — insert
    vi.mocked(diag).mockClear();
    handleTextStart(event, 30, ctx, root); // 2차 — skip 가드

    const insertCalls = vi.mocked(diag).mock.calls.filter(
      (c) => c[1] === "→ insert",
    );
    expect(insertCalls).toHaveLength(0);
  });
});

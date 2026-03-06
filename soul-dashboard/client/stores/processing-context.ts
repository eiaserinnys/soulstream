/**
 * ProcessingContext — processEvent의 공유 상태를 명시적 컨텍스트로 묶는다.
 *
 * Phase 6: toolUseMap 삭제 완료. tool_use_id → 노드 매핑은 nodeMap에 통합.
 */

import type { EventTreeNode } from "@shared/types";

// === ProcessingContext ===

export interface ProcessingContext {
  /** ID → 노드 (O(1) 탐색). node.id와 tool_use_id 양쪽으로 등록. */
  nodeMap: Map<string, EventTreeNode>;
  /** parent_event_id별 가장 최근 thinking 노드 (text_start와 매칭용) */
  lastThinkingByParent: Map<string, EventTreeNode>;
  /** 현재 text_start → text_delta → text_end 시퀀스의 대상 노드 */
  activeTextTarget: EventTreeNode | null;
  /** 현재 활성 user_message/intervention 노드 ID */
  currentTurnNodeId: string | null;
}

export function createProcessingContext(): ProcessingContext {
  return {
    nodeMap: new Map(),
    lastThinkingByParent: new Map(),
    activeTextTarget: null,
    currentTurnNodeId: null,
  };
}

// === Tree Node Helpers ===

/** 순수 노드 생성 — Map 등록 없음 */
export function makeNode(
  id: string,
  type: EventTreeNode["type"],
  content: string,
  extra?: Partial<EventTreeNode>,
): EventTreeNode {
  return {
    id,
    type,
    children: [],
    content,
    completed: false,
    ...extra,
  };
}

/** 노드를 nodeMap에 등록 */
export function registerNode(ctx: ProcessingContext, node: EventTreeNode): void {
  ctx.nodeMap.set(node.id, node);
}

/** 루트 노드가 없으면 생성하여 nodeMap에 등록 */
export function ensureRoot(
  tree: EventTreeNode | null,
  ctx: ProcessingContext,
): EventTreeNode {
  if (tree) return tree;
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return root;
}
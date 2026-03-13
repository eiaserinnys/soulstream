/**
 * ProcessingContext — processEvent의 공유 상태를 명시적 컨텍스트로 묶는다.
 *
 * Phase 6: toolUseMap 삭제 완료. tool_use_id → 노드 매핑은 nodeMap에 통합.
 * Phase 7: thinking/text 분리. lastThinkingByParent 삭제, TextTargetNode → TextNode.
 */

import type { EventTreeNode, EventTreeNodeType, TextNode } from "@shared/types";

// === ProcessingContext ===

/** text_delta/text_end 대상 노드 타입 */
export type TextTargetNode = TextNode;

export interface ProcessingContext {
  /** ID → 노드 (O(1) 탐색). node.id, _event_id(String), tool_use_id로 등록. */
  nodeMap: Map<string, EventTreeNode>;
  /** 현재 text_start → text_delta → text_end 시퀀스의 대상 노드 */
  activeTextTarget: TextTargetNode | null;
  /** history_sync 수신 여부. false인 동안은 히스토리 리플레이 중이므로 세션 상태 갱신을 억제. */
  historySynced: boolean;
}

export function createProcessingContext(): ProcessingContext {
  return {
    nodeMap: new Map(),
    activeTextTarget: null,
    historySynced: false,
  };
}

// === Tree Node Helpers ===

/**
 * 순수 노드 생성 — Map 등록 없음.
 *
 * extra는 base 필드를 부분적으로 오버라이드하며,
 * 타입별 전용 필드도 포함할 수 있습니다.
 * 반환 타입은 EventTreeNode (union)입니다.
 */
export function makeNode(
  id: string,
  type: EventTreeNodeType,
  content: string,
  extra?: Record<string, unknown>,
): EventTreeNode {
  return {
    id,
    type,
    children: [],
    content,
    completed: false,
    ...extra,
  } as EventTreeNode;
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

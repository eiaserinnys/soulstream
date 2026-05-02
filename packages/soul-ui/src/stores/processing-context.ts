/**
 * ProcessingContext — processEvent의 공유 상태를 명시적 컨텍스트로 묶는다.
 *
 * Phase 6: toolUseMap 삭제 완료. tool_use_id → 노드 매핑은 nodeMap에 통합.
 * Phase 7: thinking/text 분리. lastThinkingByParent 삭제, TextTargetNode → TextNode.
 */

import type { EventTreeNode, EventTreeNodeType, TextNode } from "@shared/types";

// === Tree Change Info ===

/** 트리 변경 유형 — NodeGraph가 전체 재빌드 vs 증분 업데이트를 분기하는 기준 */
export type TreeChangeType = 'node-added' | 'node-updated' | 'collapse-toggle' | 'full-rebuild';

export interface TreeChangeInfo {
  type: TreeChangeType;
  /** node-added, node-updated 시 대상 노드 ID */
  nodeId?: string;
}

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
  /**
   * 히스토리 prepend 모드. true이면 부모 부재 자식 이벤트를 orphans 큐에 보관하고,
   * 부모가 도착할 때 자동으로 attach한다. 라이브 SSE는 false로 유지하여
   * 기존 root fallback(tree-placer.ts:resolveParent) 동작을 보존한다.
   *
   * processHistoryEvents 액션이 try/finally로 토글한다 (slices/session-slice.ts).
   */
  historyMode: boolean;
  /**
   * 부모 부재 자식 노드 큐. 키는 parent_event_id (String).
   * placeInTree/handleTextStart에서 새 노드 등록 시 자식 후보들을 조회·attach 후 키 삭제.
   * historyMode=true일 때만 이 큐에 보관된다.
   */
  orphans: Map<string, EventTreeNode[]>;
}

export function createProcessingContext(): ProcessingContext {
  return {
    nodeMap: new Map(),
    activeTextTarget: null,
    historySynced: false,
    historyMode: false,
    orphans: new Map(),
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

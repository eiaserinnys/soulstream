/**
 * Tree Placer — 노드를 트리에 배치하고 Map에 등록
 *
 * placeInTree: 생성된 노드를 parent_event_id 기반으로 트리에 삽입
 * resolveParent: parent_event_id로 부모 노드를 결정
 *
 * Phase 8: 순수 parent_event_id 기반. 타입별 분기와 currentTurnNodeId 폴백 제거.
 */

import type {
  EventTreeNode,
  SoulSSEEvent,
  TextStartEvent,
  ToolStartEvent,
} from "@shared/types";
import type { ProcessingContext, TextTargetNode } from "./processing-context";
import { makeNode, registerNode } from "./processing-context";

/**
 * parent_event_id로 부모 노드를 결정합니다.
 * - null/undefined → session root
 * - 값 있음 → nodeMap에서 직접 조회
 */
export function resolveParent(
  parentEventId: string | null | undefined,
  ctx: ProcessingContext,
  root: EventTreeNode,
): EventTreeNode {
  if (!parentEventId) return root;

  const parent = ctx.nodeMap.get(parentEventId);
  if (!parent) {
    console.warn(`[tree] parent "${parentEventId}" not in nodeMap`);
    return root;
  }
  return parent;
}

/**
 * 생성된 노드를 트리에 배치하고 필요한 Map에 등록합니다.
 *
 * 모든 이벤트 타입에 동일한 로직을 적용합니다:
 * 1. registerNode(ctx, node) — node.id로 내부 등록
 * 2. String(eventId)로 nodeMap 추가 등록 — parent_event_id 조회용
 * 3. tool_start의 경우 tool_use_id로도 추가 등록 — 서브에이전트 parent 조회용
 * 4. resolveParent로 부모 결정 후 parent.children에 추가
 */
export function placeInTree(
  node: EventTreeNode,
  event: SoulSSEEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): void {
  // nodeMap 등록 (모든 노드 공통)
  registerNode(ctx, node);

  // _event_id로 추가 등록 (parent_event_id 조회용)
  ctx.nodeMap.set(String(eventId), node);

  // tool_start: tool_use_id로도 등록 (서브에이전트 parent 조회용)
  if (event.type === "tool_start" && (event as ToolStartEvent).tool_use_id) {
    ctx.nodeMap.set((event as ToolStartEvent).tool_use_id!, node);
  }

  // 모든 타입 동일: resolveParent로 부모 결정
  const parentEventId = "parent_event_id" in event
    ? (event as { parent_event_id?: string }).parent_event_id ?? null
    : null;
  const parent = resolveParent(parentEventId, ctx, root);
  parent.children.push(node);
}

/**
 * text_start 이벤트를 처리합니다.
 *
 * 항상 독립 TextNode를 생성하여 트리에 배치합니다.
 * thinking과 text는 독립적인 형제 노드입니다.
 */
export function handleTextStart(
  event: TextStartEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): boolean {
  const textParent = resolveParent(event.parent_event_id, ctx, root);
  const textNode = makeNode(`text-${eventId}`, "text", "");
  registerNode(ctx, textNode);
  ctx.nodeMap.set(String(eventId), textNode);
  textParent.children.push(textNode);
  ctx.activeTextTarget = textNode as TextTargetNode;
  return true;
}

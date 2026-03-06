/**
 * Tree Placer — 노드를 트리에 배치하고 Map에 등록
 *
 * placeInTree: 생성된 노드를 이벤트 필드 기반으로 트리에 삽입
 * resolveParent: parent_event_id로 부모 노드를 결정
 *
 * Phase 6: toolUseMap 삭제, nodeMap 통합. resolveParent 간소화.
 */

import type {
  EventTreeNode,
  SoulSSEEvent,
  TextStartEvent,
  ThinkingEvent,
  ToolStartEvent,
  ResultEvent,
} from "@shared/types";
import type { ProcessingContext, TextTargetNode } from "./processing-context";
import { makeNode, registerNode } from "./processing-context";

/**
 * parent_event_id로 부모 노드를 결정합니다.
 * - null/undefined → 현재 턴 루트 (없으면 session root)
 * - 값 있음 → nodeMap에서 직접 조회
 */
export function resolveParent(
  parentEventId: string | null | undefined,
  ctx: ProcessingContext,
  root: EventTreeNode,
): EventTreeNode {
  if (!parentEventId) {
    if (ctx.currentTurnNodeId) {
      const turn = ctx.nodeMap.get(ctx.currentTurnNodeId);
      if (turn) return turn;
    }
    return root;
  }

  return ctx.nodeMap.get(parentEventId) ?? root;
}

/**
 * 생성된 노드를 트리에 배치하고 필요한 Map에 등록합니다.
 *
 * 이벤트 타입별 분기를 최소화하되, 현재 코드의 행위를 100% 보존합니다.
 * - 턴 루트(user_message, intervention): root.children에 추가, currentTurnNodeId 갱신
 * - thinking: resolveParent로 부모 결정, lastThinkingByParent 등록
 * - tool_start: resolveParent로 부모 결정, nodeMap에 tool_use_id 등록
 * - compact/complete/error: 턴 루트 또는 root에 추가
 * - result: resolveParent로 부모 결정
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

  switch (event.type) {
    case "user_message":
    case "intervention_sent": {
      // 턴 루트: session root의 직접 자식
      root.children.push(node);
      ctx.currentTurnNodeId = node.id;
      break;
    }

    case "thinking": {
      const e = event as ThinkingEvent;
      const parent = resolveParent(e.parent_event_id, ctx, root);
      // 같은 parent 레벨의 후속 text_start와 매칭하기 위해 등록
      // "" = root 레벨 (서브에이전트 밖), 그 외 = 해당 서브에이전트의 parent_event_id
      const parentKey = e.parent_event_id || "";
      ctx.lastThinkingByParent.set(parentKey, node);
      parent.children.push(node);
      break;
    }

    case "tool_start": {
      const e = event as ToolStartEvent;
      // tool_use_id를 nodeMap에 등록 (tool_result 매칭 + resolveParent용)
      if (e.tool_use_id) {
        ctx.nodeMap.set(e.tool_use_id, node);
      }
      const parent = resolveParent(e.parent_event_id, ctx, root);
      parent.children.push(node);
      break;
    }

    case "compact":
    case "complete":
    case "error": {
      const turnNode = ctx.currentTurnNodeId ? ctx.nodeMap.get(ctx.currentTurnNodeId) : null;
      if (turnNode) {
        turnNode.children.push(node);
      } else {
        root.children.push(node);
      }
      break;
    }

    case "result": {
      const e = event as ResultEvent;
      const parent = resolveParent(e.parent_event_id, ctx, root);
      parent.children.push(node);
      break;
    }

    default: {
      // 예상 외의 생성 이벤트 — 턴 루트 또는 root에 배치
      const turnNode = ctx.currentTurnNodeId ? ctx.nodeMap.get(ctx.currentTurnNodeId) : null;
      (turnNode ?? root).children.push(node);
      break;
    }
  }
}

/**
 * text_start 이벤트를 처리합니다.
 *
 * - thinking 매칭: 같은 parent 레벨에 thinking 노드가 존재하면 텍스트를 thinking에 병합
 * - 독립 text 노드: thinking 없이 text만 온 경우 독립 text 노드를 생성하여 트리에 배치
 *
 * node-factory의 applyUpdate와 분리된 이유:
 * text_start는 조건에 따라 노드 생성 + 트리 삽입을 수행하므로
 * tree-placer의 책임에 해당합니다.
 */
export function handleTextStart(
  event: TextStartEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): boolean {
  const parentKey = event.parent_event_id || "";
  const thinkingNode = ctx.lastThinkingByParent.get(parentKey);

  if (thinkingNode) {
    // 같은 parent 레벨에 thinking 노드 존재 → 텍스트를 thinking에 병합
    ctx.lastThinkingByParent.delete(parentKey); // 1:1 매칭 후 해제
    ctx.activeTextTarget = thinkingNode as TextTargetNode;
  } else {
    // thinking 없이 text만 온 경우 → 독립 text 노드 생성
    const textParent = resolveParent(event.parent_event_id, ctx, root);
    const textNode = makeNode(`text-${eventId}`, "text", "");
    registerNode(ctx, textNode);
    textParent.children.push(textNode);
    ctx.activeTextTarget = textNode as TextTargetNode;
  }
  return true;
}

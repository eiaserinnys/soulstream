/**
 * Tree Placer — 노드를 트리에 배치하고 Map에 등록
 *
 * placeInTree: 생성된 노드를 이벤트 필드 기반으로 트리에 삽입
 * resolveParent: parent_event_id로 부모 노드를 결정
 *
 * Phase 7: thinking/text 분리. lastThinkingByParent 삭제.
 *   thinking과 text는 독립 형제 노드로 트리에 배치된다.
 */

import type {
  EventTreeNode,
  SoulSSEEvent,
  TextStartEvent,
  ThinkingEvent,
  ToolStartEvent,
  ResultEvent,
  InputRequestEvent,
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
 * - 턴 루트(user_message, intervention): root.children에 추가, currentTurnNodeId 갱신
 * - thinking: resolveParent로 부모 결정
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

    case "input_request": {
      const e = event as InputRequestEvent;
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
  textParent.children.push(textNode);
  ctx.activeTextTarget = textNode as TextTargetNode;
  return true;
}

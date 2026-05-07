/**
 * Tree Placer — 노드를 root.children에 시간순 평면 push하고 필요한 키를 nodeMap에 등록
 *
 * Phase 2-A 평탄화 (atom 작업 이력 260507.01.fe-tree-flattening, §11.1 옵션 C):
 *   parent_event_id를 무시하고 모든 노드를 root.children에 push한다. orphan 큐, sorted insert,
 *   adoptees, historyMode 분기, ORPHAN_PARENT sentinel은 모두 폐기되었다.
 *
 *   ChatView가 root.children을 그대로 시간순 표시하며, result/complete 정렬 보정은
 *   flatten-tree.ts:199-210의 UX 정책으로 root.children에서만 동작한다 (§11.2 유지 결정).
 *
 *   tool_use_id·request_id 보조 등록은 유지된다 — tool_result / input_request_expired
 *   이벤트가 같은 ID로 부모 노드를 lookup하기 때문이다 (applyUpdate 호출 경로).
 */

import type {
  EventTreeNode,
  SoulSSEEvent,
  TextStartEvent,
  ToolStartEvent,
  InputRequestEvent,
} from "@shared/types";
import type { ProcessingContext, TextTargetNode } from "./processing-context";
import { makeNode, registerNode } from "./processing-context";
import { diag } from "../lib/diag";

/**
 * 생성된 노드를 root.children에 평면 push하고 nodeMap·tool_use_id·request_id 보조 키를 등록한다.
 *
 * 동작 순서:
 *   1. 같은 배치 내 ancestor 동봉으로 인한 재진입 → nodeMap.has 가드로 skip (silent return)
 *   2. registerNode(ctx, node) — node.id로 nodeMap 등록
 *   3. String(eventId)로 nodeMap 추가 등록 — applyUpdate가 _event_id로 노드 lookup 시 사용
 *   4. tool_start: tool_use_id로도 등록 — tool_result 매칭 (applyUpdate가 사용)
 *   5. input_request: request_id로도 등록 — input_request_expired 매칭
 *   6. root.children.push(node) — parent_event_id 무시, 시간순 평면
 *
 * 시그니처는 평탄화 전과 동일하게 유지하여 호출자(event-processor)는 무변경.
 */
export function placeInTree(
  node: EventTreeNode,
  event: SoulSSEEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): void {
  // ancestor 동봉으로 같은 배치 내 중복 진입 차단 (event-processor dedup은 배치 간 중복만 차단).
  if (ctx.nodeMap.has(String(eventId))) {
    diag("tree-placer", "→ skip (already in nodeMap)", { eventId, nodeId: node.id });
    return;
  }

  registerNode(ctx, node);
  ctx.nodeMap.set(String(eventId), node);

  // tool_start: tool_use_id로도 등록 (tool_result 매칭에 필수)
  if (event.type === "tool_start" && (event as ToolStartEvent).tool_use_id) {
    ctx.nodeMap.set((event as ToolStartEvent).tool_use_id!, node);
  }

  // input_request: request_id로도 등록 (input_request_expired 매칭에 필수)
  if (event.type === "input_request" && (event as InputRequestEvent).request_id) {
    ctx.nodeMap.set((event as InputRequestEvent).request_id, node);
  }

  // 평탄화: parent_event_id 무시, root.children에 시간순 push.
  // 라이브 SSE는 시간순 도착이 보장되고, history mode prepend는 messages API가 ASC 페이지를
  // 반환하므로 push 순서가 자연 시간순이 된다.
  root.children.push(node);
  diag("tree-placer", "→ push", {
    eventId,
    nodeType: node.type,
    nodeId: node.id,
  });
}

/**
 * text_start 이벤트 — 독립 TextNode를 root.children에 push하고 activeTextTarget을 설정한다.
 * 후속 text_delta·text_end는 activeTextTarget을 통해 같은 TextNode에 누적된다.
 */
export function handleTextStart(
  event: TextStartEvent,
  eventId: number,
  ctx: ProcessingContext,
  root: EventTreeNode,
): boolean {
  // ancestor 동봉으로 이미 처리된 text 노드의 재진입 방지 — silent skip.
  // 호출자(event-processor)에 false를 반환하여 activeTextTarget 변경을 막는다.
  if (ctx.nodeMap.has(String(eventId))) {
    diag("tree-placer", "→ skip text (already in nodeMap)", { eventId });
    return false;
  }
  const textNode = makeNode(`text-${eventId}`, "text", "");
  registerNode(ctx, textNode);
  ctx.nodeMap.set(String(eventId), textNode);
  root.children.push(textNode);

  ctx.activeTextTarget = textNode as TextTargetNode;
  return true;
}

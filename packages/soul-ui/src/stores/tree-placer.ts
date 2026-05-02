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
  InputRequestEvent,
} from "@shared/types";
import type { ProcessingContext, TextTargetNode } from "./processing-context";
import { makeNode, registerNode } from "./processing-context";

/**
 * Sentinel — `resolveParent`가 historyMode 환경에서 부모를 찾지 못했을 때 반환한다.
 *
 * 호출자(`placeInTree`, `handleTextStart`)는 이 sentinel과 reference 비교(`=== ORPHAN_PARENT`)로
 * 부모 부재를 감지하여 자식 노드를 `ctx.orphans`에 보관해야 한다.
 *
 * 라이브 SSE에서는 부모가 항상 자식 이전에 도착하므로 이 sentinel을 반환하지 않는다 —
 * 기존 root fallback 동작이 유지된다.
 */
export const ORPHAN_PARENT: EventTreeNode = {
  id: "__orphan__",
  type: "session",
  children: [],
  content: "",
  completed: false,
} as EventTreeNode;

/**
 * parent_event_id로 부모 노드를 결정합니다.
 * - null/undefined → session root
 * - 값 있음 → nodeMap에서 직접 조회
 * - 부모 부재 + historyMode=true → ORPHAN_PARENT sentinel (호출자가 orphans 큐로 분기)
 * - 부모 부재 + historyMode=false → 기존 동작 (root fallback + console.warn)
 */
export function resolveParent(
  parentEventId: string | null | undefined,
  ctx: ProcessingContext,
  root: EventTreeNode,
): EventTreeNode {
  if (!parentEventId) return root;

  const parent = ctx.nodeMap.get(parentEventId);
  if (!parent) {
    if (ctx.historyMode) {
      // history mode: 호출자가 sentinel 감지 후 orphan 큐에 보관한다
      return ORPHAN_PARENT;
    }
    console.warn(`[tree] parent "${parentEventId}" not in nodeMap`);
    return root;
  }
  return parent;
}

/**
 * 노드를 부모에 attach하고 자신의 adoptees를 함께 처리한다.
 *
 * - parent === ORPHAN_PARENT (history mode + 부모 부재) → ctx.orphans 큐에 보관
 * - 그 외 → parent.children.push(node) (정상 attach)
 * - 두 경우 모두 본 노드가 다른 orphan들의 부모일 수 있으므로 adoptees 조회·attach.
 *
 * 다층 체인 자동 처리: A→B→C에서 B가 orphan map에 들어가도 nodeMap에는 등록되어 있어
 * 후속 자식 A가 resolveParent로 B를 정상 lookup → B.children.push(A). C 도착 시
 * C.children.push(B)로 B(A 포함)가 통째로 이동.
 */
function attachToParent(
  node: EventTreeNode,
  parent: EventTreeNode,
  parentEventId: string | null,
  eventId: number,
  ctx: ProcessingContext,
): void {
  if (parent === ORPHAN_PARENT) {
    // history mode + 부모 부재 → orphan 큐에 보관
    // (parentEventId는 sentinel 진입 조건에서 truthy 보장)
    const list = ctx.orphans.get(parentEventId!) ?? [];
    list.push(node);
    ctx.orphans.set(parentEventId!, list);
  } else {
    parent.children.push(node);
  }

  // 새 노드가 다른 orphan들의 부모일 수 있음 — 자식 후보 attach
  const adoptees = ctx.orphans.get(String(eventId));
  if (adoptees && adoptees.length > 0) {
    for (const child of adoptees) {
      node.children.push(child);
    }
    ctx.orphans.delete(String(eventId));
  }
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

  // input_request: request_id로도 등록 (input_request_expired 조회용)
  if (event.type === "input_request" && (event as InputRequestEvent).request_id) {
    ctx.nodeMap.set((event as InputRequestEvent).request_id, node);
  }

  // 모든 타입 동일: resolveParent로 부모 결정 후 attach
  const parentEventId = "parent_event_id" in event
    ? (event as { parent_event_id?: string }).parent_event_id ?? null
    : null;
  const parent = resolveParent(parentEventId, ctx, root);
  attachToParent(node, parent, parentEventId, eventId, ctx);
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
  attachToParent(textNode, textParent, event.parent_event_id ?? null, eventId, ctx);

  ctx.activeTextTarget = textNode as TextTargetNode;
  return true;
}

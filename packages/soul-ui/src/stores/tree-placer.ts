/**
 * Tree Placer — 노드를 root.children에 시간순으로 삽입하고 필요한 키를 nodeMap에 등록
 *
 * Phase 2-A 평탄화 (atom 작업 이력 260507.01.fe-tree-flattening, §11.1 옵션 C):
 *   parent_event_id를 무시하고 모든 노드를 root.children에 삽입한다. orphan 큐,
 *   adoptees, historyMode 분기, ORPHAN_PARENT sentinel은 모두 폐기되었다.
 *
 *   ChatView가 root.children을 그대로 시간순 표시하며, result/complete 정렬 보정은
 *   flatten-tree.ts:199-210의 UX 정책으로 root.children에서만 동작한다 (§11.2 유지 결정).
 *
 *   tool_use_id·request_id 보조 등록은 유지된다 — tool_result / input_request_expired
 *   이벤트가 같은 ID로 부모 노드를 lookup하기 때문이다 (applyUpdate 호출 경로).
 *
 * Cross-page 정렬 보존 (atom 작업 이력 260508.03.soul-ui-prepend-cross-page-order):
 *   placeInTree / handleTextStart 는 root.children 을 eventId ASC 로 유지한다.
 *   라이브 SSE 의 시간순 도착은 fast-path push 로 처리되고 (마지막 자식의 eventId
 *   비교 1회), history prepend 는 binary search → splice 로 시간순 위치에 삽입된다.
 *   nodeMap.has(String(eventId)) 가드(L70/L150)가 같은 eventId 중복 진입을 차단하므로
 *   splice 시점 children 에 같은 eventId 가 없다 — tie-breaking 안전.
 *
 *   순수한 push-only 가정은 단일 페이지에서만 옳았으나, cross-page (라이브 → prepend)
 *   에선 더 작은 eventId가 더 큰 eventId 뒤에 쌓여 array order 가 어긋났다 (Phase 2-A
 *   회귀, commit 1722be5). 본 fix 는 sorted insert 메커니즘을 부활시키되 라이브 SSE
 *   fast-path push 로 push-only 비용을 보존한다 (단일 정본·단일 경로).
 */

import type {
  EventTreeNode,
  SoulSSEEvent,
  TextStartEvent,
  ToolStartEvent,
  InputRequestEvent,
  ToolApprovalRequestedEvent,
} from "@shared/types";
import type { ProcessingContext, TextTargetNode } from "./processing-context";
import { makeNode, registerNode } from "./processing-context";
import { diag } from "../lib/diag";
import { extractEventId } from "../lib/flatten-tree";

/**
 * insertNodeInOrder 의 caller-local adapter.
 *
 * 비정형 nodeId 를 -Infinity 로 변환하여 어떤 양수 eventId 보다도 작게 취급한다.
 * 즉 fast-path push 로 흘려보낸다 — children 에 비정형 노드가 invariant 상 없으므로
 * dead branch 지만 안전한 폴백 의미를 코드로 표현한다.
 *
 * 정규식·추출 로직의 정본은 lib/flatten-tree.ts 의 extractEventId
 * (260508.05.tree-placer-hygiene H-1: design-principles §3 정본 하나).
 */
function extractNodeEventId(node: EventTreeNode): number {
  return extractEventId(node.id) ?? Number.NEGATIVE_INFINITY;
}

/**
 * 새 노드를 root.children 의 시간순(eventId ASC) 위치에 삽입한다.
 *
 * Fast-path (라이브 SSE 의 일반 케이스):
 *   eventId 가 마지막 자식의 eventId 보다 크면 push.
 *   event-processor 의 dedup 가드(eventId > 0 && eventId <= lastEventId)가 lastEventId
 *   이하 이벤트를 차단하므로 도달 시점의 eventId 는 store.lastEventId 보다 큼.
 *   binary search 비용 0 으로 push 만 수행.
 *
 * Slow-path (cross-page prepend):
 *   processHistoryEvents 의 skipDedup=true 경로가 store.lastEventId 이하 과거 이벤트를
 *   의도적으로 처리한다. children 의 마지막 자식보다 작은 eventId 가 도달하면 binary
 *   search 로 첫 번째 큰 eventId 위치를 찾아 splice. 같은 배치 내 같은 eventId 중복은
 *   placeInTree:70 / handleTextStart:150 의 nodeMap.has 가드가 진입 전 차단하므로
 *   splice 시점 children 에 같은 eventId 가 없다 — tie-breaking 분기 불필요.
 */
function insertNodeInOrder(
  root: EventTreeNode,
  node: EventTreeNode,
  eventId: number,
): void {
  const children = root.children;
  const len = children.length;
  if (len === 0) {
    children.push(node);
    return;
  }
  const lastEventId = extractNodeEventId(children[len - 1]);
  if (eventId > lastEventId) {
    // Fast-path: 라이브 SSE 의 일반 시간순 도착.
    children.push(node);
    return;
  }
  // Slow-path: cross-page prepend. 첫 번째 `extractNodeEventId(child) > eventId` 위치를 찾는다.
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (extractNodeEventId(children[mid]) <= eventId) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  children.splice(lo, 0, node);
}

/**
 * 생성된 노드를 root.children에 시간순 삽입하고 nodeMap·tool_use_id·request_id 보조 키를 등록한다.
 *
 * 동작 순서:
 *   1. 같은 배치 내 ancestor 동봉으로 인한 재진입 → nodeMap.has 가드로 skip (silent return)
 *   2. registerNode(ctx, node) — node.id로 nodeMap 등록
 *   3. String(eventId)로 nodeMap 추가 등록 — applyUpdate가 _event_id로 노드 lookup 시 사용
 *   4. tool_start: tool_use_id로도 등록 — tool_result 매칭 (applyUpdate가 사용)
 *   5. input_request: request_id로도 등록 — input_request_expired 매칭
 *   6. insertNodeInOrder(root, node, eventId) — eventId ASC 위치에 삽입 (fast-path push 또는 splice)
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

  // tool_approval_requested: approval_id로도 등록 (tool_approval_resolved 매칭)
  if (
    event.type === "tool_approval_requested" &&
    (event as ToolApprovalRequestedEvent).approval_id
  ) {
    ctx.nodeMap.set((event as ToolApprovalRequestedEvent).approval_id, node);
  }

  // 평탄화 + cross-page 시간순 보존: eventId 기준 sorted insert.
  // 라이브 SSE 는 마지막 자식보다 큰 eventId 라 fast-path push.
  // history prepend 는 라이브로 큰 eventId 가 먼저 들어간 뒤 작은 eventId 가 도착하므로
  // binary search → splice 로 시간순 위치에 삽입.
  insertNodeInOrder(root, node, eventId);
  diag("tree-placer", "→ insert", {
    eventId,
    nodeType: node.type,
    nodeId: node.id,
  });
}

/**
 * text_start 이벤트 — 독립 TextNode를 root.children에 시간순 삽입하고 activeTextTarget을 설정한다.
 * 후속 text_delta·text_end는 activeTextTarget을 통해 같은 TextNode에 누적된다.
 *
 * placeInTree와 동일한 sorted insert 패턴을 사용하여 cross-page text_start 도 시간순 보존.
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
  insertNodeInOrder(root, textNode, eventId);
  diag("tree-placer", "→ insert", {
    eventId,
    nodeType: "text",
    nodeId: textNode.id,
  });

  ctx.activeTextTarget = textNode as TextTargetNode;
  return true;
}

import type { EventTreeNode } from "@shared/types";

/**
 * 트리 노드 ID (`{type-prefix}-{eventId}` 패턴) 에서 DB 이벤트 ID를 추출한다.
 *
 * 매칭 실패 시 undefined를 반환하며, 호출자가 자기 정렬 정책에 맞게 처리한다.
 */
export function extractEventId(nodeId: string): number | undefined {
  const match = nodeId.match(/-(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

/**
 * node.id가 durable event ID를 담지 않는 이벤트까지 포함해 ID를 조회한다.
 *
 * session_notification의 delivery ID와 durable final로 승격된 transient text처럼
 * node.id가 DB ID를 담지 않는 경우 별도 eventId 필드를 사용한다.
 */
export function extractNodeEventId(
  node: EventTreeNode,
): number | undefined {
  if (node.type === "session_notification") {
    return node.eventId;
  }
  if (node.type === "text") return node.eventId;
  return extractEventId(node.id);
}

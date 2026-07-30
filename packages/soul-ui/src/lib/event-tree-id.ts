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
 * session_notification의 node.id는 exactly-once delivery_id가 정본이므로,
 * 별도 필드에 보존한 DB 이벤트 ID를 사용한다.
 */
export function extractNodeEventId(
  node: EventTreeNode,
): number | undefined {
  if (node.type === "session_notification") {
    return node.eventId;
  }
  return extractEventId(node.id);
}

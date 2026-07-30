import type { EventTreeNode, TurnSummaryNode } from "@shared/types";
import { extractNodeEventId } from "./event-tree-id";

function isTurnStartNode(node: EventTreeNode): boolean {
  return (
    node.type === "user_message" ||
    node.type === "intervention" ||
    node.type === "session_notification"
  );
}

/**
 * turn_summary의 durable event ID는 비동기 생성 시점 때문에 다음 턴보다 클 수 있다.
 * 저장 트리의 event ID 정렬은 유지하고, 화면 투영에서만 해당 턴 뒤로 옮긴다.
 *
 * final response 이후 처음 나타나는 턴 시작 직전에 캡션을 두면 complete·usage 같은
 * 같은 턴의 후행 행은 캡션 앞에 남는다. 다음 턴이 아직 없으면 현재 끝에 둔다.
 * 이 투영은 live 지연 도착과 history pagination 모두 같은 경로로 처리한다.
 */
export function placeTurnSummariesAtTurnBoundaries(
  children: EventTreeNode[],
): EventTreeNode[] {
  const summaries = children
    .filter((child): child is TurnSummaryNode => child.type === "turn_summary")
    .sort((a, b) => {
      if (a.finalResponseEventId !== b.finalResponseEventId) {
        return a.finalResponseEventId - b.finalResponseEventId;
      }
      return (extractNodeEventId(a) ?? 0) - (extractNodeEventId(b) ?? 0);
    });
  if (summaries.length === 0) return children;

  const timeline = children.filter((child) => child.type !== "turn_summary");
  const ordered: EventTreeNode[] = [];
  let summaryIndex = 0;

  for (const child of timeline) {
    const eventId = extractNodeEventId(child);
    if (isTurnStartNode(child) && eventId !== undefined) {
      while (
        summaryIndex < summaries.length &&
        summaries[summaryIndex].finalResponseEventId < eventId
      ) {
        ordered.push(summaries[summaryIndex]);
        summaryIndex++;
      }
    }
    ordered.push(child);
  }

  while (summaryIndex < summaries.length) {
    ordered.push(summaries[summaryIndex]);
    summaryIndex++;
  }
  return ordered;
}

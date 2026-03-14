/**
 * Child Processor — 트리 노드의 자식들을 순회하여 렌더러에 위임
 *
 * 부모의 그래프 노드 ID를 받아 트리 구조 그대로 엣지를 생성합니다:
 * - 부모 → 첫째 자식 (수직 엣지)
 * - 형제 → 형제 (수직 엣지)
 * - tool 노드는 수직 체인에서 제외 (tool-renderer가 수평 엣지를 자체 생성)
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import { createEdge } from "../layout-engine";
import { dispatchRenderer } from "./index";

/**
 * 트리 노드의 자식들을 처리하고 수직 엣지를 생성합니다.
 *
 * 엣지 생성 책임:
 * - 수직 엣지 (부모→자식, 형제→형제): 여기서 담당
 * - 수평 엣지 (부모→tool): tool-renderer가 담당
 */
export function processChildNodes(
  parentTurnNode: EventTreeNode,
  parentGraphNodeId: string | null,
  ctx: LayoutContext,
): void {
  let prevSiblingId: string | null = null;
  for (const child of parentTurnNode.children) {
    const nodeId = dispatchRenderer(child, parentGraphNodeId, ctx);
    // tool은 자체적으로 수평 엣지를 생성하므로 수직 체인에 포함하지 않음
    if (nodeId && child.type !== "tool") {
      if (prevSiblingId) {
        // 형제 → 형제 (수직, sibling 마킹)
        const edge = createEdge(prevSiblingId, nodeId);
        edge.data = { sibling: true };
        ctx.edges.push(edge);
      } else if (parentGraphNodeId) {
        // 부모 → 첫째 자식 (수직)
        ctx.edges.push(createEdge(parentGraphNodeId, nodeId));
      }
      prevSiblingId = nodeId;
    }
  }
}

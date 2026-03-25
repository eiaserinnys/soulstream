/**
 * Child Processor — 트리 노드의 자식들을 순회하여 렌더러에 위임
 *
 * 모든 자식 노드에 수평 엣지(right→left)를 생성합니다.
 * 같은 부모의 자식들(형제)은 같은 x에서 아래로 쌓이고,
 * 각 레벨은 오른쪽 컬럼으로 배치됩니다.
 */

import type { EventTreeNode, ToolNode } from "../../shared/types";
import type { LayoutContext } from "../layout-context";
import { createEdge } from "../layout-engine";
import { dispatchRenderer } from "./index";

/**
 * 트리 노드의 자식들을 처리하고 수평 엣지를 생성합니다.
 *
 * 모든 자식은 부모의 오른쪽(right→left)에 연결됩니다.
 * 타입별 구분 없이 동일한 엣지를 생성합니다.
 */
export function processChildNodes(
  parentTurnNode: EventTreeNode,
  parentGraphNodeId: string | null,
  ctx: LayoutContext,
): void {
  for (const child of parentTurnNode.children) {
    const nodeId = dispatchRenderer(child, parentGraphNodeId, ctx);
    if (nodeId && parentGraphNodeId) {
      // 진행 중인 tool은 animated 엣지로 표시
      const animated = child.type === "tool"
        && !(child as ToolNode).completed
        && !(child as ToolNode).toolResult;
      ctx.edges.push(
        createEdge(parentGraphNodeId, nodeId, animated, "right", "left"),
      );
    }
  }
}

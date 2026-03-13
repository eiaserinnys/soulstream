/**
 * Child Processor — 턴 노드의 자식들을 순회하여 렌더러에 위임
 *
 * user_message, intervention 턴 노드의 자식 처리를 담당합니다.
 * 부모의 그래프 노드 ID를 받아 모든 자식에게 동일하게 전달합니다.
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import { dispatchRenderer } from "./index";

/**
 * 턴 노드(user_message, intervention)의 자식들을 처리합니다.
 *
 * 부모의 그래프 노드 ID를 받아 모든 자식에게 동일하게 전달합니다.
 */
export function processChildNodes(
  parentTurnNode: EventTreeNode,
  parentGraphNodeId: string | null,
  ctx: LayoutContext,
): void {
  for (const child of parentTurnNode.children) {
    dispatchRenderer(child, parentGraphNodeId, ctx);
  }
}

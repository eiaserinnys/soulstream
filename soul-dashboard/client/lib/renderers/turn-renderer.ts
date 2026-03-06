/**
 * Turn Renderer — user_message, intervention 턴 노드를 렌더링
 *
 * 세션 루트의 직접 자식인 "턴" 노드를 처리합니다.
 * 메인 플로우(수직 체인)에 배치되며, 자식 노드 처리를 위임합니다.
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createUserNode,
  createInterventionNodeFromTree,
  createEdge,
  getCollapseInfo,
} from "../layout-engine";
import { processChildNodes } from "./child-processor";

/** user_message 턴을 렌더링합니다. */
export function renderUserMessageTurn(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  if (treeNode.content) {
    const userNode = createUserNode(treeNode);
    ctx.nodes.push(userNode);
    if (ctx.prevMainFlowNodeId) {
      ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, userNode.id));
    }
    ctx.prevMainFlowNodeId = userNode.id;
  }

  processChildNodes(treeNode, ctx);
}

/** intervention 턴을 렌더링합니다. */
export function renderInterventionTurn(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const intvNode = createInterventionNodeFromTree(treeNode, collapseInfo);
  ctx.nodes.push(intvNode);
  if (ctx.prevMainFlowNodeId) {
    ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, intvNode.id));
  }
  ctx.prevMainFlowNodeId = intvNode.id;

  if (!ctx.collapsedNodeIds.has(treeNode.id)) {
    processChildNodes(treeNode, ctx);
  }
}

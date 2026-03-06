/**
 * System Renderer — complete, error, result 노드를 렌더링
 *
 * 메인 플로우에 배치되는 시스템 레벨 노드를 처리합니다.
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createSystemNodeFromTree,
  createResultNode,
  createEdge,
  getCollapseInfo,
} from "../layout-engine";

/** complete 또는 error 노드를 렌더링합니다. */
export function renderCompletionNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const sysNode = createSystemNodeFromTree(treeNode);
  ctx.nodes.push(sysNode);
  if (ctx.prevMainFlowNodeId) {
    ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, sysNode.id));
  }
  ctx.prevMainFlowNodeId = sysNode.id;
}

/** result 노드를 렌더링합니다. */
export function renderResultNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const resultGraphNode = createResultNode(treeNode, collapseInfo);
  ctx.nodes.push(resultGraphNode);
  if (ctx.prevMainFlowNodeId) {
    ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, resultGraphNode.id));
  }
  ctx.prevMainFlowNodeId = resultGraphNode.id;
}

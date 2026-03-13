/**
 * Text Renderer — thinking, text 노드를 렌더링
 *
 * 메인 플로우(수직 체인)에 배치되며, 자식 tool 노드를 재귀 처리합니다.
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createTextNode,
  createEdge,
  getCollapseInfo,
} from "../layout-engine";
import { dispatchRenderer } from "./index";

/** text 또는 thinking 노드를 렌더링합니다. */
export function renderTextNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const graphNode = createTextNode(treeNode, {
    isPlanMode: ctx.planMode.nodeIds.has(treeNode.id),
  }, collapseInfo);
  ctx.nodes.push(graphNode);

  if (ctx.prevMainFlowNodeId) {
    ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, graphNode.id, !treeNode.completed));
  }
  ctx.prevMainFlowNodeId = graphNode.id;

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return;
  }

  // text의 자식들을 처리 (tool, 중첩 text/thinking 등)
  for (const child of treeNode.children) {
    dispatchRenderer(child, graphNode.id, ctx);
  }
}

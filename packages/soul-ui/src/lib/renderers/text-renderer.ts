/**
 * Text Renderer — thinking, text 노드를 렌더링
 *
 * 트리 구조에 따라 배치되며, 자식 노드를 processChildNodes로 재귀 처리합니다.
 */

import type { EventTreeNode } from "../../shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createTextNode,
  getCollapseInfo,
} from "../layout-engine";
import { processChildNodes } from "./child-processor";

/** text 또는 thinking 노드를 렌더링합니다. */
export function renderTextNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const graphNode = createTextNode(treeNode, {
    isPlanMode: ctx.planMode.nodeIds.has(treeNode.id),
  }, collapseInfo);
  ctx.nodes.push(graphNode);

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return graphNode.id;
  }

  processChildNodes(treeNode, graphNode.id, ctx);
  return graphNode.id;
}

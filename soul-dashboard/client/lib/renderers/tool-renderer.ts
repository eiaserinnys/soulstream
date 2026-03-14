/**
 * Tool Renderer — tool 노드를 렌더링
 *
 * 수평 분기로 배치되며 (right→left 핸들), tool_call 노드를 생성합니다.
 * 도구 결과는 ToolCallNode 내에서 in-place 표시됩니다.
 * 자식 노드를 processChildNodes로 재귀 처리합니다.
 */

import type { EventTreeNode, ToolNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createToolCallNode,
  createEdge,
  getCollapseInfo,
} from "../layout-engine";
import { processChildNodes } from "./child-processor";

/** tool 노드를 렌더링합니다. */
export function renderToolNode(
  treeNode: EventTreeNode,
  parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const toolNode = treeNode as ToolNode;
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const callNode = createToolCallNode(toolNode, {
    isPlanMode: ctx.planMode.nodeIds.has(treeNode.id),
    isPlanModeEntry: ctx.planMode.entryIds.has(treeNode.id),
    isPlanModeExit: ctx.planMode.exitIds.has(treeNode.id),
  }, collapseInfo);
  ctx.nodes.push(callNode);

  // 수평 엣지 (부모 → tool): tool-renderer가 담당
  if (parentNodeId) {
    ctx.edges.push(
      createEdge(parentNodeId, callNode.id, !toolNode.completed && !toolNode.toolResult, "right", "left"),
    );
  }

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return callNode.id;
  }

  processChildNodes(treeNode, callNode.id, ctx);
  return callNode.id;
}

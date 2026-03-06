/**
 * Tool Renderer — tool 노드를 렌더링
 *
 * 수평 분기로 배치되며 (right→left 핸들), tool_call + tool_result 쌍을 생성합니다.
 * 자식 subagent/text/tool 노드를 재귀 처리합니다.
 */

import type { EventTreeNode, ToolNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createToolCallNode,
  createToolResultNode,
  createEdge,
  getCollapseInfo,
} from "../layout-engine";
import { dispatchRenderer } from "./index";

/** tool 노드를 렌더링합니다. */
export function renderToolNode(
  treeNode: EventTreeNode,
  parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const toolNode = treeNode as ToolNode;
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const callNode = createToolCallNode(toolNode, {
    isPlanMode: ctx.planMode.nodeIds.has(treeNode.id),
    isPlanModeEntry: ctx.planMode.entryIds.has(treeNode.id),
    isPlanModeExit: ctx.planMode.exitIds.has(treeNode.id),
  }, collapseInfo);
  ctx.nodes.push(callNode);

  if (parentNodeId) {
    ctx.edges.push(
      createEdge(parentNodeId, callNode.id, !toolNode.completed && !toolNode.toolResult, "right", "left"),
    );
  }

  const resultNode = createToolResultNode(toolNode);

  if (resultNode) {
    ctx.nodes.push(resultNode);
    ctx.edges.push(createEdge(callNode.id, resultNode.id, resultNode.data.streaming, "right", "left"));
  }

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return;
  }

  // tool의 자식 처리 (subagent, text, thinking, tool 등)
  for (const child of treeNode.children) {
    dispatchRenderer(child, callNode.id, ctx);
  }
}

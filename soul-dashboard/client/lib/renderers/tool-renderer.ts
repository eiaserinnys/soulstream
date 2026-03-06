/**
 * Tool Renderer — tool 노드를 렌더링
 *
 * 수평 분기로 배치되며 (right→left 핸들), tool_call 노드를 생성합니다.
 * 도구 결과는 ToolCallNode 내에서 in-place 표시됩니다.
 * 자식 text/tool 노드를 재귀 처리합니다.
 */

import type { EventTreeNode, ToolNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createToolCallNode,
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

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return;
  }

  // tool의 자식 처리 (text, thinking, tool 등)
  for (const child of treeNode.children) {
    dispatchRenderer(child, callNode.id, ctx);
  }
}

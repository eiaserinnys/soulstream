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
  getCollapseInfo,
} from "../layout-engine";
import { processChildNodes } from "./child-processor";

/** tool 노드를 렌더링합니다. */
export function renderToolNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
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

  // 엣지 생성은 child-processor가 담당 (모든 자식 동일하게 수평 엣지)

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return callNode.id;
  }

  processChildNodes(treeNode, callNode.id, ctx);
  return callNode.id;
}

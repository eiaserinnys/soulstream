/**
 * Turn Renderer — user_message, intervention 턴 노드를 렌더링
 *
 * 세션 루트의 직접 자식인 "턴" 노드를 처리합니다.
 * 트리 구조에 따라 배치되며, 자식 노드 처리를 위임합니다.
 * 엣지 생성은 processChildNodes가 담당합니다.
 */

import type { EventTreeNode, UserMessageNode, InterventionNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createUserNode,
  createInterventionNodeFromTree,
  getCollapseInfo,
} from "../layout-engine";
import { processChildNodes } from "./child-processor";

/** user_message 턴을 렌더링합니다. */
export function renderUserMessageTurn(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  let userNodeId: string | null = null;
  if (treeNode.content) {
    const userNode = createUserNode(treeNode as UserMessageNode);
    ctx.nodes.push(userNode);
    userNodeId = userNode.id;
  }

  processChildNodes(treeNode, userNodeId, ctx);
  return userNodeId;
}

/** intervention 턴을 렌더링합니다. */
export function renderInterventionTurn(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const intvNode = createInterventionNodeFromTree(treeNode as InterventionNode, collapseInfo);
  ctx.nodes.push(intvNode);

  if (!ctx.collapsedNodeIds.has(treeNode.id)) {
    processChildNodes(treeNode, intvNode.id, ctx);
  }
  return intvNode.id;
}

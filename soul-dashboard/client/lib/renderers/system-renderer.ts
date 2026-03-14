/**
 * System Renderer — complete, error, result, compact 노드를 렌더링
 *
 * 트리 구조에 따라 배치되는 시스템 레벨 노드를 처리합니다.
 * 엣지 생성은 processChildNodes가 담당합니다.
 */

import type { EventTreeNode, CompleteNode, ErrorNode, CompactNode, ResultNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createSystemNodeFromTree,
  createCompactNode,
  createResultNode,
  getCollapseInfo,
} from "../layout-engine";

/** complete 또는 error 노드를 렌더링합니다. */
export function renderCompletionNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const sysNode = createSystemNodeFromTree(treeNode as CompleteNode | ErrorNode);
  ctx.nodes.push(sysNode);
  return sysNode.id;
}

/** compact 노드를 렌더링합니다 (시스템 메시지 스타일). */
export function renderCompactNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const compactGraphNode = createCompactNode(treeNode as CompactNode);
  ctx.nodes.push(compactGraphNode);
  return compactGraphNode.id;
}

/** result 노드를 렌더링합니다. */
export function renderResultNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const resultGraphNode = createResultNode(treeNode as ResultNode, collapseInfo);
  ctx.nodes.push(resultGraphNode);
  return resultGraphNode.id;
}

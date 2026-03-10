/**
 * Input Request Renderer — input_request 노드를 메인 플로우에 배치
 *
 * AskUserQuestion 이벤트를 핑크색 노드로 렌더링합니다.
 * Phase 1: 자식 노드 처리 없음 (정적 표시 전용).
 * Phase 2에서 응답 UI 추가 시 processChildNodes 호출이 필요할 수 있음.
 */

import type { EventTreeNode, InputRequestNodeDef } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import { createInputRequestNodeFromTree, createEdge, getCollapseInfo } from "../layout-engine";

export function renderInputRequestNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const graphNode = createInputRequestNodeFromTree(
    treeNode as InputRequestNodeDef,
    collapseInfo,
  );
  ctx.nodes.push(graphNode);
  if (ctx.prevMainFlowNodeId) {
    ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, graphNode.id));
  }
  ctx.prevMainFlowNodeId = graphNode.id;
}

/**
 * Input Request Renderer — input_request 노드를 트리 구조에 따라 배치
 *
 * AskUserQuestion 이벤트를 핑크색 노드로 렌더링합니다.
 * 엣지 생성은 processChildNodes가 담당합니다.
 */

import type { EventTreeNode, InputRequestNodeDef } from "../../shared/types";
import type { LayoutContext } from "../layout-context";
import { createInputRequestNodeFromTree, getCollapseInfo } from "../layout-engine";

export function renderInputRequestNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const graphNode = createInputRequestNodeFromTree(
    treeNode as InputRequestNodeDef,
    collapseInfo,
  );
  ctx.nodes.push(graphNode);
  return graphNode.id;
}

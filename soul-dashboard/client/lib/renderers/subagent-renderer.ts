/**
 * Subagent Renderer — subagent 노드를 렌더링
 *
 * 수평 분기로 배치되며, 자식 text/tool 노드를 재귀 처리합니다.
 * Phase 5에서 dead code로 삭제 예정 — subagent 타입 노드는
 * 현재 트리에 배치되지 않으나 방어적 렌더링을 유지합니다.
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createSubagentNode,
  createTextNode,
  createEdge,
  getCollapseInfo,
} from "../layout-engine";
import { dispatchRenderer } from "./index";

/** subagent 노드를 렌더링합니다. */
export function renderSubagentNode(
  treeNode: EventTreeNode,
  parentNodeId: string | null,
  ctx: LayoutContext,
): void {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const subagentGraphNode = createSubagentNode(treeNode, collapseInfo);
  ctx.nodes.push(subagentGraphNode);

  if (parentNodeId) {
    ctx.edges.push(
      createEdge(parentNodeId, subagentGraphNode.id, !treeNode.completed, "right", "left"),
    );
  }

  if (ctx.collapsedNodeIds.has(treeNode.id)) {
    return;
  }

  // subagent의 text/thinking 자식은 renderTextNode에 위임하지 않고 직접 처리합니다.
  // 이유: renderTextNode는 prevMainFlowNodeId/lastThinkingNodeId를 갱신하고
  // 수직 엣지(메인 플로우)를 생성하지만, subagent 내부의 text 자식은
  // subagent와 수직 엣지(핸들 없음)로 연결되어야 하며 메인 플로우에 영향을 주지 않습니다.
  for (const child of treeNode.children) {
    if (child.type === "text" || child.type === "thinking") {
      const childCollapseInfo = getCollapseInfo(child, ctx.collapsedNodeIds);
      const childGraphNode = createTextNode(child, {
        isPlanMode: ctx.planMode.nodeIds.has(child.id),
      }, childCollapseInfo);
      ctx.nodes.push(childGraphNode);
      ctx.edges.push(createEdge(subagentGraphNode.id, childGraphNode.id, !child.completed));

      if (!ctx.collapsedNodeIds.has(child.id)) {
        for (const grandchild of child.children) {
          dispatchRenderer(grandchild, childGraphNode.id, ctx);
        }
      }
    } else if (child.type === "tool") {
      dispatchRenderer(child, subagentGraphNode.id, ctx);
    }
  }
}

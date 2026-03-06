/**
 * Child Processor — 턴 노드의 자식들을 순회하여 렌더러에 위임
 *
 * user_message, intervention 턴 노드의 자식 처리를 담당합니다.
 * 가상 thinking 노드 삽입 로직을 포함합니다.
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createEdge,
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
} from "../layout-engine";
import type { GraphNode } from "../layout-engine";
import { dispatchRenderer } from "./index";

/**
 * 첫 text/thinking 이전에 tool이 있는지 판정합니다.
 * tool이 먼저 나타나면 가상 thinking 노드를 삽입해야 합니다.
 */
function needsVirtualThinking(children: EventTreeNode[]): boolean {
  for (const child of children) {
    if (child.type === "text" || child.type === "thinking") return false;
    if (child.type === "tool") return true;
  }
  return false;
}

/**
 * 턴 노드(user_message, intervention)의 자식들을 처리합니다.
 *
 * 첫 text 이전에 tool이 있으면 가상 thinking 노드를 삽입하여
 * tool 분기의 부모 역할을 하게 합니다.
 */
export function processChildNodes(
  parentTurnNode: EventTreeNode,
  ctx: LayoutContext,
): void {
  // 가상 thinking 노드 삽입: 첫 text/thinking 이전에 tool이 있는 경우
  if (needsVirtualThinking(parentTurnNode.children)) {
    const virtualNode: GraphNode = {
      id: `node-virtual-init-${parentTurnNode.id}`,
      type: "thinking",
      position: { x: 0, y: 0 },
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
      data: {
        nodeType: "thinking",
        label: "Initial Tools",
        content: "(tools invoked before first thinking)",
        streaming: false,
      },
    };
    ctx.nodes.push(virtualNode);
    if (ctx.prevMainFlowNodeId) {
      ctx.edges.push(createEdge(ctx.prevMainFlowNodeId, virtualNode.id));
    }
    ctx.prevMainFlowNodeId = virtualNode.id;
    ctx.lastThinkingNodeId = virtualNode.id;
  }

  for (const child of parentTurnNode.children) {
    if (child.type === "text" || child.type === "thinking") {
      dispatchRenderer(child, null, ctx);
    } else if (child.type === "tool") {
      dispatchRenderer(child, ctx.lastThinkingNodeId ?? ctx.prevMainFlowNodeId, ctx);
    } else if (child.type === "complete" || child.type === "error") {
      // complete/error도 dispatchRenderer로 위임 (renderCompletionNode과 동일)
      dispatchRenderer(child, null, ctx);
    }
  }
}

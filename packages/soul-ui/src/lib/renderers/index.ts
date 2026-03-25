/**
 * Renderer Registry — 노드 타입별 렌더러를 등록하고 디스패치
 *
 * EventTreeNodeType → NodeRenderer 매핑을 관리합니다.
 * buildGraph()와 각 렌더러 내부에서 자식 노드를 재귀 처리할 때
 * dispatchRenderer()를 호출하여 타입별 if-else 분기를 제거합니다.
 */

import type { EventTreeNode, EventTreeNodeType } from "../../shared/types";
import type { LayoutContext } from "../layout-context";
import type { NodeRenderer } from "./types";
import { renderUserMessageTurn, renderInterventionTurn } from "./turn-renderer";
import { renderTextNode } from "./text-renderer";
import { renderToolNode } from "./tool-renderer";
import { renderCompletionNode, renderResultNode, renderCompactNode } from "./system-renderer";
import { renderInputRequestNode } from "./input-request-renderer";
import { renderAssistantMessageNode } from "./assistant-message-renderer";

/** 노드 타입별 렌더러 registry */
const renderers = new Map<EventTreeNodeType, NodeRenderer>([
  ["user_message", renderUserMessageTurn],
  ["intervention", renderInterventionTurn],
  ["thinking", renderTextNode],
  ["text", renderTextNode],
  ["tool", renderToolNode],
  ["compact", renderCompactNode],
  ["complete", renderCompletionNode],
  ["error", renderCompletionNode],
  ["result", renderResultNode],
  ["input_request", renderInputRequestNode],
  ["assistant_message", renderAssistantMessageNode],
]);

/**
 * 트리 노드의 타입에 맞는 렌더러를 찾아 실행합니다.
 *
 * registry에 등록되지 않은 타입은 조용히 무시합니다 (session 등).
 */
export function dispatchRenderer(
  treeNode: EventTreeNode,
  parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const renderer = renderers.get(treeNode.type);
  return renderer ? renderer(treeNode, parentNodeId, ctx) : null;
}

/** 등록된 모든 렌더러 타입을 반환합니다 (테스트용). */
export function getRegisteredTypes(): EventTreeNodeType[] {
  return [...renderers.keys()];
}

export type { NodeRenderer } from "./types";
export { renderUserMessageTurn, renderInterventionTurn } from "./turn-renderer";
export { renderTextNode } from "./text-renderer";
export { renderToolNode } from "./tool-renderer";
export { renderCompletionNode, renderResultNode, renderCompactNode } from "./system-renderer";
export { renderInputRequestNode } from "./input-request-renderer";
export { renderAssistantMessageNode } from "./assistant-message-renderer";
export { processChildNodes } from "./child-processor";

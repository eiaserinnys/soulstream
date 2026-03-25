/**
 * Assistant Message Renderer — LLM 프록시 응답 노드를 렌더링
 *
 * 트리 구조에 따라 배치됩니다.
 * 모델/프로바이더/usage 메타데이터를 label에 포함합니다.
 * 엣지 생성은 processChildNodes가 담당합니다.
 *
 * 리프 노드 전용: LLM 프록시 세션에서 assistant_message는 자식을 갖지 않으므로
 * children 재귀 처리를 하지 않습니다.
 */

import type { EventTreeNode, AssistantMessageNode } from "../../shared/types";
import type { LayoutContext } from "../layout-context";
import {
  createTextNode,
  getCollapseInfo,
} from "../layout-engine";

/** assistant_message 노드를 텍스트 노드로 렌더링합니다. */
export function renderAssistantMessageNode(
  treeNode: EventTreeNode,
  _parentNodeId: string | null,
  ctx: LayoutContext,
): string | null {
  const collapseInfo = getCollapseInfo(treeNode, ctx.collapsedNodeIds);
  const node = treeNode as AssistantMessageNode;

  const graphNode = createTextNode(node, {}, collapseInfo);

  // 라벨을 LLM 응답으로 오버라이드 (모델/usage 메타 포함)
  const meta: string[] = [];
  if (node.model) meta.push(node.model);
  if (node.usage) meta.push(`${node.usage.input_tokens}+${node.usage.output_tokens}t`);
  graphNode.data.label = meta.length > 0 ? `LLM Response (${meta.join(", ")})` : "LLM Response";
  graphNode.data.usage = node.usage;

  ctx.nodes.push(graphNode);
  return graphNode.id;
}

/**
 * Graph Dump - 현재 그래프 상태를 JSON으로 덤프
 *
 * 디버깅용. 대시보드가 알고 있는 모든 노드 정보와 위치를 캡처합니다.
 *
 * 트리거: Ctrl+Shift+D (NodeGraph 컴포넌트에서 등록)
 *
 * 덤프 내용:
 * - 이벤트 트리 (EventTreeNode 계층)
 * - 그래프 노드 (React Flow 좌표 + 데이터)
 * - 그래프 에지
 * - 처리 컨텍스트 (nodeMap 키, currentTurnNodeId 등)
 */

import type { EventTreeNode } from "@shared/types";
import type { ProcessingContext } from "../stores/processing-context";
import type { GraphNode, GraphEdge } from "./layout-engine";

/** 트리 노드를 재귀적으로 직렬화 (children의 순환 참조 방지) */
function serializeTreeNode(node: EventTreeNode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    content: node.content?.slice(0, 200),
    completed: node.completed,
    parentEventId: node.parentEventId,
    childCount: node.children.length,
  };

  // 타입별 추가 필드
  switch (node.type) {
    case "thinking":
      break;
    case "text":
      base.textCompleted = node.textCompleted;
      break;
    case "tool":
    case "tool_use":
      base.toolName = node.toolName;
      base.toolUseId = node.toolUseId;
      base.isError = node.isError;
      base.durationMs = node.durationMs;
      base.toolResult = node.toolResult?.slice(0, 100);
      break;
    case "user_message":
      base.user = node.user;
      break;
    case "intervention":
      base.user = node.user;
      break;
    case "result":
      base.durationMs = node.durationMs;
      base.usage = node.usage;
      base.totalCostUsd = node.totalCostUsd;
      break;
    case "session":
      base.sessionId = node.sessionId;
      break;
  }

  // 자식 재귀 직렬화
  base.children = node.children.map(serializeTreeNode);

  return base;
}

/** 그래프 노드를 직렬화 */
function serializeGraphNode(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    width: node.width,
    height: node.height,
    data: {
      nodeType: node.data.nodeType,
      label: node.data.label,
      content: (node.data.content as string)?.slice(0, 200),
      cardId: node.data.cardId,
      isStreaming: node.data.isStreaming,
      isError: node.data.isError,
      durationMs: node.data.durationMs,
    },
  };
}

/** 처리 컨텍스트 직렬화 */
function serializeContext(ctx: ProcessingContext): Record<string, unknown> {
  const nodeMapEntries: Record<string, string> = {};
  ctx.nodeMap.forEach((node, key) => {
    nodeMapEntries[key] = `${node.type}:${node.id}`;
  });

  return {
    currentTurnNodeId: ctx.currentTurnNodeId,
    nodeMapSize: ctx.nodeMap.size,
    nodeMapKeys: Object.keys(nodeMapEntries),
    nodeMap: nodeMapEntries,
    activeTextTarget: ctx.activeTextTarget
      ? { id: ctx.activeTextTarget.id, type: ctx.activeTextTarget.type }
      : null,
  };
}

export interface GraphDump {
  timestamp: string;
  sessionKey: string | null;
  treeVersion: number;
  lastEventId: number;
  tree: Record<string, unknown> | null;
  graphNodes: Record<string, unknown>[];
  graphEdges: { id: string; source: string; target: string }[];
  processingCtx: Record<string, unknown>;
}

/** 현재 그래프 상태를 덤프 객체로 생성 */
export function createGraphDump(
  sessionKey: string | null,
  treeVersion: number,
  lastEventId: number,
  tree: EventTreeNode | null,
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  processingCtx: ProcessingContext,
): GraphDump {
  return {
    timestamp: new Date().toISOString(),
    sessionKey,
    treeVersion,
    lastEventId,
    tree: tree ? serializeTreeNode(tree) : null,
    graphNodes: graphNodes.map(serializeGraphNode),
    graphEdges: graphEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    })),
    processingCtx: serializeContext(processingCtx),
  };
}

/** 덤프를 JSON 파일로 다운로드 */
export function downloadDump(dump: GraphDump): void {
  const json = JSON.stringify(dump, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const sessionPart = dump.sessionKey
    ? dump.sessionKey.slice(0, 20)
    : "no-session";
  const timePart = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const filename = `graph-dump_${sessionPart}_${timePart}.json`;

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(
    `[GraphDump] Downloaded: ${filename} (${dump.graphNodes.length} nodes, ${dump.graphEdges.length} edges)`,
  );
}

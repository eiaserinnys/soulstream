/**
 * Soul Dashboard - Layout Engine (Facade)
 *
 * EventTreeNode 트리를 React Flow 노드/엣지로 변환하는 레이아웃 엔진의 facade.
 *
 * 노드 생성 책임은 ./node-builders.ts, 위치 배정 알고리즘은 ./tree-layout.ts로 분리되어 있다.
 * 이 파일은 다음을 담당한다:
 * - 공유 타입/상수 정본 (GraphNode, GraphEdge, GraphNodeData, DEFAULT_NODE_WIDTH/HEIGHT)
 * - 그래프 구성 진입점 (buildGraph, buildSingleNode)
 * - 플랜 모드 감지 (detectPlanModeRanges)
 * - 엣지 생성 (createEdge)
 * - 기존 consumer 호환을 위한 노드 빌더/레이아웃 re-export
 */

import type { Node, Edge } from "@xyflow/react";
import type {
  EventTreeNode,
  ToolNode,
  SessionNode,
  InputRequestQuestion,
} from "../shared/types";
import { createLayoutContext } from "./layout-context";
import { processChildNodes, dispatchRenderer } from "./renderers";
import { createSystemNodeFromTree } from "./node-builders";
import { applyDagreLayout, TREE_H_GAP, V_GAP } from "./tree-layout";

// === Graph Node Types ===

/** 노드 그래프에 표시되는 커스텀 노드 타입 */
export type GraphNodeType =
  | "session"       // 가상 루트 (숨김)
  | "user"          // UserMessage
  | "intervention"  // Intervention
  | "thinking"      // ThinkingBlock
  | "text"          // TextBlock (하위 호환)
  | "tool_use"      // ToolUseBlock
  | "tool_call"     // 하위 호환 alias
  | "result"        // ResultMessage
  | "response"      // 하위 호환
  | "system"        // 시스템 메시지
  | "error"         // 에러
  | "input_request"; // AskUserQuestion

/** React Flow 노드의 data 필드 */
export interface GraphNodeData extends Record<string, unknown> {
  nodeType: GraphNodeType;
  cardId?: string;
  label: string;
  content: string;
  streaming: boolean;

  // 접기/펼치기 (모든 노드에 적용)
  collapsed?: boolean;        // 현재 접힌 상태
  hasChildren?: boolean;      // 자식 노드 존재 여부
  childCount?: number;        // 자식 노드 수 (전체 자손)

  // result 전용
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
  stopReason?: string;
  errors?: string[];
  modelUsage?: Record<string, unknown>;
  permissionDenials?: string[];

  // 기존 필드들
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  /** 플랜 모드 관련 플래그 */
  isPlanMode?: boolean;
  isPlanModeEntry?: boolean;
  isPlanModeExit?: boolean;
  /** 전체 텍스트 (user/intervention 노드의 상세 뷰용) */
  fullContent?: string;
  /** 도구 분류 배지 (Skill, Agent 등) */
  toolCategory?: "skill" | "sub-agent";

  // input_request 전용
  requestId?: string;
  questions?: InputRequestQuestion[];
  responded?: boolean;
  expired?: boolean;
}

export type GraphNode = Node<GraphNodeData>;
export type GraphEdge = Edge;

// === Node Dimensions ===

/** 모든 카드의 기본 크기 (노드 생성 시 사용) */
export const DEFAULT_NODE_WIDTH = 260;
export const DEFAULT_NODE_HEIGHT = 84;

// === Edge Creation ===

/**
 * React Flow 엣지를 생성합니다.
 *
 * 결정론적 ID를 사용합니다 (source, target, handle 조합으로 유일성 보장).
 */
export function createEdge(
  source: string,
  target: string,
  animated = false,
  sourceHandle?: string,
  targetHandle?: string,
): GraphEdge {
  const handleSuffix = sourceHandle || targetHandle
    ? `-${sourceHandle ?? "d"}-${targetHandle ?? "d"}`
    : "";
  return {
    id: `e-${source}-${target}${handleSuffix}`,
    source,
    target,
    animated,
    sourceHandle,
    targetHandle,
    style: { stroke: animated ? "#3b82f6" : "#4b5563", strokeWidth: 1.5 },
  };
}

// === Plan Mode Detection ===

/**
 * EventTreeNode 트리에서 EnterPlanMode / ExitPlanMode 도구 호출을 감지하여
 * 플랜 모드 구간을 반환합니다.
 */
export function detectPlanModeRanges(tree: EventTreeNode | null): { nodeIds: Set<string>; entryIds: Set<string>; exitIds: Set<string> } {
  const nodeIds = new Set<string>();
  const entryIds = new Set<string>();
  const exitIds = new Set<string>();

  if (!tree) return { nodeIds, entryIds, exitIds };

  // 트리의 모든 tool 노드를 DFS 순서로 수집
  const allTools: ToolNode[] = [];
  function collectTools(node: EventTreeNode) {
    if (node.type === "tool") {
      allTools.push(node);
    }
    for (const child of node.children) {
      collectTools(child);
    }
  }
  collectTools(tree);

  let enterNode: ToolNode | null = null;

  for (const tool of allTools) {
    if (tool.toolName === "EnterPlanMode") {
      enterNode = tool;
      entryIds.add(tool.id);
      nodeIds.add(tool.id);
    } else if (tool.toolName === "ExitPlanMode" && enterNode) {
      exitIds.add(tool.id);
      nodeIds.add(tool.id);
      enterNode = null;
    } else if (enterNode) {
      nodeIds.add(tool.id);
    }
  }

  return { nodeIds, entryIds, exitIds };
}

// === Re-exports for consumer backward compatibility ===
//
// 노드 빌더와 레이아웃 알고리즘은 별도 모듈로 분리되었으나, 기존 import 경로(`./layout-engine`)를
// 유지하기 위해 여기서 다시 export 한다. 신규 코드는 가능하면 원본 모듈에서 직접 import 한다.
export {
  createTextNode,
  createToolCallNode,
  createUserNode,
  createInterventionNodeFromTree,
  createInputRequestNodeFromTree,
  createSystemNodeFromTree,
  createCompactNode,
  createResultNode,
  countAllDescendants,
  getCollapseInfo,
  type CollapseInfo,
} from "./node-builders";
export { applyDagreLayout } from "./tree-layout";

// === Main Build Function ===

/**
 * EventTreeNode 트리를 React Flow 노드/엣지로 변환합니다.
 *
 * DFS 순회로 트리를 탐색하며:
 * 트리 구조를 그대로 레이아웃에 반영합니다:
 * - 자식 노드는 부모 우측에 수평 배치
 * - 형제 노드는 같은 x에서 아래로 스택
 *
 * LayoutContext에 공유 상태를 캡슐화하고, 렌더러 registry를 통해
 * 노드 타입별 렌더링을 위임합니다.
 *
 * @param tree - 이벤트 트리 루트
 * @param collapsedNodeIds - 접힌 노드 ID 집합 (접힌 노드의 자식은 렌더링되지 않음)
 */
export function buildGraph(
  tree: EventTreeNode | null,
  collapsedNodeIds: Set<string> = new Set(),
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!tree) return { nodes: [], edges: [] };

  // LayoutContext 생성
  const planMode = detectPlanModeRanges(tree);
  const ctx = createLayoutContext(planMode, collapsedNodeIds);

  // session root는 항상 가상 노드로 생성
  const sessionNode = createSystemNodeFromTree(tree as SessionNode);
  ctx.nodes.push(sessionNode);

  // session root의 자식(턴 노드)들을 processChildNodes로 처리.
  // 형제 체인(u1→u2→u3)이 생성되며, sibling 엣지는 data.sibling=true로 마킹되어
  // placeSubtree에서 들여쓰기 없이 같은 x 좌표에 배치된다.
  processChildNodes(tree, sessionNode.id, ctx);

  return applyDagreLayout(ctx.nodes, ctx.edges);
}

// === Incremental Node Addition ===

/**
 * 단일 트리 노드를 GraphNode로 변환하고 위치를 계산합니다.
 * 기존 노드의 위치는 변경하지 않습니다.
 *
 * @param treeNode - 추가할 트리 노드
 * @param parentGraphNodeId - 부모 그래프 노드의 ID (예: "node-xxx" 또는 "node-xxx-call")
 * @param existingNodes - 현재 그래프의 모든 노드
 * @param existingEdges - 현재 그래프의 모든 엣지
 * @param collapsedNodeIds - 접힌 노드 ID 집합
 */
export function buildSingleNode(
  treeNode: EventTreeNode,
  parentGraphNodeId: string | null,
  existingNodes: GraphNode[],
  existingEdges: GraphEdge[],
  collapsedNodeIds: Set<string>,
): { newNode: GraphNode | null; newEdge: GraphEdge | null } {
  // 1. 렌더러로 GraphNode 생성
  const planMode = { nodeIds: new Set<string>(), entryIds: new Set<string>(), exitIds: new Set<string>() };
  const ctx = createLayoutContext(planMode, collapsedNodeIds);
  const nodeId = dispatchRenderer(treeNode, parentGraphNodeId, ctx);

  if (!nodeId || ctx.nodes.length === 0) {
    return { newNode: null, newEdge: null };
  }

  const newNode = ctx.nodes[0];

  // 2. 위치 계산
  if (parentGraphNodeId) {
    const parentNode = existingNodes.find((n) => n.id === parentGraphNodeId);
    if (parentNode) {
      const parentW = parentNode.width ?? DEFAULT_NODE_WIDTH;
      const childX = parentNode.position.x + parentW + TREE_H_GAP;

      // 같은 부모의 기존 자식 중 마지막 자식의 위치를 찾는다
      const siblingEdges = existingEdges.filter(
        (e) => e.source === parentGraphNodeId && e.sourceHandle === "right",
      );
      if (siblingEdges.length > 0) {
        // 기존 형제 중 가장 아래에 있는 노드를 찾는다
        let maxY = -Infinity;
        let maxH = DEFAULT_NODE_HEIGHT;
        for (const se of siblingEdges) {
          const siblingNode = existingNodes.find((n) => n.id === se.target);
          if (siblingNode && siblingNode.position.y > maxY) {
            maxY = siblingNode.position.y;
            maxH = siblingNode.height ?? DEFAULT_NODE_HEIGHT;
          }
        }
        newNode.position = { x: childX, y: maxY + maxH + V_GAP };
      } else {
        // 첫 번째 자식: 부모와 같은 y
        newNode.position = { x: childX, y: parentNode.position.y };
      }
    }
  }

  // 3. 에지 생성
  let newEdge: GraphEdge | null = null;
  if (parentGraphNodeId && nodeId) {
    const animated = treeNode.type === "tool"
      && !(treeNode as ToolNode).completed
      && !(treeNode as ToolNode).toolResult;
    newEdge = createEdge(parentGraphNodeId, nodeId, animated, "right", "left");
  }

  return { newNode, newEdge };
}

/**
 * Layout Context — buildGraph의 공유 상태를 명시적 객체로 캡슐화
 *
 * 기존 buildGraph() 내부의 클로저 변수(nodes, edges)를
 * LayoutContext 인터페이스로 추출하여, 모든 렌더러 함수가 파라미터로 받아 독립 테스트 가능하게 합니다.
 */

import type { EventTreeNode } from "../shared/types";
import type { GraphNode, GraphEdge, GraphNodeData } from "./layout-engine";

/** 플랜 모드 감지 결과 */
export interface PlanModeInfo {
  nodeIds: Set<string>;
  entryIds: Set<string>;
  exitIds: Set<string>;
}

/**
 * buildGraph()의 공유 상태를 캡슐화하는 컨텍스트.
 *
 * 모든 렌더러 함수는 이 컨텍스트를 파라미터로 받아 노드/엣지를 추가합니다.
 * 엣지 생성은 processChildNodes가 트리 구조에 따라 담당합니다.
 */
export interface LayoutContext {
  /** 생성된 그래프 노드 목록 */
  nodes: GraphNode[];
  /** 생성된 그래프 엣지 목록 */
  edges: GraphEdge[];
  /** 플랜 모드 범위 정보 */
  planMode: PlanModeInfo;
  /** 접힌 노드 ID 집합 */
  collapsedNodeIds: Set<string>;
}

/** 새 LayoutContext를 생성합니다. */
export function createLayoutContext(
  planMode: PlanModeInfo,
  collapsedNodeIds: Set<string>,
): LayoutContext {
  return {
    nodes: [],
    edges: [],
    planMode,
    collapsedNodeIds,
  };
}

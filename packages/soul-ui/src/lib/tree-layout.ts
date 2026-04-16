/**
 * Soul Dashboard - Tree Layout
 *
 * 그래프 노드/엣지에 트리 구조 레이아웃을 적용하는 알고리즘 모듈.
 * layout-engine.ts에서 분리된 모듈로, 위치 배정 책임만 담당합니다.
 * 노드 생성은 node-builders.ts에서 담당합니다.
 *
 * 알고리즘 3단계:
 * 1. depth 계산 (수평 엣지 +1, 수직 엣지 동일)
 * 2. 높이 계산 (bottom-up, memoized)
 * 3. 위치 배정 (top-down)
 */

import {
  DEFAULT_NODE_WIDTH,
  DEFAULT_NODE_HEIGHT,
  type GraphNode,
  type GraphEdge,
} from "./layout-engine";

// === Layout Constants ===

/** 자식 노드가 부모 노드 우측에 배치될 때의 수평 간격 */
export const TREE_H_GAP = 120;
export const V_GAP = 16;
/** depth 0 (메인 플로우) 수직 간격 */
export const FLOW_GAP = 60;

/**
 * 엣지 기반 재귀 레이아웃을 적용합니다.
 *
 * 트리 구조 레이아웃:
 * - 자식 노드: 부모 우측에 수평 배치 (right→left 엣지)
 * - 형제 노드: 같은 x에서 아래로 V_GAP 간격 스택
 * - effectiveHeight: 재귀적으로 모든 자손의 높이를 포함
 */
export function applyDagreLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const MARGIN = 20;

  // 노드 맵
  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) nodeMap.set(node.id, node);

  // 엣지에서 부모→자식 인접 리스트 구성
  type ChildRef = { id: string; horizontal: boolean; sibling: boolean };
  const childrenOf = new Map<string, ChildRef[]>();
  const incoming = new Set<string>();

  for (const edge of edges) {
    const h = edge.sourceHandle === "right" && edge.targetHandle === "left";
    const s = !!(edge.data as Record<string, unknown> | undefined)?.sibling;
    if (!childrenOf.has(edge.source)) childrenOf.set(edge.source, []);
    childrenOf.get(edge.source)!.push({ id: edge.target, horizontal: h, sibling: s });
    incoming.add(edge.target);
  }

  // 루트 = incoming 엣지 없는 최상위 노드
  const roots = nodes.filter((n) => !incoming.has(n.id));

  // depth 계산: 수평 엣지 +1, 수직 엣지 동일 (사이클 방어 포함)
  const depthOf = new Map<string, number>();
  function assignDepth(id: string, d: number) {
    if (depthOf.has(id)) return;
    depthOf.set(id, d);
    for (const c of childrenOf.get(id) ?? []) {
      assignDepth(c.id, c.horizontal ? d + 1 : d);
    }
  }
  for (const r of roots) assignDepth(r.id, 0);

  // 높이 계산 (bottom-up, memoized)
  const rowHeightOf = new Map<string, number>();
  const effHeightOf = new Map<string, number>();

  function computeHeights(id: string): { row: number; eff: number } {
    if (effHeightOf.has(id)) {
      return { row: rowHeightOf.get(id)!, eff: effHeightOf.get(id)! };
    }

    // 사이클 방어: 계산 진입 즉시 기본값으로 마킹
    const fallback = DEFAULT_NODE_HEIGHT;
    rowHeightOf.set(id, fallback);
    effHeightOf.set(id, fallback);

    const node = nodeMap.get(id);
    const selfH = node?.height ?? fallback;

    const ch = childrenOf.get(id) ?? [];
    const hCh = ch.filter((c) => c.horizontal);
    const vCh = ch.filter((c) => !c.horizontal);

    // rowHeight = max(자신, 수평 자식 스택 높이)
    let hStack = 0;
    for (let i = 0; i < hCh.length; i++) {
      if (i > 0) hStack += V_GAP;
      hStack += computeHeights(hCh[i].id).eff;
    }
    const row = Math.max(selfH, hStack);

    // effectiveHeight = rowHeight + 수직 자식 전체
    const vGap = (depthOf.get(id) ?? 0) === 0 ? FLOW_GAP : V_GAP;
    let eff = row;
    for (const vc of vCh) {
      eff += vGap + computeHeights(vc.id).eff;
    }

    rowHeightOf.set(id, row);
    effHeightOf.set(id, eff);
    return { row, eff };
  }

  // 위치 배정 (top-down)
  const positions = new Map<string, { x: number; y: number }>();

  function placeSubtree(id: string, x: number, y: number, isRootLevel: boolean = false) {
    if (positions.has(id)) return; // 사이클 방어
    positions.set(id, { x, y });

    const ch = childrenOf.get(id) ?? [];
    const hCh = ch.filter((c) => c.horizontal);
    const vCh = ch.filter((c) => !c.horizontal);

    // 수평 자식: 부모 width + H_GAP만큼 오른쪽으로, V_GAP 간격으로 아래로 스택
    const parentW = nodeMap.get(id)?.width ?? DEFAULT_NODE_WIDTH;
    const colStep = parentW + TREE_H_GAP;
    let hy = y;
    for (const hc of hCh) {
      placeSubtree(hc.id, x + colStep, hy, false);
      hy += computeHeights(hc.id).eff + V_GAP;
    }

    // 수직 자식: sibling 엣지는 같은 x (형제 체인), 그 외는 들여쓰기
    const row = rowHeightOf.get(id) ?? DEFAULT_NODE_HEIGHT;
    const vGap = (depthOf.get(id) ?? 0) === 0 ? FLOW_GAP : V_GAP;
    let vy = y + row + vGap;
    for (const vc of vCh) {
      // sibling 엣지: 형제이므로 같은 x 유지
      // isRootLevel: 세션 루트에서 첫째 자식도 같은 x 유지
      const childX = x;
      placeSubtree(vc.id, childX, vy, false);
      vy += computeHeights(vc.id).eff + vGap;
    }
  }

  // 루트부터 배치
  let rootY = MARGIN;
  for (const r of roots) {
    computeHeights(r.id);
    placeSubtree(r.id, MARGIN, rootY, true);
    rootY += (effHeightOf.get(r.id) ?? 84) + FLOW_GAP;
  }

  // 위치 반영
  const positioned = nodes.map((node) => {
    const p = positions.get(node.id);
    return p ? { ...node, position: p } : node;
  });

  return { nodes: positioned, edges };
}

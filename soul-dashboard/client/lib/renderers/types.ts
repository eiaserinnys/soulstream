/**
 * Renderer Types — 렌더러 공통 타입 정의
 */

import type { EventTreeNode } from "@shared/types";
import type { LayoutContext } from "../layout-context";

/**
 * 노드 타입별 렌더러 함수 시그니처.
 *
 * EventTreeNode를 받아 LayoutContext에 GraphNode/GraphEdge를 추가합니다.
 * parentNodeId는 수평 엣지(tool 분기)의 부모를 가리킵니다.
 */
export type NodeRenderer = (
  treeNode: EventTreeNode,
  parentNodeId: string | null,
  ctx: LayoutContext,
) => string | null;

/**
 * EventTreeNode 유틸리티 함수
 *
 * 트리 순회, 카운트, 검색 등 외부에서 트리 조회에 사용하는 함수.
 */

import type { EventTreeNode } from "@shared/types";

/** 트리의 전체 노드 수를 카운트합니다. */
export function countTreeNodes(node: EventTreeNode | null): number {
  if (!node) return 0;
  let count = 1;
  for (const child of node.children) {
    count += countTreeNodes(child);
  }
  return count;
}

/** 트리에서 미완료 노드 수를 카운트합니다. */
export function countStreamingNodes(node: EventTreeNode | null): number {
  if (!node) return 0;
  let count = node.completed ? 0 : 1;
  for (const child of node.children) {
    count += countStreamingNodes(child);
  }
  return count;
}

/** 트리에서 ID로 노드를 찾습니다. */
export function findTreeNode(
  root: EventTreeNode | null,
  id: string,
): EventTreeNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * node-guard.ts - 다른 노드 세션 판별 로직
 *
 * DashboardLayout에서 활성 세션이 다른 노드 소속인지 판단한다.
 * 순수 함수로 분리하여 독립적으로 테스트 가능하다.
 */

/**
 * 활성 세션이 다른 soul-server 노드에 속한 세션인지 판별한다.
 *
 * @param currentNodeId - 현재 접속한 soul-server의 node_id (fetch 실패 시 undefined)
 * @param sessionNodeId - 활성 세션의 node_id (없으면 null | undefined)
 * @returns true면 다른 노드 세션 → ChatInput 비활성화
 *
 * 판단 유보 조건:
 * - currentNodeId가 undefined: /api/node-info 미로드 또는 오류 → false (허용)
 * - sessionNodeId가 null/undefined: node_id 미기록 세션 → false (하위 호환)
 */
export function computeIsOtherNode(
  currentNodeId: string | undefined,
  sessionNodeId: string | null | undefined,
): boolean {
  return (
    currentNodeId !== undefined &&
    sessionNodeId != null &&
    sessionNodeId !== currentNodeId
  );
}

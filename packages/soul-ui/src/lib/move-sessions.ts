/**
 * 세션 이동 낙관적 업데이트 팩토리
 *
 * API 경로를 config 객체로 주입받아, soul-dashboard와 orchestrator-dashboard
 * 모두에서 사용할 수 있는 세션 이동 함수를 생성합니다.
 *
 * 패턴:
 *   1. 로컬 catalog 상태를 즉시 갱신 (낙관적)
 *   2. API 호출
 *   3. API 실패 시 원래 상태로 롤백
 */

import { useDashboardStore } from "../stores/dashboard-store";

export interface MoveSessionsApiConfig {
  /** 단일 세션 이동 URL. undefined이면 항상 batch 사용 */
  singleUrl?: (id: string) => string;
  singleMethod?: "PUT" | "PATCH";
  /** 배치 이동 URL. 필수 */
  batchUrl: string;
  batchMethod?: "PUT" | "PATCH";
}

export interface MoveSessionsOperations {
  moveSessionsOptimistic: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
}

export function createMoveSessionsOperations(config: MoveSessionsApiConfig): MoveSessionsOperations {
  const singleMethod = config.singleMethod ?? "PUT";
  const batchMethod = config.batchMethod ?? "PUT";

  async function moveSessionsOptimistic(
    sessionIds: string[],
    targetFolderId: string | null,
  ): Promise<void> {
    if (sessionIds.length === 0) return;

    const { moveSessionsToFolder, catalog } = useDashboardStore.getState();

    // 롤백용 스냅샷
    const prevAssignments: Record<string, string | null> = {};
    for (const id of sessionIds) {
      prevAssignments[id] = catalog?.sessions[id]?.folderId ?? null;
    }

    // 낙관적 업데이트
    moveSessionsToFolder(sessionIds, targetFolderId);

    try {
      if (sessionIds.length === 1 && config.singleUrl) {
        const res = await fetch(config.singleUrl(sessionIds[0]), {
          method: singleMethod,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId: targetFolderId }),
        });
        if (!res.ok) throw new Error(`Move failed: ${res.status}`);
      } else {
        const res = await fetch(config.batchUrl, {
          method: batchMethod,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionIds, folderId: targetFolderId }),
        });
        if (!res.ok) throw new Error(`Batch move failed: ${res.status}`);
      }
    } catch (err) {
      // 롤백: 각 세션을 원래 폴더로 되돌림
      for (const [id, prevFolderId] of Object.entries(prevAssignments)) {
        moveSessionsToFolder([id], prevFolderId);
      }
      console.error("Session move failed, rolled back:", err);
    }
  }

  return { moveSessionsOptimistic };
}

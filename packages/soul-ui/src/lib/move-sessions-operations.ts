/**
 * createMoveSessionsOperations - 세션 이동 낙관적 업데이트 팩토리
 *
 * CatalogApiConfig를 받아 세션 이동 함수를 반환한다.
 * 단일 세션 이동 경로(singleSessionMovePath)가 config에 있으면 1건일 때 사용하고,
 * 없으면 항상 batch 경로를 사용한다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import type { CatalogApiConfig } from "./catalog-api-config";

export function createMoveSessionsOperations(config: CatalogApiConfig) {
  return {
    async moveSessionsOptimistic(
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
        if (sessionIds.length === 1 && config.singleSessionMovePath) {
          // 단일 세션 전용 경로
          const res = await fetch(config.singleSessionMovePath(sessionIds[0]), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderId: targetFolderId }),
          });
          if (!res.ok) throw new Error(`Move failed: ${res.status}`);
        } else {
          // batch 경로
          const res = await fetch(config.sessionBatchMovePath, {
            method: config.sessionBatchMoveMethod,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config.sessionBatchMoveBody(sessionIds, targetFolderId)),
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
    },
  };
}

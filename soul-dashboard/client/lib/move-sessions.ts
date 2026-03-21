/**
 * 세션을 폴더로 이동하는 낙관적 업데이트 유틸리티
 *
 * 1. 로컬 catalog 상태를 즉시 갱신 (낙관적)
 * 2. API 호출
 * 3. API 실패 시 원래 상태로 롤백
 */

import { useDashboardStore } from "@seosoyoung/soul-ui";

export async function moveSessionsOptimistic(
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
    if (sessionIds.length === 1) {
      const res = await fetch(`/api/catalog/sessions/${sessionIds[0]}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: targetFolderId }),
      });
      if (!res.ok) throw new Error(`Move failed: ${res.status}`);
    } else {
      const res = await fetch("/api/catalog/sessions/batch", {
        method: "PUT",
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

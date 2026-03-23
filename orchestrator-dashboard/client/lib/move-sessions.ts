/**
 * 세션을 폴더로 이동하는 낙관적 업데이트 — soul-stream /api/sessions/folder 사용.
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
    const res = await fetch("/api/sessions/folder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds, folderId: targetFolderId }),
    });
    if (!res.ok) throw new Error(`Move sessions failed: ${res.status}`);
  } catch (err) {
    // 롤백
    for (const [id, prevFolderId] of Object.entries(prevAssignments)) {
      moveSessionsToFolder([id], prevFolderId);
    }
    console.error("Session move failed, rolled back:", err);
  }
}
